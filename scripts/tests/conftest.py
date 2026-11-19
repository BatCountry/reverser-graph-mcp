"""Synthetic MZ + Turbo Pascal overlay builders for the dosgraph tests."""

from __future__ import annotations

import struct
import sys
from dataclasses import dataclass, field
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def mz(image: bytes, relocs=(), entry=(0, 0), header_paras: int | None = None) -> bytes:
    """MZ file around `image`; relocs are load-image offsets of segment words; entry is (cs, ip)."""
    crlc = len(relocs)
    paras = header_paras if header_paras is not None else (0x1C + 4 * crlc + 15) // 16
    hdr = bytearray(paras * 16)
    total = paras * 16 + len(image)
    cp, cblp = (total + 511) // 512, total % 512
    struct.pack_into("<2s12H", hdr, 0, b"MZ", cblp, cp, crlc, paras, 0, 0xFFFF, 0, 0, 0, entry[1], entry[0], 0x1C)
    for i, pos in enumerate(relocs):
        struct.pack_into("<HH", hdr, 0x1C + 4 * i, pos & 0xF, pos >> 4)
    return bytes(hdr) + image


@dataclass
class Module:
    code: bytes
    payloads: list[int]
    fixups: list[int] = field(default_factory=list)


@dataclass
class Built:
    exe: bytes
    ovr: bytes
    stub_segments: list[int]
    header_size: int

    def stub(self, module: int, index: int) -> int:
        """Load-image offset of stub `index` of module `module`."""
        return self.stub_segments[module] * 16 + 0x20 + 5 * index

    def module_id(self, module: int) -> str:
        """Space of overlay `module`: the .OVR file name and the overlay's stub segment."""
        return f"MAIN_OVR-{self.stub_segments[module]:04x}"


