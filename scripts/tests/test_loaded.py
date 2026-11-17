import json
import struct
from pathlib import Path

import pytest

from dosgraph import game, loaded
from dosgraph.errors import FormatError

# mov ax, cs; mov ds, ax; lcall [0200h]; lcall [0300h]; mov ah, 4Ch; int 21h
MAIN = bytes.fromhex("8cc88ed8ff1e0002ff1e0003b44ccd21")
READER = str(Path(__file__).with_name("pak_reader.py"))  # absolute, so the manifest directory does not matter


def pak(*records: tuple[int, bytes]) -> bytes:
    """A container the test reader understands: per record u8 id, u8 size, the bytes."""
    return b"".join(struct.pack("BB", rid, len(data)) + data for rid, data in records)


def entry(**kw) -> dict:
    e = {"program": "MAIN.COM", "pointer": "ds:[0200]", "file": "FX.PAK", "records": [1], "layout": "COM", "evidence": "seen at 0104",
         "reader": READER}
    e.update(kw)
    if "reader" not in kw and (e["records"] is None or e["records"] is ...):
        del e["reader"]  # a whole file needs none
    return {k: v for k, v in e.items() if v is not ...}


def one(**kw) -> loaded.LoadedModule:
    return loaded.parse({"G": [entry(**kw)]}, "g")[0]


@pytest.fixture
def gdir(tmp_path) -> Path:
    d = tmp_path / "G"
    d.mkdir()
    (d / "MAIN.COM").write_bytes(MAIN)
    (d / "fx.pak").write_bytes(pak((1, b"\xcb"), (2, b"\x90\xcb")))
    (d / "RAW.BIN").write_bytes(b"\x90\xcb")
    return d


# ------------------------------------------------------------------ parse


def test_parse_normalises_names_and_pointer():
    assert one(program=" main.com ", pointer=" DS:[59A6] ", file="fx.pak", evidence=" e ") == loaded.LoadedModule(
        "MAIN.COM", 0x59A6, "FX.PAK", (1,), "COM", "e", Path(READER))


def test_parse_whole_file_has_no_records():
    assert one(records=...).records is None


def test_parse_other_games_and_absent_game():
    raw = {"G": [entry()], "H": "not even a list"}
    assert loaded.parse(raw, "OTHER") == []
    assert len(loaded.parse(raw, "g")) == 1


@pytest.mark.parametrize("raw", [[], "x", None, 3])
def test_parse_top_level_must_be_an_object(raw):
    with pytest.raises(FormatError, match="top level must be an object"):
        loaded.parse(raw, "G")


@pytest.mark.parametrize("entries", [{}, "x", None, 1])
def test_parse_game_must_be_a_list(entries):
    with pytest.raises(FormatError, match="G must be a list"):
        loaded.parse({"G": entries}, "G")


@pytest.mark.parametrize("e", [[], "x", None, 1])
def test_parse_entry_must_be_an_object(e):
    with pytest.raises(FormatError, match=r"G\[0\]: an entry must be an object"):
        loaded.parse({"G": [e]}, "G")


@pytest.mark.parametrize("kw,msg", [
    ({"extra": 1}, r"unknown fields \['extra'\], missing fields \[\]"),
    ({"program": ...}, r"unknown fields \[\], missing fields \['program'\]"),
    ({"evidence": ..., "layout": ...}, r"missing fields \['evidence', 'layout'\]"),
])
def test_parse_fields(kw, msg):
    with pytest.raises(FormatError, match=msg):
        loaded.parse({"G": [entry(**kw)]}, "G")


@pytest.mark.parametrize("key", ["program", "pointer", "file", "layout", "evidence"])
@pytest.mark.parametrize("value", ["", "   ", None, 1, ["x"]])
def test_parse_strings_must_be_non_empty(key, value):
    with pytest.raises(FormatError, match=f"{key} must be a non-empty string"):
        one(**{key: value})


@pytest.mark.parametrize("pointer,value", [("ds:[0]", 0), ("ds:[ffff]", 0xFFFF), ("ds:[59a6]", 0x59A6)])
def test_parse_pointer_bounds(pointer, value):
    assert one(pointer=pointer).pointer == value


