import hashlib
import json
import re
import sys
from pathlib import Path

import pytest
from conftest import DOS_EXIT, RETF, Module, build, call

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import build_callgraph as cli  # noqa: E402


def test_arguments_are_required(capsys):
    with pytest.raises(SystemExit):
        cli.parse_args([])
    with pytest.raises(SystemExit):
        cli.parse_args(["--game", "ALPHA"])
    a = cli.parse_args(["--game", "ALPHA", "--out", "generated/alpha"])
    assert (a.game, a.out) == (Path("ALPHA"), Path("generated/alpha"))


def write_inputs(tmp_path: Path):
    root = bytearray(b"\x90" * 0x20)
    root[0:7] = call(0, 0x10) + DOS_EXIT
    root[0x10] = 0xC3
    b = build(bytes(root), [Module(b"\x55\xcb", [0, 1])])
    game = tmp_path / "GAME"
    game.mkdir()
    (game / "MAIN.EXE").write_bytes(b.exe)
    (game / "MAIN.OVR").write_bytes(b.ovr)
    (game / "FX.COM").write_bytes(b"\xb8\x00\x4c\xcd\x21")  # mov ax, 4C00h; int 21h
    (game / "TITLE.PAK").write_bytes(b"\xff" * 8)  # data: not a program
    return b, game


def test_main_writes_tree(tmp_path, capsys):
    b, game = write_inputs(tmp_path)
    out = tmp_path / "out"
    stale = out / "units" / "start" / "functions" / "START-root_9999.asm"  # an old-style listing: removed
    stale.parent.mkdir(parents=True)
    stale.write_text("old")
    assert cli.main(["--game", str(game), "--out", str(out)]) == 0
    g = json.loads((out / "navigation" / "callgraph.json").read_text())
    assert set(g) == {"scope", "provenance", "frames", "programs", "counts", "nodes", "edges", "aliases"}
    assert g["programs"] == {"FX.COM": ["FX.COM"], "MAIN.EXE": ["MAIN.EXE", "MAIN.OVR"]}
    assert set(g["provenance"]) == {"generator", "generated_at", "files"}
    assert g["provenance"]["files"] == {"MAIN.OVR": hashlib.sha256(b.ovr).hexdigest(), "FX.COM": hashlib.sha256(b"\xb8\x00\x4c\xcd\x21").hexdigest(),
                                        "MAIN.EXE": hashlib.sha256(b.exe).hexdigest()}
    assert [f["file"] for f in g["frames"]] == ["FX.COM", "MAIN.EXE", "MAIN.EXE", "MAIN.OVR"]
    mid = b.module_id(0)
    assert sorted(g["nodes"]) == ["FX_COM:0100", "MAIN_EXE:0000", "MAIN_EXE:0010", f"{mid}:0000", f"{mid}:0001"]
    node = g["nodes"][f"{mid}:0001"]
    assert node == {"id": f"{mid}:0001", "kind": "function", "space": mid, "address": 1, "file_offset": 5,
                    "source_file": "MAIN.OVR", "listing": f"units/main_ovr/functions/{mid}_0001.asm", "entrypoint": True,
                    "provisional": False, "evidence": []}
    assert g["nodes"]["MAIN_EXE:0010"]["entrypoint"] is False
    assert g["nodes"]["MAIN_EXE:0000"]["file_offset"] == b.header_size
    assert g["nodes"]["FX_COM:0100"]["file_offset"] == 0 and g["nodes"]["FX_COM:0100"]["entrypoint"] is True
    for key in ("nodes", "edges", "functions", "unknown_targets", "overlay_entries", "conditional_edges"):
        assert key in g["counts"]
    assert g["counts"]["overlay_entries"] == 2 and g["counts"]["functions"] == 5
    assert (out / "units/main_ovr/functions" / f"{mid}_0000.asm").read_text().startswith(f"; {mid}:0000\n0000  55")
    assert (out / "units/fx_com/functions/FX_COM_0100.asm").read_text().startswith("; FX_COM:0100\n0100  b8004c")
    assert not stale.exists()
    readme = (out / "navigation" / "README.md").read_text()
    assert readme.startswith("# Generated call graph") and "| FX.COM | COM |" in readme
    assert "| MAIN.OVR | Turbo Pascal overlays of MAIN.EXE (1) |" in readme
    diag = json.loads((out / "navigation" / "analysis.json").read_text())
    assert diag["MAIN.EXE"]["noreturn_functions"] == ["MAIN_EXE:0000"] and set(diag) == {"MAIN.EXE", "FX.COM"}
    assert "wrote" in capsys.readouterr().out


