"""Microsoft EXEPACK: recognise a packed MZ load image and rebuild the program it unpacks to.

Layout and algorithm as documented by David Fifield (https://www.bamsoftware.com/software/exepack/):

    load image offset 0      compressed data (runs backwards, ends in 0..15 FFh padding bytes)
                             optional skip_len padding
    CS:0000                  EXEPACK header, IP bytes (16, 18 or 20), ending in "RB"
    CS:IP                    decompression stub, ending in  int 21h; mov ax, 4CFFh; int 21h  + a 22-byte message
                             packed relocation table: for segments 0000, 1000, ... F000 a count word and that many
                             offset words
    CS:exepack_size          (end of the EXEPACK block)

Header words: real_ip, real_cs, mem_start (scratch), exepack_size, [unused, 20-byte form only], real_sp, real_ss,
dest_len (paragraphs unpacked), [skip_len, 18/20-byte forms; 1 otherwise], "RB". The compressed data is
16*(CS - skip_len + 1) bytes, the unpacked image 16*(dest_len - skip_len + 1). Decompression works in place from
the end: skip FFh padding, then commands read backwards (command byte, length word, and for B0h/B1h a fill byte):
B0h/B1h write `length` copies of the fill byte, B2h/B3h copy `length` bytes; an odd command is the last one.
Anything else raises FormatError: a packed file is never half-unpacked.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass

from .errors import FormatError

SIGNATURE = b"RB"
HEADER_SIZES = (16, 18, 20)
# int 21h; mov ax, 4CFFh; int 21h: the stub's error exit, followed by its 22-byte "Packed file is corrupt" message
STUB_TAIL = b"\xcd\x21\xb8\xff\x4c\xcd\x21"
MESSAGE_LEN = 22


@dataclass
class Unpacked:
    image: bytes
    relocations: set[int]  # unpacked load-image offsets of relocated segment words
    entry: int  # unpacked load-image offset of the real CS:IP


def is_exepack(image: bytes, cs: int, ip: int) -> bool:
    """An EXEPACK header sits at CS:0, is IP bytes long, and ends in "RB"."""
    start = cs * 16
    return ip in HEADER_SIZES and start + ip <= len(image) and image[start + ip - 2 : start + ip] == SIGNATURE


def _decompress(buf: bytearray, src: int, dst: int) -> None:
    def take(n: int, what: str) -> int:
        nonlocal src
        if src < n:
            raise FormatError(f"EXEPACK data ends inside a command (needs {n} more byte(s) for the {what})")
        src -= n
        return src

    while src > 0 and buf[src - 1] == 0xFF:
        src -= 1
    while True:
        command = buf[take(1, "command")]
        length = struct.unpack_from("<H", buf, take(2, "length"))[0]
        if command & 0xFE not in (0xB0, 0xB2):
            raise FormatError(f"EXEPACK command {command:#04x} at compressed offset {src + 2:#x} is neither fill (B0h/B1h) nor copy (B2h/B3h)")
        if length > dst:
            raise FormatError(f"EXEPACK command {command:#04x} writes {length} bytes before the start of the unpacked image")
        if command & 0xFE == 0xB0:
            fill = buf[take(1, "fill byte")]
            buf[dst - length : dst] = bytes([fill]) * length
        else:
            take(length, "copied bytes")
            # backwards, byte by byte, as the stub does: source and destination may overlap
            for i in range(1, length + 1):
                buf[dst - i] = buf[src + length - i]
        dst -= length
        if command & 1:
            return


def unpack(image: bytes, cs: int, ip: int, header_relocations: int) -> Unpacked:
    """Unpack the program in `image` (the packed load image) whose MZ entry point CS:IP is an EXEPACK header."""
    start = cs * 16
    header = image[start : start + ip]
    real_ip, real_cs, _mem_start, exepack_size = struct.unpack_from("<4H", header)
    rest = header[10 if ip == 20 else 8 : -2]
    _real_sp, _real_ss, dest_len = struct.unpack_from("<3H", rest)
    skip_len = struct.unpack_from("<H", rest, 6)[0] if ip >= 18 else 1
    where = f"EXEPACK header at {cs:04x}:0000"
    if header_relocations:
        raise FormatError(f"{where}: the MZ header has {header_relocations} relocations; EXEPACK keeps them all in its own table")
    if skip_len == 0 or skip_len - 1 > cs or skip_len - 1 > dest_len:
        raise FormatError(f"{where}: skip_len {skip_len} must be 1..{min(cs, dest_len) + 1}")
    if exepack_size < ip or start + exepack_size > len(image):
        raise FormatError(f"{where}: exepack_size {exepack_size:#x} does not fit the image ({len(image) - start:#x} bytes from CS:0, header {ip})")
    block = image[start : start + exepack_size]
    tail = block.find(STUB_TAIL, ip)
    if tail < 0:
        raise FormatError(f"{where}: no decompression stub error exit (int 21h; mov ax, 4CFFh; int 21h) inside the EXEPACK block")
    pos = tail + len(STUB_TAIL) + MESSAGE_LEN
    compressed_size = 16 * (cs - skip_len + 1)
    unpacked_size = 16 * (dest_len - skip_len + 1)
    relocations: set[int] = set()
    for segment in range(16):
        if pos + 2 > exepack_size:
            raise FormatError(f"{where}: packed relocation table runs past exepack_size {exepack_size:#x} (segment {segment:x}000)")
        (count,) = struct.unpack_from("<H", block, pos)
        pos += 2
        if pos + 2 * count > exepack_size:
            raise FormatError(f"{where}: {count} relocations for segment {segment:x}000 run past exepack_size {exepack_size:#x}")
        for (offset,) in struct.iter_unpack("<H", block[pos : pos + 2 * count]):
            linear = segment * 0x10000 + offset
            if linear + 2 > unpacked_size:
                raise FormatError(f"{where}: relocation {segment:x}000:{offset:04x} is outside the unpacked image ({unpacked_size:#x} bytes)")
            relocations.add(linear)
        pos += 2 * count
    if pos != exepack_size:
        raise FormatError(f"{where}: packed relocation table ends at {pos:#x}, exepack_size says {exepack_size:#x}")
    buf = bytearray(image[:compressed_size])
    buf.extend(bytes(max(0, unpacked_size - len(buf))))
    _decompress(buf, compressed_size, unpacked_size)
    unpacked = bytes(buf[:unpacked_size])
    entry = real_cs * 16 + real_ip
    if entry >= len(unpacked):
        raise FormatError(f"{where}: real entry point {real_cs:04x}:{real_ip:04x} is outside the unpacked image ({len(unpacked):#x} bytes)")
    return Unpacked(unpacked, relocations, entry)
