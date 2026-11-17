import pytest
from conftest import RETF, Module, build, exepack, mz

from dosgraph import game
from dosgraph.binary import COM_MAX, Program, jump_table, load_executable, parse_mz
from dosgraph.emit import combine, frames
from dosgraph.errors import FormatError


def tp_game():
    return build(RETF * 16, [Module(b"\x55\xcb", [0])])


# ------------------------------------------------------------------ loading one file


@pytest.mark.parametrize("name", ["X.EXE", "X.COM", "X.DRV", "X"])
def test_an_mz_header_wins_over_the_extension(name):
    assert load_executable(mz(RETF * 16), name).layout == "MZ"


def test_com_loads_at_100h_behind_an_empty_psp():
    m = load_executable(b"\xc3", "A.COM")
    assert (m.layout, m.entry, m.file_base, m.image[:0x100], m.image[0x100:]) == ("COM", 0x100, -0x100, bytes(0x100), b"\xc3")


@pytest.mark.parametrize("size,ok", [(COM_MAX, True), (COM_MAX + 1, False)])
def test_com_size_limit(size, ok):
    if ok:
        assert len(load_executable(b"\x90" * size, "A.COM").image) == size + 0x100
    else:
        with pytest.raises(FormatError, match="more than a .COM can hold"):
            load_executable(b"\x90" * size, "A.COM")


@pytest.mark.parametrize("name", ["EGA.DRV", "SOUND.BIN", "NOEXT"])
def test_anything_else_is_a_module_at_offset_0(name):
    m = load_executable(b"\xcb", name)
    assert (m.layout, m.entry, m.file_base, m.image) == ("module", 0, 0, b"\xcb")


@pytest.mark.parametrize("name", ["A.COM", "A.DRV"])
def test_empty_files_are_rejected(name):
    with pytest.raises(FormatError, match="empty file"):
        load_executable(b"", name)


@pytest.mark.parametrize("layout,name,data,entry,base", [
    ("COM", "SOUND.PAK-0001", b"\xcb", 0x100, -0x100),  # a declared .COM image, whatever its name
    ("COM", "X.DRV", b"MZ\xcb", 0x100, -0x100),         # declared layout wins over an MZ-looking start
    ("module", "X.COM", b"\xcb", 0, 0),
    ("module", "X.EXE", b"MZ\xcb", 0, 0),
])
def test_declared_layout_overrides_extension_and_header(layout, name, data, entry, base):
    m = load_executable(data, name, layout)
    assert (m.layout, m.entry, m.file_base) == (layout, entry, base)


@pytest.mark.parametrize("layout", ["com", "MZ", "", "EXE"])
def test_unknown_declared_layout(layout):
    with pytest.raises(FormatError, match="is not one of COM, module"):
        load_executable(b"\xcb", "X.PAK", layout)


@pytest.mark.parametrize("layout", ["COM", "module"])
def test_declared_layout_still_rejects_empty_files(layout):
    with pytest.raises(FormatError, match="empty file"):
        load_executable(b"", "X.PAK", layout)


def test_declared_com_keeps_the_size_limit():
    with pytest.raises(FormatError, match="more than a .COM can hold"):
        load_executable(b"\x90" * (COM_MAX + 1), "X.PAK", "COM")


@pytest.mark.parametrize("in_file,base", [(True, -0x100), (False, None)])
def test_unpacked_code_has_no_file_offset(in_file, base):
    p = Program(b"\xcb", None, "FX.PAK-0001", None, layout="COM", in_file=in_file, loaded_from="record 1 of FX.PAK")
    assert (p.root, p.mz.file_base, p.spaces[p.root].file_base, p.loaded_from) == ("FX_PAK-0001", base, base, "record 1 of FX.PAK")


def test_appended_bytes_are_counted():
    data = mz(RETF * 16)
    assert parse_mz(data + b"\x07\x97\x59\x00").appended == 4
    assert parse_mz(exepack(RETF * 32) + b"xy").appended == 2


@pytest.mark.parametrize("image,slots", [
    (b"", []), (b"\xe9\x00", []), (b"\xe9\x00\x00", [0]), (b"\xe9\x00\x00\xe9\x01\x00\xcb", [0, 3]),
    (b"\xcb\xe9\x00\x00", []), (b"\xe9\x00\x00\x90\xe9\x00\x00", [0]),
])
def test_jump_table(image, slots):
    assert jump_table(image) == slots


def test_module_entries_are_the_jump_table_slots_and_proven():
    from dosgraph.flow import analyze
    from dosgraph.x86 import Decoder

    drv = b"\xe9\x03\x00" + b"\xe9\x01\x00" + b"\xcb" + b"\xcb" + b"\xcb"  # slots 0, 3 jump to 6 and 7
    p = Program(drv, None, "EGA.DRV")
    assert p.module_entry_ids() == ["EGA_DRV:0000", "EGA_DRV:0003"]
    an = analyze(p, Decoder(p), stop_on_fallthrough=True)
    assert {"EGA_DRV:0000", "EGA_DRV:0003"} <= set(an.descents)
    assert not an.provisional("EGA_DRV:0003")
    assert Program(b"\xe9\x00\x00\xcb", None, "A.COM").module_entry_ids() == []  # a .COM exports nothing


def test_a_com_space_starts_at_100h():
    p = Program(b"\xc3", None, "A.COM")
    sp = p.spaces["A_COM"]
    assert (0xFF in sp, 0x100 in sp, 0x101 in sp) == (False, True, False)