def build(root: bytes, modules: list[Module], relocs=(), entry=(0, 0), ovr_format: bytes = b"TPOV") -> Built:
    """Root code at load-image offset 0, then one stub segment per module (chained), and the .OVR (TP 5.x `TPOV`, or
    TP 6.0 `FBOV` + dword size of the rest)."""
    image = bytearray(root)
    ovr = bytearray(ovr_format + (bytes(4) if ovr_format == b"FBOV" else b""))
    segs: list[int] = []
    prev = 0
    for m in modules:
        while len(image) % 16:
            image.append(0x90)
        seg = len(image) // 16
        hdr = bytearray(32)
        hdr[0:2] = b"\xcd\x3f"
        struct.pack_into("<IHHHH", hdr, 4, len(ovr), len(m.code), 2 * len(m.fixups), len(m.payloads), prev)
        image += hdr
        for p in m.payloads:
            image += b"\xcd\x3f" + struct.pack("<H", p) + b"\x00"
        ovr += m.code + b"".join(struct.pack("<H", f) for f in m.fixups)
        prev = seg
        segs.append(seg)
    if ovr_format == b"FBOV":
        struct.pack_into("<I", ovr, 4, len(ovr) - 8)
    exe = mz(bytes(image), relocs=relocs, entry=entry)
    return Built(exe, bytes(ovr), segs, (0x1C + 4 * len(relocs) + 15) // 16 * 16)


EXEPACK_STUB = b"\x90" * 5 + b"\xcd\x21\xb8\xff\x4c\xcd\x21" + b"Packed file is corrupt"


def exepack_stream(image: bytes) -> bytes:
    """Raw prefix + commands that rebuild `image` in place (read backwards by the unpacker): runs of 6+ equal bytes as
    fills, the rest copied; the first chunk in output order carries the end flag, as it is read last. As EXEPACK does,
    the shortest prefix is left uncompressed that keeps every command's writes above the commands still unread."""
    for prefix in range(len(image) + 1):
        stream = _commands(image[prefix:])
        src, dst = prefix + len(stream), len(image)
        safe = True
        for kind, length in reversed(_chunk_sizes(image[prefix:])):
            src -= (4 if kind == "fill" else 3 + length)
            dst -= length
            safe = safe and dst >= src
        if safe:
            return image[:prefix] + stream
    raise AssertionError("unreachable: the whole image as prefix is always safe")


def _chunks(image: bytes) -> list[tuple[str, bytes]]:
    chunks: list[tuple[str, bytes]] = []
    i = 0
    while i < len(image):
        j = i
        while j < len(image) and image[j] == image[i] and j - i < 0xFFFF:
            j += 1
        if j - i >= 6:
            chunks.append(("fill", image[i:j]))
            i = j
            continue
        if chunks and chunks[-1][0] == "copy" and len(chunks[-1][1]) < 0xFFFF:
            chunks[-1] = ("copy", chunks[-1][1] + image[i : i + 1])
        else:
            chunks.append(("copy", image[i : i + 1]))
        i += 1
    return chunks


def _chunk_sizes(image: bytes) -> list[tuple[str, int]]:
    return [(kind, len(data)) for kind, data in _chunks(image)]


def _commands(image: bytes) -> bytes:
    out = bytearray()
    for n, (kind, data) in enumerate(_chunks(image)):
        last = 1 if n == 0 else 0
        if kind == "fill":
            out += bytes([data[0]]) + struct.pack("<H", len(data)) + bytes([0xB0 | last])
        else:
            out += data + struct.pack("<H", len(data)) + bytes([0xB2 | last])
    return bytes(out)


def exepack(image: bytes, relocs=(), entry=(0, 0), header_size: int = 18, skip_len: int = 1, *, stream: bytes | None = None,
            table: bytes | None = None, stub: bytes = EXEPACK_STUB, dest_len: int | None = None,
            exepack_size: int | None = None, header_relocs=()) -> bytes:
    """An EXEPACK-packed MZ file whose unpacked load image is `image` (zero-padded to a paragraph), with relocations
    `relocs` (unpacked load-image offsets) and real entry (cs, ip). Keyword arguments replace parts to build broken files."""
    image = image + bytes(-len(image) % 16)
    data = exepack_stream(image) if stream is None else stream
    data += b"\xff" * (-len(data) % 16)
    if table is None:
        table = b"".join(struct.pack("<H", len(offs)) + b"".join(struct.pack("<H", o) for o in offs)
                         for offs in ([r & 0xFFFF for r in relocs if r >> 16 == s] for s in range(16)))
    skip = 16 * max(0, skip_len - 1)
    cs = (len(data) + skip) // 16
    dest = len(image) // 16 + skip_len - 1 if dest_len is None else dest_len
    size = header_size + len(stub) + len(table) if exepack_size is None else exepack_size
    fields = [entry[1], entry[0], 0, size] + ([0] if header_size == 20 else []) + [0x80, 0, dest]
    fields += [skip_len] if header_size >= 18 else []
    header = struct.pack(f"<{len(fields)}H", *fields) + b"RB"
    body = data + bytes(skip) + header + stub + table
    return mz(body, relocs=header_relocs, entry=(cs, header_size))


@dataclass
class Section:
    load: int
    code: bytes
    paragraphs: int | None = None  # memory; default: the code's paragraphs
    parent: int | None = None
    fixups: list[tuple[int, int]] = field(default_factory=list)  # (seg, off), program-absolute seg
    data: bool = False


def rtlink(root: bytes, sections: list[Section], stubs: list[tuple[int, int, int]], *, table_at: int = 0x100,
           stubs_at: int = 0x200, manager: int = 0x40, truncate: int = 0, header_relocs=(), entries=None) -> bytes:
    """An RTLink/Plus MZ: `root` code at image 0, the section table (count, 2 words, 18-byte entries) at `table_at`,
    10-byte stubs `(section index, seg, off)` at `stubs_at` calling `manager`, `.RTLink` text, and the sections appended
    (fixup table padded to a paragraph, then the code padded to one; the last cut short by `truncate` bytes).
    `entries` replaces the table words to build broken files."""
    image = bytearray(root.ljust(0x300, b"\x90"))
    image += b".RTLink(R)/Plus\x00"
    image += bytes(-len(image) % 16)
    for i, (k, seg, off) in enumerate(stubs):
        p = stubs_at + 10 * i
        image[p : p + 10] = b"\xe8" + struct.pack("<h", manager - (p + 3)) + b"\xea" + struct.pack("<HHH", off, seg, k)
    exe_len = len(mz(bytes(image), relocs=header_relocs))
    pos = (exe_len + 15) // 16 * 16
    words, body = [], b""
    for s in sections:
        fix = b"".join(struct.pack("<HH", off, seg) for seg, off in s.fixups)
        fix += bytes(-len(fix) % 16)
        code = s.code + bytes(-len(s.code) % 16)
        fparas = len(code) // 16
        words.append([s.load, 0x0FBF, pos // 16, 0x0100 if s.data else 0x0400, s.paragraphs or fparas, len(s.fixups),
                      0xFFFF if s.parent is None else s.parent, 0, fparas])
        body += fix + code
        pos += len(fix) + len(code)
    rows = words if entries is None else entries
    for k, w in enumerate(rows):
        struct.pack_into("<9H", image, table_at + 18 * k, *w)
    struct.pack_into("<3H", image, table_at - 6, len(rows), 0, 0)
    exe = mz(bytes(image), relocs=header_relocs)
    return exe + bytes((exe_len + 15) // 16 * 16 - exe_len) + body[: len(body) - truncate]


@dataclass
class Overlay:
    load: int  # paragraph its code is loaded at
    code: bytes
    fixups: list[tuple[int, int]] = field(default_factory=list)  # (seg, off), seg counted from the program's load segment
    segments: list[int] | None = None  # base segments of its code segments; default: the load segment alone


def overlay_call(segment: int, off: int) -> bytes:
    """`int 3Fh; db segment number; dw offset`: how Microsoft LINK writes a far call into an overlay."""
    return b"\xcd\x3f" + bytes([segment]) + struct.pack("<H", off)


def link_overlays(root: bytes, overlays: list[Overlay], *, size: int = 0x200, table_at: int = 0x100, relocs=(), entry=(0, 0),
                  rows=None, counts=None, relocated=None, numbers=None, tail: bytes = b"", packed: bool = False) -> bytes:
    """A program linked with Microsoft LINK overlays: `root` code at image 0 (zero-filled to `size`), the segment table
    at `table_at` (`dw segments; dw overlays`, a base word per segment, an overlay byte per segment; segment 0 is the
    root at base 0, then come each overlay's segments), and every overlay as an MZ image of its own on the next
    512-byte page (header word 1Ah = its number, relocation entries `off, seg`). `packed`: the root is EXEPACK-packed.
    `rows` ((overlay, base) per segment), `counts` (the two size words), `relocated` (which base words are relocated),
    `numbers` and `tail` replace parts to build broken files."""
    image = bytearray(root.ljust(size, b"\x00"))
    if rows is None:
        rows = [(0, 0)] + [(k, base) for k, o in enumerate(overlays, 1) for base in (o.segments or [o.load])]
    struct.pack_into("<HH", image, table_at, *(counts or (len(rows), len(overlays) + 1)))
    for g, (owner, base) in enumerate(rows):
        struct.pack_into("<H", image, table_at + 4 + 2 * g, base)
        image[table_at + 4 + 2 * len(rows) + g] = owner
    marks = [*relocs, *(table_at + 4 + 2 * g for g in (range(len(rows)) if relocated is None else relocated))]
    out = exepack(bytes(image), relocs=marks, entry=entry) if packed else mz(bytes(image), relocs=marks, entry=entry)
    for k, o in enumerate(overlays):
        out += bytes(-len(out) % 512)
        paras = (0x1C + 4 * len(o.fixups) + 15) // 16
        total = paras * 16 + len(o.code)
        hdr = bytearray(paras * 16)
        struct.pack_into("<2s13H", hdr, 0, b"MZ", total % 512, (total + 511) // 512, len(o.fixups), paras, 0, 0xFFFF, 0, 0, 0, 0, 0,
                         0x1C, numbers[k] if numbers else k + 1)
        for i, (seg, off) in enumerate(o.fixups):
            struct.pack_into("<HH", hdr, 0x1C + 4 * i, off, seg)
        out += bytes(hdr) + o.code
    return out + tail


def patch(data: bytes, pos: int, new: bytes) -> bytes:
    return data[:pos] + new + data[pos + len(new) :]


def rel16(site: int, size: int, target: int) -> bytes:
    return struct.pack("<h", target - (site + size))


def call(site: int, target: int) -> bytes:
    return b"\xe8" + rel16(site, 3, target)


def jmp(site: int, target: int) -> bytes:
    return b"\xe9" + rel16(site, 3, target)


DOS_EXIT = b"\xb4\x4c\xcd\x21"  # mov ah, 4Ch; int 21h
RETF = b"\xcb"
