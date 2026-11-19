"""Microsoft LINK overlays (MZ images appended to the EXE, entered through `int 3Fh; db segment; dw offset`), and
`int 3Fh` reached in a program whose overlays were not parsed."""

import struct
import sys
from pathlib import Path

import pytest
from conftest import DOS_EXIT, RETF, Overlay, call, jmp, link_overlays, mz, overlay_call, patch
from test_flow import code, edges_from, hazards
from test_pointers import lcall_mem, store_imm

from dosgraph import pointers
from dosgraph.binary import Program
from dosgraph.emit import build_graph, files_table, render_listing
from dosgraph.errors import FormatError
from dosgraph.flow import analyze, straight_preds
from dosgraph.x86 import Decoder

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import build_callgraph as cli  # noqa: E402

R = "MAIN_EXE"
O1, O2 = f"{R}-0001", f"{R}-0002"
# both overlays load at 0080h, an area past the 200h-byte root image; the second has a relocated word at 12h
ONE = Overlay(0x80, b"\x55" + RETF * 0x1F)
TWO = Overlay(0x80, b"\x90" * 0x10 + RETF * 0x30, fixups=[(0x80, 0x12)])
ROOT = overlay_call(1, 0) + overlay_call(2, 0x10) + DOS_EXIT
FIRST = 0x400  # file offset of the first appended image: the page after the 220h-byte root file
NO_TABLE = "0 Microsoft LINK segment tables fit its 2 appended overlays, need exactly one"


def exe(root: bytes = ROOT, overlays=(ONE, TWO), **kw) -> bytes:
    return link_overlays(root, list(overlays), **kw)


def program(root: bytes = ROOT, overlays=(ONE, TWO), **kw) -> Program:
    return Program(exe(root, overlays, **kw), None, "MAIN.EXE")


def analysed(root: bytes = ROOT, overlays=(ONE, TWO), **kw):
    p = program(root, overlays, **kw)
    dec = Decoder(p)
    an = analyze(p, dec, stop_on_fallthrough=True)
    return p, dec, an, build_graph(p, dec, an)


def test_overlays_are_spaces_named_by_their_number():
    p = program()
    assert set(p.spaces) == {R, O1, O2} and set(p.sections) == {O1, O2}
    assert p.link_segments == [(0, 0), (1, 0x80), (2, 0x80)]
    assert (p.spaces[O1].file_base, p.spaces[O2].file_base) == (FIRST + 0x20, FIRST + 0x200 + 0x20)
    assert p.spaces[O1].data == ONE.code and p.spaces[O1].source_file == "MAIN.EXE"
    assert p.spaces[O1].relocated_words == set() and p.spaces[O2].relocated_words == {0x12}
    assert (p.sections[O2].load, p.sections[O2].paragraphs, p.sections[O2].parent) == (0x80, 4, None)
    assert p.overlay_entry_ids() == [] and p.aliases() == {}  # no stubs: callers name the segment and the offset
    assert files_table([p], {"MAIN.EXE": "h"}) == "| MAIN.EXE | MZ; Microsoft LINK overlays appended (2) | `h` |"


def test_a_packed_root_keeps_its_overlays():
    p = program(packed=True)
    assert p.mz.layout == "MZ unpacked from EXEPACK" and p.spaces[R].file_base is None
    assert set(p.sections) == {O1, O2} and p.spaces[O2].file_base is not None
    assert "Microsoft LINK overlays appended (2)" in files_table([p], {"MAIN.EXE": "h"})


def test_the_signature_may_be_written_either_way_round():
    assert set(Program(patch(exe(), FIRST, b"ZM"), None, "MAIN.EXE").sections) == {O1, O2}


def test_an_overlay_call_names_a_segment_and_an_offset_in_it():
    p = program()
    assert p.overlay_call(1, 0x1F) == (f"{O1}:001f", f"in {O1}")
    assert p.overlay_call(1, 0x20) == (None, f"far target 0x820 is past the code of {O1}")
    assert p.overlay_call(2, 0x3F)[0] == f"{O2}:003f"
    assert p.overlay_call(0, 0x7) == (f"{R}:0007", "root")  # a segment of overlay 0 is the root's
    assert p.overlay_call(3, 0) == (None, "overlay call names segment 3, the program's table has 3")
    assert p.overlay_call(0xFF, 0)[0] is None