def test_overlay_stubs_without_an_overlay_file_are_an_error():
    b = tp_game()
    with pytest.raises(FormatError, match="1 INT 3Fh overlay stub segments but no overlay file"):
        Program(b.exe, None)
    p = Program(mz(RETF * 16), None, "MENU.EXE")
    assert p.blocks == [] and p.ovr_name is None and p.overlay_entry_ids() == []


@pytest.mark.parametrize("layout,data,expect", [
    ("MZ", None, [("seg", "MAIN.EXE"), ("flat", "MAIN.EXE"), ("flat", "MAIN.OVR")]),
    ("COM", b"\xc3", [("flat", "START.COM")]),
    ("module", b"\xcb", [("flat", "START.DRV")]),
])
def test_frames_follow_the_layout(layout, data, expect):
    if data is None:
        b = tp_game()
        p = Program(b.exe, b.ovr)
    else:
        p = Program(data, None, f"START.{'COM' if layout == 'COM' else 'DRV'}")
    assert [(f["form"], f["file"]) for f in frames(p)] == expect


def test_combine_rejects_an_alias_with_two_meanings_and_sums_counts():
    a = {"counts": {"functions": 1}, "nodes": {"A_EXE:0000": {}}, "edges": [{"e": 1}], "aliases": {"0016:0020": "X:0000"}}
    b = {"counts": {"functions": 2}, "nodes": {"B_EXE:0000": {}}, "edges": [{"e": 2}], "aliases": {"0016:0020": "X:0000"}}
    g = combine([a, b], {"A.EXE": "h"}, [], {"A.EXE": ["A.EXE"]})
    assert g["counts"] == {"functions": 3} and list(g["nodes"]) == ["A_EXE:0000", "B_EXE:0000"] and len(g["edges"]) == 2
    with pytest.raises(FormatError, match="far-call alias 0016:0020 means X:0000 in one program and Y:0000"):
        combine([a, {**b, "aliases": {"0016:0020": "Y:0000"}}], {}, [], {})


# ------------------------------------------------------------------ a game directory


def write(tmp_path, files: dict[str, bytes]):
    for name, data in files.items():
        (tmp_path / name).write_bytes(data)
    return tmp_path


def test_inventory_pairs_each_overlay_file_with_the_program_it_fits(tmp_path):
    b, other = tp_game(), build(RETF * 32, [Module(RETF * 3, [0, 1])])
    d = write(tmp_path, {"main.exe": b.exe, "MAIN.OVR": b.ovr, "TOOL.EXE": other.exe, "TOOL.OVR": other.ovr,
                         "FX.COM": b"\xc3", "EGA.DRV": b"\xcb", "TITLE.PAK": b"\x00", "README.TXT": b"hi"})
    (tmp_path / "SAVE").mkdir()
    (tmp_path / "SAVE.EXE").mkdir()  # a directory named like a program is not one
    inv = game.inventory(d)
    assert [(n, o) for n, _e, o, _ov in inv] == [("EGA.DRV", None), ("FX.COM", None), ("MAIN.EXE", "MAIN.OVR"), ("TOOL.EXE", "TOOL.OVR")]
    assert inv[2][3] == b.ovr


@pytest.mark.parametrize("files,message", [
    ({}, "no .EXE, .COM or .DRV files"),
    ({"README.TXT": b"x"}, "no .EXE, .COM or .DRV files"),
    ({"MAIN.EXE": "stubbed"}, r"0 overlay files fit its stub chain \(the directory has no .OVR file\)"),
    ({"MAIN.EXE": "stubbed", "OTHER.OVR": b"TPOV"}, r"0 overlay files fit its stub chain \(none of OTHER.OVR\)"),
    ({"MAIN.EXE": "stubbed", "MAIN.OVR": "ovr", "COPY.OVR": "ovr"}, r"2 overlay files fit its stub chain \(COPY.OVR, MAIN.OVR\)"),
    ({"MAIN.EXE": "stubbed", "TWIN.EXE": "stubbed", "MAIN.OVR": "ovr"}, "MAIN.OVR fits the stub chains of both MAIN.EXE and TWIN.EXE"),
    ({"MENU.EXE": "plain", "MAIN.OVR": "ovr"}, "MAIN.OVR: no program's overlay stub chain fits"),
    ({"BAD.EXE": b"MZ"}, "truncated MZ header"),
])
def test_inventory_rejects(tmp_path, files, message):
    b = tp_game()
    content = {"stubbed": b.exe, "ovr": b.ovr, "plain": mz(RETF * 16)}
    d = write(tmp_path, {k: content.get(v, v) if isinstance(v, str) else v for k, v in files.items()})
    with pytest.raises(FormatError, match=message):
        game.inventory(d)


def test_inventory_rejects_names_that_differ_only_in_case(tmp_path):
    d = write(tmp_path, {"MAIN.EXE": mz(RETF * 16), "main.exe": mz(RETF * 16)})
    with pytest.raises(FormatError, match="two files are named MAIN.EXE apart from letter case"):
        game.inventory(d)


def test_build_merges_every_program(tmp_path):
    b = tp_game()
    d = write(tmp_path, {"MAIN.EXE": b.exe, "MAIN.OVR": b.ovr, "FX.COM": b"\xb8\x00\x4c\xcd\x21"})
    g = game.build(d)
    assert [p.exe_name for p, _an in g.programs] == ["FX.COM", "MAIN.EXE"]
    assert {n["source_file"] for n in g.graph["nodes"].values()} == {"FX.COM", "MAIN.EXE", "MAIN.OVR"}
    assert set(g.graph["provenance"]["files"]) == {"FX.COM", "MAIN.EXE", "MAIN.OVR"} and set(g.diagnostics) == {"FX.COM", "MAIN.EXE"}
