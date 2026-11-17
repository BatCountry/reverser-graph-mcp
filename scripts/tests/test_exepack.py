import struct

import pytest
from conftest import RETF, Module, build, exepack, exepack_stream

from dosgraph.binary import Program, parse_mz
from dosgraph.emit import build_graph
from dosgraph.errors import FormatError
from dosgraph.exepack import is_exepack
from dosgraph.flow import analyze
from dosgraph.x86 import Decoder

# an image with code, a long zero run (fills) and a relocated word at 0x12 and in the second 64K segment
IMAGE = b"\x55\x89\xe5\xb8\x34\x12\x9a\x00\x00\x00\x00" + b"\x90" * 7 + b"\x02\x00" + bytes(0x200) + b"\x5d\xcb" + bytes(0x10000)
RELOCS = [0x12, 0x10010]


def unpacked(data: bytes) -> bytes:
    return parse_mz(data).image


@pytest.mark.parametrize("header_size,skip_len", [(16, 1), (18, 1), (18, 3), (20, 1), (20, 2)])
def test_round_trip(header_size, skip_len):
    m = parse_mz(exepack(IMAGE, RELOCS, entry=(0, 0), header_size=header_size, skip_len=skip_len))
    padded = IMAGE + bytes(-len(IMAGE) % 16)
    assert m.layout == "MZ unpacked from EXEPACK" and m.file_base is None
    assert m.image == padded and m.relocations == set(RELOCS) and m.entry == 0


def test_real_entry_point_is_cs_ip_of_the_unpacked_image():
    assert parse_mz(exepack(IMAGE, entry=(0x20, 0x1))).entry == 0x201


def test_packed_program_with_overlays_has_no_file_offsets_for_unpacked_code():
    b = build(RETF * 16, [Module(b"\x55\xcb", [0])])
    image = parse_mz(b.exe).image
    p = Program(exepack(image + b"\x90" * 64), b.ovr)
    assert p.spaces["MAIN_EXE"].file_base is None and p.spaces[b.module_id(0)].file_base == 4
    dec = Decoder(p)
    g = build_graph(p, dec, analyze(p, dec, stop_on_fallthrough=True))
    assert g["nodes"]["MAIN_EXE:0000"]["file_offset"] is None
    assert g["nodes"][f"{b.module_id(0)}:0000"]["file_offset"] == 4


@pytest.mark.parametrize("ip,signature,fits", [(18, b"RB", True), (16, b"RB", True), (20, b"RB", True), (17, b"RB", True),
                                               (18, b"RC", True), (18, b"RB", False), (0, b"RB", True)])
def test_detection(ip, signature, fits):
    image = bytes(0x20) + bytes(ip - 2 if ip >= 2 else 0) + signature
    cs = 2 if fits else 3
    assert is_exepack(image, cs, ip) == (ip in (16, 18, 20) and signature == b"RB" and fits)


def test_without_the_signature_it_is_an_ordinary_program():
    data = bytearray(exepack(IMAGE))
    header = struct.unpack_from("<H", data, 8)[0] * 16 + struct.unpack_from("<H", data, 0x16)[0] * 16
    assert data[header + 16 : header + 18] == b"RB"
    data[header + 16 : header + 18] = b"XX"  # an ordinary program whose entry is CS:12h
    m = parse_mz(bytes(data))
    assert m.layout == "MZ" and m.file_base is not None


def broken(**kw):
    return exepack(IMAGE, RELOCS, **kw)


@pytest.mark.parametrize("data,message", [
    (lambda: broken(header_relocs=[0]), "MZ header has 1 relocations"),
    (lambda: broken(skip_len=0), "skip_len 0 must be"),
    (lambda: broken(skip_len=2, dest_len=0), "skip_len 2 must be 1..1"),
    (lambda: broken(exepack_size=10), "exepack_size 0xa does not fit"),
    (lambda: broken(exepack_size=0xFFFF), "exepack_size 0xffff does not fit"),
    (lambda: broken(stub=b"\x90" * 40), "no decompression stub error exit"),
    (lambda: broken(table=b""), r"runs past exepack_size .* \(segment 0000\)"),
    (lambda: broken(table=b"\x05\x00\x12\x00"), "5 relocations for segment 0000 run past"),
    (lambda: broken(table=bytes(30) + b"\x01\x00\x00\x00"), "relocation f000:0000 is outside the unpacked image"),
    (lambda: exepack(b"\x90" * 16, [0x1000E]), "relocation 1000:000e is outside the unpacked image"),
    (lambda: exepack(b"\x90" * 16, [0xF]), "relocation 0000:000f is outside the unpacked image"),
    (lambda: broken(table=bytes(32) + b"\x00\x00"), "packed relocation table ends at"),
    (lambda: broken(stream=b"\x01\x00\xb4"), "command 0xb4 .* is neither fill"),
    (lambda: broken(stream=b"\x00\xb1"), "needs 2 more byte"),
    (lambda: broken(stream=b"\xff" * 16), "needs 1 more byte.* command"),
    (lambda: exepack(bytes(16), stream=b"\x00\xff\xff\xb1", dest_len=1), "writes 65535 bytes before the start"),
    (lambda: broken(stream=b"\x10\x00\xb1"), "needs 1 more byte.* fill byte"),
    (lambda: broken(stream=b"\x10\x00\xb3"), "needs 16 more byte.* copied bytes"),
    (lambda: exepack(bytes(64), entry=(0x10, 0)), r"real entry point 0010:0000 is outside"),
])
def test_corrupt_packed_files_are_rejected(data, message):
    with pytest.raises(FormatError, match=message):
        parse_mz(data())


def test_decompression_chains_commands_and_stops_at_the_flagged_one():
    image = b"\x00" * 202 + b"ABCDEF"  # a fill, then a copy (208 bytes: whole paragraphs): needs no uncompressed prefix
    stream = exepack_stream(image)
    # read backwards: the copy (B2h) first, the flagged fill (B1h) last
    assert stream == b"\x00" + struct.pack("<H", 202) + b"\xb1" + b"ABCDEF" + struct.pack("<H", 6) + b"\xb2"
    assert unpacked(exepack(image)) == image


def test_bytes_before_the_first_command_stay_as_they_are():
    # one command rebuilding only the last 16 bytes: the 16-byte prefix stays in place, as EXEPACK leaves its
    # uncompressed prefix
    out = unpacked(exepack(bytes(32), stream=b"\xab" * 16 + bytes(12) + b"\x07\x10\x00\xb1", dest_len=2))
    assert out == b"\xab" * 16 + b"\x07" * 16


@pytest.mark.parametrize("fmt", [b"TPOV", b"FBOV"])
def test_overlay_file_formats(fmt):
    b = build(RETF * 16, [Module(b"\x55\xcb", [0, 1]), Module(RETF * 3, [2])], ovr_format=fmt)
    p = Program(b.exe, b.ovr)
    first = 4 if fmt == b"TPOV" else 8
    assert [blk.ovr_offset for blk in p.blocks] == [first, first + 2]


@pytest.mark.parametrize("ovr,message", [
    (b"FBOV\x00", "declares None bytes after its 8-byte header, has 0"),
    (b"FBOV" + struct.pack("<I", 99) + RETF * 2, "declares 99 bytes after its 8-byte header, has 2"),
    (b"XXOV" + bytes(8), r"is not one of \[b'FBOV', b'TPOV'\]"),
])
def test_bad_overlay_headers(ovr, message):
    b = build(RETF * 16, [Module(RETF * 2, [0])])
    with pytest.raises(FormatError, match=message):
        Program(b.exe, ovr)