def test_an_overlay_of_several_segments_counts_across_them():
    # overlay 1 holds segments 1 (0080h) and 2 (0081h); overlay 2 is segment 3
    p = program(overlay_call(2, 4) + overlay_call(3, 0) + DOS_EXIT, [Overlay(0x80, ONE.code, segments=[0x80, 0x81]), TWO])
    assert p.link_segments == [(0, 0), (1, 0x80), (1, 0x81), (2, 0x80)]
    assert p.overlay_call(2, 4)[0] == f"{O1}:0014" and p.overlay_call(1, 4)[0] == f"{O1}:0004"
    assert [p.code_base(O1, a) for a in (0x0F, 0x10, 0x1F)] == [0, 0x10, 0x10] and p.code_base(O2, 0x30) == 0
    # a later segment may come first in the table: the overlay loads at its lowest
    q = program(overlay_call(1, 4) + overlay_call(3, 0) + DOS_EXIT, [Overlay(0x80, ONE.code, segments=[0x81, 0x80]), TWO])
    assert q.sections[O1].load == 0x80 and q.overlay_call(1, 4)[0] == f"{O1}:0014"


def test_far_addresses_in_the_overlay_area():
    p = program()
    assert p.resolve_far(0x80, 0x5, O1) == (f"{O1}:0005", f"in {O1}")  # from overlay code: its own overlay
    assert p.resolve_far(0x80, 0x5, O2)[0] == f"{O2}:0005"
    assert p.resolve_far(0x0, 0x9, O1) == (f"{R}:0009", "root")
    assert p.resolve_far(0x80, 0x5) == (None, "far target 0x805 is in the load area of 2 overlay sections")
    assert p.stub_table_of(0x7FF) is None and p.stub_table_of(0x840) is None
    assert p.stub_table_of(0x800) == p.stub_table_of(0x83F) == f"{R} overlay area"  # as far as the longer overlay
    assert p.resolve_far(0x80, 0x25) == (f"{O2}:0025", f"in {O2}")  # only the longer overlay reaches it
    # an area inside the root image holds no root code: an address in it is an overlay's as well
    inside = program(size=0x900)
    assert inside.resolve_far(0x80, 0x5) == (None, "far target 0x805 is in the load area of 2 overlay sections")
    assert inside.resolve_far(0x80, 0x25) == inside.resolve_far(0x80, 0x25, O1) == (f"{O2}:0025", f"in {O2}")
    assert inside.resolve_root_linear(0x805) == (None, f"inside the {R} overlay area, not at a stub entry (0x805)")
    assert inside.resolve_root_linear(0x7FF)[0] == f"{R}:07ff" and inside.resolve_root_linear(0x840)[0] == f"{R}:0840"


def test_far_pointers_into_the_overlay_area():
    # root data in segment 0018h (named by the relocated word at 1A0h): 0080:0025, which only the longer overlay
    # reaches, and 0080:0005, which is in both
    root = code(0x200, {0: ROOT, 0x184: struct.pack("<4H", 0x25, 0x80, 0x05, 0x80), 0x1A0: b"\x18\x00"}, b"\x00")
    _p, _dec, an, g = analysed(root, relocs=[0x186, 0x18A, 0x1A0])
    assert an.address_taken == {f"{O2}:0025": [f"far pointer 0080h:0025 in the load image at {R}:0184"]}
    assert g["nodes"][f"{O2}:0025"]["provisional"] is True and an.rejected_pointers == {}


def test_an_overlay_means_itself_by_its_load_segment():
    # overlay 1 stores 0080:0038 (the segment both overlays load at) and 0000:0020 (the root), and calls through both
    parts = [store_imm(0x100, 0x38), store_imm(0x102, 0x80), store_imm(0x104, 0x20), store_imm(0x106, 0),
             lcall_mem(0x100), lcall_mem(0x104), RETF]
    one = Overlay(0x80, code(0x40, {0: b"".join(parts), 0x38: RETF}), fixups=[(0x80, 10), (0x80, 22)])
    _p, _dec, an, g = analysed(code(0x40, {0: ROOT, 0x20: RETF}, b"\x00"), [one, TWO])
    assert {s: e["target"] for s, e in edges_from(g, f"{O1}:0000").items()} == {f"{O1}:0018": f"{O1}:0038", f"{O1}:001c": f"{R}:0020"}
    assert an.proof[f"{O1}:0038"] == [f"lcall [0x100] at {O1}:0018 (stored at {O1}:0006)"]


