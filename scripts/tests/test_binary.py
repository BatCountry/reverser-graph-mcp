import struct

import pytest
from conftest import RETF, Module, build, mz, patch

from dosgraph.binary import Program, file_space, find_stub_segments, nid, parse_mz, parse_overlays, split_id
from dosgraph.errors import FormatError


def simple(**kw):
    return build(b"\xc3" * 16, [Module(b"\x55\xcb\xcb\xcb", [0, 1])], **kw)


# ---------------------------------------------------------------- MZ header


def test_parse_mz_ok():
    img = bytes(range(64))
    m = parse_mz(mz(img, relocs=[4], entry=(1, 2)))
    assert m.image == img and m.relocations == {4} and m.entry == 0x12 and m.file_base == 32 and m.layout == "MZ" and m.appended == 0


def test_truncated_header():
    with pytest.raises(FormatError, match="truncated MZ header"):
        parse_mz(b"MZ" + bytes(10))


def test_bad_signature():
    with pytest.raises(FormatError, match="bad MZ signature"):
        parse_mz(patch(mz(bytes(32)), 0, b"PE"))


def test_zm_signature_accepted():
    assert parse_mz(patch(mz(bytes(32)), 0, b"ZM")).image == bytes(32)


@pytest.mark.parametrize("cblp,cp", [(0, 0), (512, 1)])
def test_bad_page_counts(cblp, cp):
    with pytest.raises(FormatError, match="page counts"):
        parse_mz(patch(mz(bytes(32)), 2, struct.pack("<HH", cblp, cp)))


def test_exact_page_multiple():
    data = mz(bytes(512 - 32))
    assert len(parse_mz(data).image) == 480 and struct.unpack_from("<H", data, 2)[0] == 0


@pytest.mark.parametrize("paras", [1, 50])
def test_header_size_out_of_range(paras):
    with pytest.raises(FormatError, match="header size"):
        parse_mz(patch(mz(bytes(64)), 8, struct.pack("<H", paras)))


def test_truncated_file():
    with pytest.raises(FormatError, match="truncated MZ file"):
        parse_mz(mz(bytes(64))[:-1])


def test_relocation_table_past_header():
    with pytest.raises(FormatError, match="relocation table"):
        parse_mz(patch(mz(bytes(64)), 6, struct.pack("<H", 5)))


def test_relocation_past_image():
    with pytest.raises(FormatError, match="relocation 0"):
        parse_mz(mz(bytes(16), relocs=[15]))


def test_entry_outside_image():
    with pytest.raises(FormatError, match="entry point"):
        parse_mz(mz(bytes(16), entry=(1, 0)))


# ---------------------------------------------------------------- overlays


def test_program_ok():
    b = simple()
    p = Program(b.exe, b.ovr, "main.exe", "main.ovr")
    mid = b.module_id(0)
    assert p.root == "MAIN_EXE" and p.exe_name == "MAIN.EXE" and p.ovr_name == "MAIN.OVR"
    assert set(p.spaces) == {"MAIN_EXE", mid}
    assert p.spaces[mid].file_base == 4 and p.spaces["MAIN_EXE"].file_base == b.header_size
    assert p.overlay_entry_ids() == [f"{mid}:0000", f"{mid}:0001"]
    seg = b.stub_segments[0]
    assert mid == f"MAIN_OVR-{seg:04x}"  # the segment far calls into the overlay write
    assert p.aliases() == {
        f"{seg:04x}:0020": f"{mid}:0000", f"{seg:04x}:0025": f"{mid}:0001",
        nid("MAIN_EXE", b.stub(0, 0)): f"{mid}:0000", nid("MAIN_EXE", b.stub(0, 1)): f"{mid}:0001",
    }
    assert p.resolve_far(seg, 0x25) == (f"{mid}:0001", f"stub MAIN_EXE:{b.stub(0, 1):04x} -> {mid}:0001")
    assert p.resolve_root_linear(seg * 16 + 2)[0] is None
    assert "stub segment" in p.resolve_root_linear(seg * 16 + 2)[1]
    assert p.resolve_root_linear(3) == ("MAIN_EXE:0003", "root")
    assert p.resolve_root_linear(len(p.image) + 5)[0] is None
    assert p.stub_table_of(seg * 16 + 0x21) == mid and p.stub_table_of(0) is None
    assert p.stub_table_of(len(p.image) + 100) is None
    assert split_id("MAIN_OVR-0016:0022") == ("MAIN_OVR-0016", 0x22)


@pytest.mark.parametrize("name,space", [("MAIN.EXE", "MAIN_EXE"), ("main.ovr", "MAIN_OVR"), ("DRVA.COM", "DRVA_COM"),
                                        ("NOEXT", "NOEXT"), ("A.B.C", "A_B_C")])
def test_file_space(name, space):
    assert file_space(name) == space


def test_sentinel_stub():
    b = build(RETF * 16, [Module(RETF, [0, 0xFFFF])])
    p = Program(b.exe, b.ovr)
    assert list(p.sentinel_stubs) == [b.stub(0, 1)] and len(p.aliases()) == 2
    assert "sentinel" in p.resolve_root_linear(b.stub(0, 1))[1]