def test_summary_names_every_file_and_counts_the_links(tmp_path, capsys):
    _b, game = write_inputs(tmp_path)
    (game / "MAIN.BAT").write_bytes(b"fx\r\nmain\r\ngo\r\n")
    out = tmp_path / "out"
    assert cli.main(["--game", str(game), "--out", str(out)]) == 0
    c = json.loads((out / "navigation" / "callgraph.json").read_text())["counts"]
    size = sum(len(p.read_bytes()) for p in out.glob("units/*/functions/*.asm"))
    assert capsys.readouterr().out == (
        f"wrote {out}/navigation/callgraph.json (FX.COM, MAIN.EXE + MAIN.OVR, MAIN.BAT): 5 functions, "
        f"{c['edges']} edges (3 runs, 0 loads, 0 interrupt), 1 unknown targets; 6 listings ({size} bytes)\n")  # go: unknown


def test_main_rejects_unsupported_input(tmp_path, capsys):
    _b, game = write_inputs(tmp_path)
    (game / "MAIN.OVR").write_bytes(b"XXOV" + (game / "MAIN.OVR").read_bytes()[4:])
    assert cli.main(["--game", str(game), "--out", str(tmp_path / "o")]) == 2
    assert "unsupported input" in capsys.readouterr().err and not (tmp_path / "o").exists()


def test_main_rejects_a_missing_directory(tmp_path, capsys):
    assert cli.main(["--game", str(tmp_path / "nope"), "--out", str(tmp_path / "o")]) == 2
    assert "is not a directory" in capsys.readouterr().err


def test_modules_default_to_the_manifest_beside_the_game_directory(tmp_path, capsys):
    assert cli.parse_args(["--game", "G", "--out", "o"]).modules is None
    assert cli.parse_args(["--game", "G", "--out", "o", "--modules", "m.json"]).modules == Path("m.json")
    _b, game = write_inputs(tmp_path)
    assert cli.main(["--game", str(game), "--out", str(tmp_path / "o1")]) == 0  # no manifest there: nothing declared
    (tmp_path / "loaded_modules.json").write_text('{"GAME": [{"program": "FX.COM", "pointer": "ds:[0200]", "file": "TITLE.PAK", '
                                                  '"layout": "COM", "evidence": "e"}]}')
    capsys.readouterr()
    assert cli.main(["--game", str(game), "--out", str(tmp_path / "o2")]) == 2
    assert r"FX.COM has no far call through ds:[0200]" in capsys.readouterr().err
    # a manifest inside the game directory is not looked at
    (game / "loaded_modules.json").write_text("{")
    (tmp_path / "loaded_modules.json").unlink()
    assert cli.main(["--game", str(game), "--out", str(tmp_path / "o3")]) == 0


@pytest.mark.parametrize("text,msg", [
    ("{", "not JSON"),
    ('{"GAME": [{"program": "FX.COM", "pointer": "ds:[0200]", "file": "TITLE.PAK", "layout": "COM", "evidence": "e"}]}',
     r"FX.COM has no far call through ds:\[0200\]"),
    ('{"GAME": 1}', "GAME must be a list"),
])
def test_main_rejects_declarations_the_game_contradicts(tmp_path, capsys, text, msg):
    _b, game = write_inputs(tmp_path)
    modules = tmp_path / "m.json"
    modules.write_text(text)
    assert cli.main(["--game", str(game), "--out", str(tmp_path / "o"), "--modules", str(modules)]) == 2
    err = capsys.readouterr().err
    assert "unsupported input" in err and re.search(msg, err) and not (tmp_path / "o").exists()


def test_main_ignores_other_games_declarations(tmp_path):
    _b, game = write_inputs(tmp_path)
    modules = tmp_path / "m.json"
    modules.write_text('{"OTHER": [{"program": "X.EXE", "pointer": "ds:[0]", "file": "X", "layout": "COM", "evidence": "e"}]}')
    assert cli.main(["--game", str(game), "--out", str(tmp_path / "o"), "--modules", str(modules)]) == 0


def test_diagnostics_hazards_are_deduplicated(tmp_path):
    from dosgraph.binary import Program
    from dosgraph.emit import diagnostics
    from dosgraph.flow import analyze
    from dosgraph.x86 import Decoder

    root = bytearray(b"\x90" * 0x30)
    root[0:10] = call(0, 0x10) + call(3, 0x20) + DOS_EXIT
    root[0x10:0x13] = b"\xff\xe0\xc3"  # jmp ax
    root[0x20:0x23] = b"\xeb\xee\xc3"  # jmp 0x10 (tail into the same indirect jump)
    b = build(bytes(root), [Module(RETF, [0])])
    prog = Program(b.exe, b.ovr)
    an = analyze(prog, Decoder(prog), stop_on_fallthrough=False)
    an.descents["MAIN_EXE:0020"].hazards.extend(an.descents["MAIN_EXE:0010"].hazards)
    d = diagnostics(prog, an)
    assert d["hazard_counts"] == {"indirect-jmp": 1} and d["hazards"][0]["addr"] == "0010"