@pytest.mark.parametrize("pointer", ["59a6", "ds:[10000]", "es:[0]", "ds:[g]", "ds:[]", "ds:[-1]", "ds:[0x10]", "ds:59a6"])
def test_parse_bad_pointer(pointer):
    with pytest.raises(FormatError, match="is not ds:\\[XXXX\\]"):
        one(pointer=pointer)


@pytest.mark.parametrize("layout", ["module", "COM"])
def test_parse_layouts(layout):
    assert one(layout=layout).layout == layout


@pytest.mark.parametrize("layout", ["com", "MODULE", "MZ", "EXE"])
def test_parse_bad_layout(layout):
    with pytest.raises(FormatError, match="is not one of COM, module"):
        one(layout=layout)


@pytest.mark.parametrize("records", [[0], [255], [1, 2, 3], [5, 1]])
def test_parse_records(records):
    assert one(records=records).records == tuple(records)


@pytest.mark.parametrize("records", [[], [-1], [256], [1.0], [True], ["1"], [1, 1], "1", 1, {}])
def test_parse_bad_records(records):
    with pytest.raises(FormatError, match="records must be a non-empty list of distinct record ids 0-255"):
        one(records=records)


def test_parse_null_records_is_a_whole_file():
    assert one(records=None).records is None


def test_parse_same_pointer_twice():
    with pytest.raises(FormatError, match=r"G\[1\]: MAIN.COM ds:\[0200\] is declared twice"):
        loaded.parse({"G": [entry(), entry(pointer="DS:[200]", records=[2])]}, "G")
    assert len(loaded.parse({"G": [entry(), entry(program="OTHER.EXE")]}, "G")) == 2


# ------------------------------------------------------------------ load


def test_load_missing_file_declares_nothing(tmp_path):
    assert loaded.load(tmp_path / "none.json", "G") == []


def test_load_reads_the_game(tmp_path):
    p = tmp_path / "m.json"
    p.write_text(json.dumps({"G": [entry()]}))
    assert loaded.load(p, "g") == [one()]


def test_load_rejects_bad_json(tmp_path):
    p = tmp_path / "m.json"
    p.write_text("{")
    with pytest.raises(FormatError, match="not JSON"):
        loaded.load(p, "G")


# ------------------------------------------------------------------ modules


def test_module_names():
    assert loaded.module_name("SOUND.PAK", 1) == "SOUND.PAK-0001"
    assert loaded.module_name("SOUND.PAK", 0) == "SOUND.PAK-0000"
    assert loaded.module_name("SOUND.PAK", 255) == "SOUND.PAK-00FF"
    assert loaded.module_name("DRVA.ADV", None) == "DRVA.ADV"


def test_modules_records_and_whole_files(gdir):
    entries = [one(records=[2, 1], layout="module"), one(pointer="ds:[0300]", file="raw.bin", records=None)]
    got = loaded.modules(gdir, entries, {"MAIN.COM"})
    assert got == [
        ("FX.PAK-0002", b"\x90\xcb", "module", False, "record 2 of FX.PAK, which MAIN.COM reads and calls through ds:[0200]"),
        ("FX.PAK-0001", b"\xcb", "module", False, "record 1 of FX.PAK, which MAIN.COM reads and calls through ds:[0200]"),
        ("RAW.BIN", b"\x90\xcb", "COM", True, "RAW.BIN, which MAIN.COM reads and calls through ds:[0300]"),
    ]


def test_modules_same_record_through_two_pointers_loads_once(gdir):
    got = loaded.modules(gdir, [one(), one(pointer="ds:[0300]")], {"MAIN.COM"})
    assert [g[0] for g in got] == ["FX.PAK-0001"]


def test_modules_same_record_with_two_layouts(gdir):
    with pytest.raises(FormatError, match="FX.PAK-0001 is declared with layouts COM and module"):
        loaded.modules(gdir, [one(), one(pointer="ds:[0300]", layout="module")], {"MAIN.COM"})