def test_analysis_follows_overlay_calls():
    # overlay 1: an overlay call into overlay 2, a far call into itself (0080:0018), one into the root (0000:0020)
    one = Overlay(0x80, code(0x20, {0: overlay_call(2, 0x10) + b"\x9a\x18\x00\x80\x00" + b"\x9a\x20\x00\x00\x00" + RETF, 0x18: RETF}),
                  fixups=[(0x80, 8), (0x80, 13)])
    p, _dec, an, g = analysed(code(0x40, {0: overlay_call(1, 0) + DOS_EXIT, 0x20: RETF}, b"\x00"), [one, TWO])
    assert {f"{O1}:0000", f"{O1}:0018", f"{O2}:0010", f"{R}:0020"} <= set(an.descents)
    assert an.root_kinds[f"{O1}:0000"] == {"call-target"}
    d = an.descents[f"{R}:0000"]
    assert sorted(d.insns) == [0, 5, 7] and d.insns[0].size == 5 and not d.hazards
    assert render_listing(f"{R}:0000", d).splitlines()[1] == "0000  cd3f010000    int 0x3f  ; overlay call: segment 1, offset 0x0"
    e = edges_from(g, f"{R}:0000")[f"{R}:0000"]
    assert (e["target"], e["returns"], e["instruction"]) == (f"{O1}:0000", True, "int 0x3f  ; overlay call: segment 1, offset 0x0")
    assert "through" not in e
    assert {s: e["target"] for s, e in edges_from(g, f"{O1}:0000").items()} == {
        f"{O1}:0000": f"{O2}:0010", f"{O1}:0005": f"{O1}:0018", f"{O1}:000a": f"{R}:0020"}
    node = g["nodes"][f"{O2}:0010"]
    assert (node["space"], node["file_offset"], node["source_file"]) == (O2, FIRST + 0x200 + 0x20 + 0x10, "MAIN.EXE")
    assert node["listing"] == "units/main_exe/functions/MAIN_EXE-0002_0010.asm"


def test_an_overlay_call_to_no_function_is_an_unknown_target():
    # segment 9 is not in the table: the call is decoded, goes nowhere known, and the code after it is still read
    _p, _dec, an, g = analysed(overlay_call(9, 0) + overlay_call(1, 0) + overlay_call(2, 0) + DOS_EXIT)
    assert sorted(an.descents[f"{R}:0000"].insns) == [0, 5, 10, 15, 17]
    assert edges_from(g, f"{R}:0000")[f"{R}:0000"]["target"] == f"unknown:{R}:0000"


def test_an_overlay_call_cut_off_by_the_end_of_its_space():
    root = code(0x200, {0: jmp(0, 0x1FD), 0x40: ROOT, 0x1FD: b"\xcd\x3f\x01"}, b"\x00")
    _p, _dec, an, _g = analysed(root)
    assert [h["addr"] for h in hazards(an, "invalid-opcode-in-flow")] == [0x1FD]


def test_flow_into_the_overlay_area_stops():
    # running on into the area, and jumping into it
    root = code(0x800, {0: b"\x74\x03" + jmp(2, 0x800) + jmp(5, 0x7FE), 0x10: ROOT, 0x7FE: b"\x90\x90"}, b"\x00")
    _p, _dec, an, _g = analysed(root, size=0x900)
    assert [h["detail"] for h in hazards(an, "flow-into-overlay-stub-table")] == [
        f"flow reaches the {R} overlay area at 0x800; previous 90 nop"]
    assert [h["detail"] for h in hazards(an, "unresolvable-jump")] == [
        f"e9fb07 jmp 0x800: inside the {R} overlay area, not at a stub entry (0x800)"]
    assert max(an.descents[f"{R}:0000"].insns) == 0x7FF


@pytest.mark.parametrize("callee,stack_after", [
    (b"\xcb", ["x", "cs"]),  # retf: it pops the return address the overlay manager pushed, no arguments
    (b"\xca\x02\x00", ["x"]),  # retf 2: one argument word
])
def test_an_overlay_call_is_a_far_call_to_the_stack(callee, stack_after):
    # push bx; push cs; overlay call
    root = code(0x40, {0: call(0, 0x10) + overlay_call(2, 0) + DOS_EXIT, 0x10: b"\x53\x0e" + overlay_call(1, 0) + b"\xc3"}, b"\x00")
    p, dec, an, _g = analysed(root, [Overlay(0x80, callee.ljust(0x20, b"\xcb")), TWO])
    w = pointers._Walk(p, dec, pointers.Facts(), None, an.descents)
    seen = {}
    orig = w.step

    def step(fid, d, ins, st):
        orig(fid, d, ins, st)
        if ins.addr == 0x12:
            seen["after"] = ["cs" if isinstance(v, pointers.Seg) else "x" for v in st["@stack"]]

    w.step = step
    d = an.descents[f"{R}:0010"]
    w.run(f"{R}:0010", d, straight_preds(d), False)
    assert seen["after"] == stack_after


# ------------------------------------------------------------------ layouts that are not parsed