def test_two_modules_chain_and_segment_bases():
    mods = [Module(RETF * 3, [0]), Module(b"\x9a\x00\x00\x00\x00" + RETF, [5], fixups=[3])]
    b = build(RETF * 16, mods)
    p = Program(b.exe, b.ovr)
    assert [x.name for x in p.blocks] == [b.module_id(0), b.module_id(1)]
    assert p.blocks[1].previous_segment == b.stub_segments[0]
    assert p.segment_bases() == [0]


def test_bad_ovr_signature():
    b = simple()
    with pytest.raises(FormatError, match="signature"):
        Program(b.exe, b"XXXX" + b.ovr[4:])


def test_no_stub_segments():
    with pytest.raises(FormatError, match="no INT 3Fh"):
        Program(mz(bytes(64)), b"TPOV")


def header_patch(b, field_off: int, fmt: str, value, module: int = 0) -> bytes:
    return patch(b.exe, b.header_size + b.stub_segments[module] * 16 + field_off, struct.pack(fmt, value))


@pytest.mark.parametrize("off,fmt,value,msg", [
    (0x0C, "<H", 0, "entry count is 0"),
    (0x08, "<H", 0, "code size is 0"),
    (0x0A, "<H", 3, "odd fixup table size"),
    (0x0C, "<H", 200, "run past the load image"),
    (0x04, "<I", 1000, "run past the overlay file"),
])
def test_bad_stub_header_fields(off, fmt, value, msg):
    b = simple()
    with pytest.raises(FormatError, match=msg):
        Program(header_patch(b, off, fmt, value), b.ovr)


def test_fixup_outside_code():
    b = build(RETF * 16, [Module(RETF * 4, [0], fixups=[3])])
    with pytest.raises(FormatError, match="fixup offset"):
        Program(b.exe, b.ovr)


@pytest.mark.parametrize("stub", [b"\xcd\x3e\x00\x00\x00", b"\xcd\x3f\x00\x00\x01"])
def test_bad_stub_bytes(stub):
    b = simple()
    with pytest.raises(FormatError, match="expected CD 3F"):
        Program(patch(b.exe, b.header_size + b.stub(0, 1), stub), b.ovr)


def test_entry_offset_past_code():
    b = build(RETF * 16, [Module(RETF * 4, [4])])
    with pytest.raises(FormatError, match="past the code"):
        Program(b.exe, b.ovr)


def three():
    return build(RETF * 16, [Module(RETF, [0]), Module(RETF, [0]), Module(RETF, [0])])


def test_two_chain_heads():
    b = three()
    with pytest.raises(FormatError, match="one first stub segment"):
        Program(header_patch(b, 0x0E, "<H", 0, module=1), b.ovr)


def test_unknown_previous_segment():
    b = three()
    with pytest.raises(FormatError, match="unknown previous segment"):
        Program(header_patch(b, 0x0E, "<H", 0x7777, module=1), b.ovr)


def test_two_successors():
    b = three()
    with pytest.raises(FormatError, match="two successors"):
        Program(header_patch(b, 0x0E, "<H", b.stub_segments[0], module=2), b.ovr)


def test_chain_cycle():
    b = three()
    exe = header_patch(b, 0x0E, "<H", b.stub_segments[2], module=1)
    b2 = type(b)(exe, b.ovr, b.stub_segments, b.header_size)
    with pytest.raises(FormatError, match="chain covers 1 of 3"):
        Program(header_patch(b2, 0x0E, "<H", b.stub_segments[1], module=2), b.ovr)


def test_overlapping_overlay_chunks():
    b = three()
    with pytest.raises(FormatError, match="overlapping or gapped"):
        Program(header_patch(b, 0x04, "<I", 4, module=1), b.ovr)


def test_trailing_overlay_bytes():
    b = simple()
    with pytest.raises(FormatError, match="file has"):
        Program(b.exe, b.ovr + b"\x00")


def test_find_stub_segments_requires_zero_runtime_area():
    img = bytearray(64)
    img[16:20] = b"\xcd\x3f\x00\x00"
    assert find_stub_segments(bytes(img)) == [1]
    img[40] = 1
    assert find_stub_segments(bytes(img)) == []


def test_parse_overlays_direct():
    b = simple()
    blocks = parse_overlays(parse_mz(b.exe), b.ovr)
    assert blocks[0].entries == [(b.stub(0, 0), 0), (b.stub(0, 1), 1)] and blocks[0].stub_table_end == b.stub(0, 2)


def test_segment_bases_ignore_segments_past_the_image():
    root = bytearray(b"\xc3" * 32)
    root[0x10:0x12] = b"\xff\xff"
    root[0x14:0x16] = b"\x01\x00"
    b = build(bytes(root), [Module(RETF, [0])], relocs=[0x10, 0x14])
    p = Program(b.exe, b.ovr)
    assert p.segment_bases() == [0, 0x10] and p.code_base("MAIN_EXE", 0x1F) == 0x10
    assert p.code_base(b.module_id(0), 5) == 0