@pytest.mark.parametrize("e,programs,msg", [
    ({"program": "OTHER.EXE"}, {"MAIN.COM"}, "OTHER.EXE is not a program of G"),
    ({"file": "NONE.PAK"}, {"MAIN.COM"}, "G has no file NONE.PAK"),
    ({"records": [1, 3, 9]}, {"MAIN.COM"}, "FX.PAK has no record 3, 9 \\(it has 1, 2\\)"),
    ({"file": "MAIN.COM", "records": None}, {"MAIN.COM"}, "MAIN.COM is already a program of G"),
    ({"records": [1]}, {"MAIN.COM", "FX.PAK-0001"}, "FX.PAK-0001 is already a program of G"),
    ({"file": "RAW.BIN", "records": [1]}, {"MAIN.COM"}, "RAW.BIN: reader .* failed: record cut off at 0"),
])
def test_modules_checks(gdir, e, programs, msg):
    with pytest.raises(FormatError, match=msg):
        loaded.modules(gdir, [one(**e)], programs)


# ------------------------------------------------------------------ reader plugins


def reader_file(tmp_path: Path, source: str, name: str = "reader.py") -> Path:
    path = tmp_path / name
    path.write_text(source)
    return path


def test_reader_is_resolved_against_the_manifest(tmp_path):
    (tmp_path / "sub").mkdir()
    p = tmp_path / "sub" / "m.json"
    p.write_text(json.dumps({"G": [entry(reader="../plugins/pak.py")]}))
    assert loaded.load(p, "g")[0].reader == tmp_path / "sub" / "../plugins/pak.py"
    assert loaded.parse({"G": [entry(reader="r.py")]}, "G", Path("base"))[0].reader == Path("base/r.py")


def test_reader_is_trimmed_and_whole_files_have_none():
    assert loaded.parse({"G": [entry(reader=" r.py ")]}, "G", Path("b"))[0].reader == Path("b/r.py")
    assert one(records=...).reader is None


@pytest.mark.parametrize("reader", [..., None, "", "   ", 1, ["r.py"], {}])
def test_records_need_a_reader(reader):
    with pytest.raises(FormatError, match=r"G\[0\]: records need a reader"):
        one(reader=reader)


@pytest.mark.parametrize("reader", ["r.py", "", 1])
def test_a_whole_file_takes_no_reader(reader):
    with pytest.raises(FormatError, match=r"G\[0\]: reader is for entries with records"):
        loaded.parse({"G": [entry(records=..., reader=reader)]}, "G")


def test_reader_file_must_exist(gdir, tmp_path):
    missing = tmp_path / "nowhere.py"
    with pytest.raises(FormatError, match=f"reader {missing} for FX.PAK is not a file"):
        loaded.modules(gdir, [one(reader=str(missing))], {"MAIN.COM"})
    with pytest.raises(FormatError, match="is not a file"):
        loaded.modules(gdir, [one(reader=str(tmp_path))], {"MAIN.COM"})


@pytest.mark.parametrize("source,msg", [
    ("x = 1\n", "defines no records"),
    ("records = 5\n", "defines no records"),
    ("def records(data, name):\n    raise ValueError('cut off')\n", "reader .*reader.py failed: cut off"),
    ("def records(data, name):\n    return {}[1]\n", "failed: 1"),
    ("raise RuntimeError('at import')\n", "failed: at import"),
    ("def records(:\n", "failed: "),
    ("def records(data, name):\n    return [1]\n", "must return a dict of int -> bytes, not list"),
    ("def records(data, name):\n    return None\n", "not NoneType"),
    ("def records(data, name):\n    return {'1': b''}\n", "must return a dict of int -> bytes"),
    ("def records(data, name):\n    return {1: 'text'}\n", "must return a dict of int -> bytes"),
    ("def records(data, name):\n    return {1: bytearray(b'')}\n", "must return a dict of int -> bytes"),
    ("def records(data, name):\n    return {True: b''}\n", "must return a dict of int -> bytes"),
])
def test_a_bad_reader_is_a_format_error_naming_reader_and_file(gdir, tmp_path, source, msg):
    path = reader_file(tmp_path, source)
    with pytest.raises(FormatError, match=msg) as info:
        loaded.modules(gdir, [one(reader=str(path))], {"MAIN.COM"})
    assert "FX.PAK" in str(info.value) and str(path) in str(info.value)


def test_a_reader_that_is_not_python_is_a_format_error(gdir, tmp_path):
    path = reader_file(tmp_path, "def records(data, name):\n    return {}\n", "reader.txt")
    with pytest.raises(FormatError, match="failed"):
        loaded.modules(gdir, [one(reader=str(path))], {"MAIN.COM"})