def test_appended_data_that_is_no_image_stays_data():
    plain = mz(DOS_EXIT.ljust(0x40, b"\x00"))
    for tail in (bytes(-len(plain) % 512) + b"some data", b"MZ" + bytes(0x40)):  # no signature; one that is not on a page
        p = Program(plain + tail, None, "MAIN.EXE")
        assert p.sections == {} and p.link_segments == [] and p.stub_ranges == []
        assert files_table([p], {"MAIN.EXE": "h"}) == f"| MAIN.EXE | MZ; {len(tail)} bytes appended after the load image | `h` |"


def test_an_appended_image_must_be_a_whole_mz_file():
    with pytest.raises(FormatError, match=r"MAIN_EXE: image appended at 0x400: truncated MZ header: 10 bytes"):
        Program(exe()[: FIRST + 10], None, "MAIN.EXE")
    with pytest.raises(FormatError, match=r"image appended at 0x600: truncated MZ file: header declares 96 bytes, file has 95"):
        Program(exe()[:-1], None, "MAIN.EXE")


@pytest.mark.parametrize("numbers,message", [
    ([0, 2], "image appended at 0x400 carries overlay number 0, expected 1"),  # a second program, not an overlay
    ([2, 1], "image appended at 0x400 carries overlay number 2, expected 1"),
    ([1, 1], "image appended at 0x600 carries overlay number 1, expected 2"),
    ([1, 3], "image appended at 0x600 carries overlay number 3, expected 2"),
])
def test_overlays_are_numbered_in_file_order(numbers, message):
    with pytest.raises(FormatError, match=message):
        program(numbers=numbers)


def test_the_last_overlay_ends_the_file():
    with pytest.raises(FormatError, match="MAIN_EXE: 3 bytes follow its last appended overlay"):
        program(tail=b"\x00" * 3)
    with pytest.raises(FormatError, match=r"image appended at 0x800: bad MZ signature"):  # enough to reach the next page
        program(tail=b"\x00" * 0x200)
    # an overlay that ends on a page boundary: anything behind it is read as the next image
    full = Overlay(0x80, TWO.code.ljust(0x1E0, b"\xcb"), fixups=TWO.fixups)
    assert set(program(overlays=[ONE, full]).sections) == {O1, O2}
    with pytest.raises(FormatError, match=r"image appended at 0x800: truncated MZ header: 1 bytes"):
        program(overlays=[ONE, full], tail=b"\x00")


@pytest.mark.parametrize("kw", [
    {"counts": (3, 2)},  # one overlay too few
    {"counts": (3, 4)},  # one too many
    {"counts": (0, 3)},  # no segments
    {"counts": (0x56, 3)},  # more segments than the image has room for
    {"relocated": [0, 1]},  # the last base word is not relocated
    {"relocated": [1, 2]},  # the first is not
    {"rows": [(0, 0), (1, 0x80), (1, 0x80)]},  # overlay 2 has no segment
    {"rows": [(0, 0), (1, 0x80), (3, 0x80)]},  # an overlay that is not appended
    {"rows": [(1, 0x80), (1, 0x80), (2, 0x80)]},  # the root has no segment
    {"overlays": [ONE, Overlay(0x80, TWO.code, fixups=[(0x80, 0x3F)])]},  # a relocated word half past the code
    {"overlays": [ONE, Overlay(0x80, TWO.code, fixups=[(0x7F, 0xF)])]},  # one before it
    {"overlays": [Overlay(0x80, ONE.code, segments=[0x80, 0x82]), TWO]},  # a segment starting where the code ends
    {"overlays": [Overlay(0x80, b""), TWO]},  # no code at all
])
def test_a_table_that_does_not_fit_the_overlays_is_no_table(kw):
    with pytest.raises(FormatError, match=NO_TABLE):
        program(**kw)


def test_segment_table_boundaries_that_do_fit():
    assert program(overlays=[ONE, Overlay(0x80, TWO.code, fixups=[(0x80, 0x3E)])]).spaces[O2].relocated_words == {0x3E}
    assert program(overlays=[ONE, Overlay(0x7F, TWO.code, fixups=[(0x7F, 0x0)])]).spaces[O2].relocated_words == {0}
    assert program(table_at=0x200 - 13).link_segments[2] == (2, 0x80)  # the table's last byte is the image's
    with pytest.raises(FormatError, match=NO_TABLE):
        program(table_at=0x200 - 13, counts=(4, 3))  # ... and a fourth segment would not fit