def test_a_good_reader_gets_the_file_bytes_and_name(gdir, tmp_path):
    path = reader_file(tmp_path, "def records(data, name):\n    return {1: data[:1] + name.encode(), 7: b''}\n")
    got = loaded.modules(gdir, [one(reader=str(path), records=[7, 1])], {"MAIN.COM"})
    assert [(g[0], g[1]) for g in got] == [("FX.PAK-0007", b""), ("FX.PAK-0001", b"\x01FX.PAK")]


def test_two_entries_with_different_readers_do_not_share_state(gdir, tmp_path):
    a = reader_file(tmp_path, "def records(data, name):\n    return {1: b'a'}\n", "a.py")
    b = reader_file(tmp_path, "def records(data, name):\n    return {1: b'b', 2: b'c'}\n", "b.py")
    got = loaded.modules(gdir, [one(reader=str(a)), one(reader=str(b), pointer="ds:[0300]", records=[2])], {"MAIN.COM"})
    assert [g[:2] for g in got] == [("FX.PAK-0001", b"a"), ("FX.PAK-0002", b"c")]


# ------------------------------------------------------------------ resolve (through game.build)


def calls(g, site: str) -> list[dict]:
    return [e for e in g.graph["edges"] if e["instruction_offset"] == site]


def test_without_declarations_the_calls_stay_unknown(gdir):
    g = game.build(gdir)
    assert [e["target"] for e in calls(g, "MAIN_COM:0104")] == ["unknown:MAIN_COM:0104"]
    assert sorted(g.graph["programs"]) == ["MAIN.COM"]


def test_a_declared_pointer_calls_the_record(gdir):
    g = game.build(gdir, (one(),))
    (edge,) = calls(g, "MAIN_COM:0104")
    assert edge == {
        "conditions": [], "instruction": "lcall [0x200]", "instruction_offset": "MAIN_COM:0104", "returns": True,
        "source": "MAIN_COM:0100", "target": "FX_PAK-0001:0100",
        "through": "ds:[0200]: the far pointer to FX.PAK record 1 (FX_PAK-0001), read from the file at run time; "
                   "declared in loaded_modules.json: seen at 0104",
    }
    assert "unknown:MAIN_COM:0104" not in g.graph["nodes"]
    assert [e["target"] for e in calls(g, "MAIN_COM:0108")] == ["unknown:MAIN_COM:0108"]  # ds:[0300]: undeclared
    node = g.graph["nodes"]["FX_PAK-0001:0100"]
    assert (node["source_file"], node["file_offset"], node["entrypoint"]) == ("FX.PAK-0001", None, True)
    assert g.graph["programs"]["FX.PAK-0001"] == ["FX.PAK-0001"]
    assert g.graph["counts"]["unknown_targets"] == 1


def test_alternative_records_each_get_an_edge(gdir):
    g = game.build(gdir, (one(records=[1, 2], layout="module"), one(pointer="ds:[0300]", file="RAW.BIN", records=None)))
    assert {e["target"]: e["through"].split(", read")[0] for e in calls(g, "MAIN_COM:0104")} == {
        "FX_PAK-0001:0000": "ds:[0200]: the far pointer to FX.PAK record 1 (FX_PAK-0001)",
        "FX_PAK-0002:0000": "ds:[0200]: the far pointer to FX.PAK record 2 (FX_PAK-0002)",
    }
    assert all("(one of records 1, 2: the player's configuration picks which is loaded)" in e["through"] for e in calls(g, "MAIN_COM:0104"))
    (whole,) = calls(g, "MAIN_COM:0108")
    assert whole["target"] == "RAW_BIN:0100" and whole["through"].startswith("ds:[0300]: the far pointer to RAW.BIN (RAW_BIN),")
    assert g.graph["nodes"]["RAW_BIN:0100"]["file_offset"] == 0  # a whole file keeps its file offsets
    assert g.graph["counts"]["unknown_targets"] == 0


def test_a_pointer_nothing_calls_through_is_an_error(gdir):
    with pytest.raises(FormatError, match=r"MAIN.COM has no far call through ds:\[0400\]"):
        game.build(gdir, (one(pointer="ds:[0400]"),))