def test_two_tables_that_fit_are_ambiguous():
    table = struct.pack("<HH3H3B", 3, 3, 0, 0x80, 0x80, 0, 1, 2)
    with pytest.raises(FormatError, match="MAIN_EXE: 2 Microsoft LINK segment tables fit its 2 appended overlays"):
        program(code(0x200, {0: ROOT, 0x180: table}, b"\x00"), relocs=[0x184, 0x186, 0x188])
    assert program(code(0x200, {0: ROOT, 0x180: table}, b"\x00")).link_segments[1] == (1, 0x80)  # not relocated: no table


@pytest.mark.parametrize("root,missing", [
    (overlay_call(1, 0) + DOS_EXIT, "2"),
    (overlay_call(2, 0) + DOS_EXIT, "1"),
    (DOS_EXIT, "1, 2"),
    (overlay_call(1, 0) + overlay_call(3, 0) + DOS_EXIT, "2"),  # no such segment
    (overlay_call(1, 0) + overlay_call(0, 0) + DOS_EXIT, "2"),  # a segment of the root
    (overlay_call(1, 0) + overlay_call(2, 0x40) + DOS_EXIT, "2"),  # past the overlay's code
    (code(0x200, {0: overlay_call(1, 0) + DOS_EXIT, 0x1FC: b"\xcd\x3f\x02\x00"}, b"\x00"), "2"),  # cut off by the end of the image
])
def test_every_overlay_must_be_called_through_int_3fh(root, missing):
    with pytest.raises(FormatError, match=rf"MAIN_EXE: no `int 3Fh` call names a segment of overlay {missing} \(another overlay interrupt"):
        program(root)


def test_calls_that_do_count():
    # the last byte of an overlay; a call only another overlay makes; bytes that are no instruction of the root
    assert program(overlay_call(1, 0x1F) + overlay_call(2, 0x3F) + DOS_EXIT).sections
    assert program(overlay_call(1, 0) + DOS_EXIT, [Overlay(0x80, overlay_call(2, 0) + RETF * 0x1B), TWO]).sections
    assert program(DOS_EXIT + b"\xcd" + overlay_call(1, 0) + overlay_call(2, 0)).sections


# ------------------------------------------------------------------ int 3Fh where no overlays were parsed


def plain(image: bytes):
    p = Program(mz(image), None, "MAIN.EXE")
    return analyze(p, Decoder(p), stop_on_fallthrough=True)


def test_int_3fh_in_a_program_without_parsed_overlays_aborts():
    with pytest.raises(FormatError, match=r"MAIN.EXE: MAIN_EXE:0010 reaches `int 3Fh` at MAIN_EXE:0011, a call through an overlay manager"):
        plain(code(0x20, {0: call(0, 0x10) + DOS_EXIT, 0x10: b"\x90" + overlay_call(1, 0) + b"\xc3"}))


def test_int_3fh_behind_a_call_that_never_returns_is_not_code():
    # the first pass still reads on after the call; the settled one does not
    an = plain(code(0x20, {0: call(0, 0x10) + overlay_call(1, 0), 0x10: DOS_EXIT}))
    assert sorted(an.descents[f"{R}:0000"].insns) == [0] and an.noreturn == {f"{R}:0000", f"{R}:0010"}


def test_a_pointer_guess_that_decodes_to_int_3fh_is_rejected():
    # mov ax, 7: the first byte no instruction covers, where the bytes are `int 3Fh; ret`
    an = plain(b"\xb8\x07\x00" + DOS_EXIT + b"\xcd\x3f\xc3" + b"\x00" * 6)
    assert an.rejected_pointers[f"{R}:0007"] == [f"immediate 0007 at {R}:0000", "decodes into invalid/out-of-space flow"]
    assert set(an.descents) == {f"{R}:0000"}


def test_the_command_line_builds_and_refuses(tmp_path, capsys):
    game = tmp_path / "ALPHA"
    game.mkdir()
    (game / "MAIN.EXE").write_bytes(exe())
    out = tmp_path / "out"
    assert cli.main(["--game", str(game), "--out", str(out)]) == 0
    assert (out / "units/main_exe/functions/MAIN_EXE-0002_0010.asm").read_text().startswith("; MAIN_EXE-0002:0010\n0010  cb")
    assert "| MAIN.EXE | MZ; Microsoft LINK overlays appended (2) |" in (out / "navigation/README.md").read_text()
    (game / "MAIN.EXE").write_bytes(mz(overlay_call(1, 0) + DOS_EXIT))
    capsys.readouterr()
    assert cli.main(["--game", str(game), "--out", str(tmp_path / "o2")]) == 2
    assert "unsupported input: MAIN.EXE: MAIN_EXE:0000 reaches `int 3Fh` at MAIN_EXE:0000" in capsys.readouterr().err
    assert not (tmp_path / "o2").exists()
