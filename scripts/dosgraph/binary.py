"""MZ executable and Turbo Pascal INT 3Fh overlay parsing.

Everything is derived from the bytes: the MZ header (load image, relocations, entry point; an EXEPACK-packed image
is unpacked first, see exepack.py) and the overlay stub segments inside the load image.  A stub segment is a
paragraph-aligned block

    +00 CD 3F       INT 3Fh (overlay manager trap)
    +02 dw 0        saved return offset (zero on disk)
    +04 dd          offset of the module's code in the .OVR file
    +08 dw          code size
    +0A dw          fixup table size (bytes, one word per relocated segment word)
    +0C dw          entry (stub) count
    +0E dw          previous stub segment (unrelocated paragraph), 0 for the first one
    +10 16 x 00     runtime state, zero on disk
    +20 n x 5 bytes CD 3F dw <offset in module code> 00

and the .OVR file is a header followed by every module's code+fixups in chain order: Turbo Pascal 5.x writes the
signature `TPOV`, Turbo Pascal 6.0 writes `FBOV` and a dword holding the size of everything after those 8 bytes.
Anything that does not match this layout raises FormatError instead of being guessed at.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass, field, replace

from . import exepack
from .errors import FormatError

STUB_HEADER_SIZE = 0x20
STUB_SIZE = 5
# overlay file signature -> header size (TP 5.x: signature only; TP 6.0: signature + dword size of the rest)
OVR_HEADERS = {b"TPOV": 4, b"FBOV": 8}
SENTINEL_PAYLOAD = 0xFFFF


def file_space(file_name: str) -> str:
    """Name of the address space holding a file's code: the file name, upper case, `.` -> `_` (MAIN.EXE ->
    MAIN_EXE), so ids say which file the bytes are in and read as names, not paths."""
    return file_name.upper().replace(".", "_")


def nid(space: str, addr: int) -> str:
    return f"{space}:{addr:04x}"


def split_id(node_id: str) -> tuple[str, int]:
    space, _, off = node_id.rpartition(":")
    return space, int(off, 16)


@dataclass
class MZImage:
    """A file's code as it sits in memory: `image[a]` is the byte at offset `a` of the segment it is loaded at."""

    file_base: int | None  # file offset of image byte 0 (negative for a .COM); None for an unpacked image
    image: bytes
    relocations: set[int]  # image offsets of relocated segment words
    entry: int  # image offset execution starts at (the real entry point of a packed program)
    layout: str = "MZ"  # "MZ", "MZ unpacked from EXEPACK", "COM" or "module"
    appended: int = 0  # bytes after the MZ load image (data the program may read; not code unless an overlay manager claims it)


COM_ORIGIN = 0x100  # DOS loads a .COM after its 256-byte PSP, at offset 100h of the segment, and starts there
COM_MAX = 0x10000 - COM_ORIGIN - 2  # the file, the PSP and a 2-byte stack must fit one segment
# Signature of the RTLink/Plus overlay manager: overlays appended to the EXE, not parsed yet
RTLINK_SIGNATURE = b".RTLink"


def parse_mz(data: bytes) -> MZImage:
    if len(data) < 0x1C:
        raise FormatError(f"truncated MZ header: {len(data)} bytes, need at least 28")
    if data[:2] not in (b"MZ", b"ZM"):
        raise FormatError(f"bad MZ signature {data[:2]!r}")
    (cblp, cp, crlc, cparhdr, _minalloc, _maxalloc, _ss, _sp, _csum, ip, cs, lfarlc) = struct.unpack_from(
        "<12H", data, 2
    )
    hdr = cparhdr * 16
    if cp == 0 or cblp >= 512:
        raise FormatError(f"invalid MZ page counts (pages={cp}, last page bytes={cblp})")
    end = cp * 512 - ((512 - cblp) if cblp else 0)
    if hdr < 0x1C or hdr > end:
        raise FormatError(f"MZ header size {hdr} outside 28..{end}")
    if end > len(data):
        raise FormatError(f"truncated MZ file: header declares {end} bytes, file has {len(data)}")
    if lfarlc + 4 * crlc > hdr:
        raise FormatError(f"MZ relocation table ({crlc} entries at {lfarlc:#x}) runs past the header ({hdr:#x})")
    image = data[hdr:end]
    relocs = set()
    for i in range(crlc):
        off, seg = struct.unpack_from("<HH", data, lfarlc + 4 * i)
        pos = seg * 16 + off
        if pos + 2 > len(image):
            raise FormatError(f"MZ relocation {i} ({seg:#06x}:{off:#06x}) points past the load image")
        relocs.add(pos)
    if exepack.is_exepack(image, cs, ip):
        u = exepack.unpack(image, cs, ip, crlc)
        return MZImage(None, u.image, u.relocations, u.entry, "MZ unpacked from EXEPACK", len(data) - end)
    entry = cs * 16 + ip
    if entry >= len(image):
        raise FormatError(f"MZ entry point {cs:#06x}:{ip:#06x} outside the load image ({len(image)} bytes)")
    return MZImage(hdr, image, relocs, entry, "MZ", len(data) - end)


LAYOUTS = ("COM", "module")


def load_executable(data: bytes, name: str, layout: str | None = None) -> MZImage:
    """A file as it is loaded: anything starting `MZ`/`ZM` by its MZ header (DOS ignores the extension); else a
    `.COM` at offset 100h (image offset = address the code uses; the PSP below it reads as zeros; a sound driver
    that a loader program reads and far-calls is linked for 100h too: its jump table holds 100h-based case
    addresses); else a module some program reads into memory at offset 0 (e.g. a `.DRV`). `layout` ("COM" or
    "module") overrides the extension for code a program loads from a data file (game.py: loaded_modules.json)."""
    if layout is not None and layout not in LAYOUTS:
        raise FormatError(f"{name}: layout {layout!r} is not one of {', '.join(LAYOUTS)}")
    if data[:2] in (b"MZ", b"ZM") and layout is None:
        return parse_mz(data)
    if not data:
        raise FormatError(f"{name}: empty file")
    if layout == "COM" or (layout is None and name.upper().endswith(".COM")):
        if len(data) > COM_MAX:
            raise FormatError(f"{name}: {len(data)} bytes, more than a .COM can hold ({COM_MAX})")
        return MZImage(-COM_ORIGIN, bytes(COM_ORIGIN) + data, set(), COM_ORIGIN, "COM")
    return MZImage(0, data, set(), 0, "module")


def jump_table(image: bytes) -> list[int]:
    """Offsets of the `jmp near` (E9 rel16) instructions running back to back from offset 0 of a module: the entry
    table a driver exports (callers far-call slot k at offset 3k)."""
    slots = []
    while len(slots) * 3 + 3 <= len(image) and image[len(slots) * 3] == 0xE9:
        slots.append(len(slots) * 3)
    return slots


# ------------------------------------------------------------------ RTLink/Plus (Pocket Soft) overlays
#
# Checked on two RTLink/Plus programs. The overlay sections are appended to the EXE after the load image; the
# loader (the MZ entry) reads a table in its own segment: a count word, two more words, then per section 9 words:
#   load segment, ?, file paragraph, flags (0400h code, 0100h data), memory paragraphs, fixup count,
#   parent section (FFFFh: none), ordinal, file paragraphs
# Each section is, from its file paragraph: the fixup table (count x `dw off, seg`; seg program-absolute, so the
# word at section offset (seg - load)*16 + off is relocated), padded to a paragraph, then its bytes. Sections tile
# the appended data in table order (the last may end inside its final paragraph, at the end of the file). Sections
# with one load segment overwrite each other; a child loads above its parent, which stays loaded. Calls into a
# section go through 10-byte stubs in the resident image: `call <manager>; jmp far seg:off; dw section index`.

RTLINK_HEADER_WORDS = 3  # count, then two words, then the table
RTLINK_ENTRY = 18
RTLINK_STUB = 10
RTLINK_CODE, RTLINK_DATA = 0x0400, 0x0100
NO_PARENT = 0xFFFF


@dataclass
class RTSection:
    index: int
    name: str  # TOOL_EXE-0003: the program's file and the section index its stubs carry
    load: int  # unrelocated paragraph the section is loaded at
    paragraphs: int  # memory it occupies
    parent: int | None
    code: bytes  # the section's bytes as in the file (offset 0 = load:0000)
    file_offset: int
    fixups: set[int]  # section offsets of relocated segment words
    data: bool  # flags 0100h: the data segment, not code

    def holds(self, lin: int) -> bool:
        return self.load * 16 <= lin < (self.load + self.paragraphs) * 16


def _rtlink_sections(data: bytes, mz: MZImage, table: int, n: int, root: str) -> list[RTSection] | None:
    """The sections the table at image offset `table` describes, or None if they do not tile the appended data."""
    end = mz.file_base + len(mz.image)
    pos = (end + 15) // 16 * 16
    out: list[RTSection] = []
    for k in range(n):
        load, _x, fpar, flags, paras, nfix, parent, _ordinal, fparas = struct.unpack_from("<9H", mz.image, table + RTLINK_ENTRY * k)
        start = fpar * 16
        code_at = start + (4 * nfix + 15) // 16 * 16
        stop = code_at + fparas * 16
        if start != pos or flags not in (RTLINK_CODE, RTLINK_DATA) or fparas > paras or stop - 15 > len(data):
            return None
        if parent != NO_PARENT and parent >= k:
            return None
        fixups = set()
        for i in range(nfix):
            off, seg = struct.unpack_from("<HH", data, start + 4 * i)
            at = (seg - load) * 16 + off
            if not 0 <= at <= fparas * 16 - 2:
                return None
            fixups.add(at)
        code = data[code_at : min(stop, len(data))]
        out.append(RTSection(k, f"{root}-{k:04x}", load, paras, None if parent == NO_PARENT else parent, code, code_at, fixups,
                             flags == RTLINK_DATA))
        pos = stop
    return out if pos - 15 <= len(data) <= pos else None


def parse_rtlink(data: bytes, mz: MZImage, root: str) -> tuple[list[RTSection], dict[int, tuple[str, int]], tuple[int, int]]:
    """Sections, stubs (image offset -> (section space, offset in it)) and the stub table's image range."""
    if mz.file_base is None or not mz.appended:
        raise FormatError(f"{root}: RTLink/Plus program without overlay sections appended to its load image")
    first = (mz.file_base + len(mz.image) + 15) // 16  # section 0's file paragraph
    found = []
    for t in range(2 * RTLINK_HEADER_WORDS, len(mz.image) - RTLINK_ENTRY + 1):
        if struct.unpack_from("<H", mz.image, t + 4)[0] != first:
            continue
        n = struct.unpack_from("<H", mz.image, t - 2 * RTLINK_HEADER_WORDS)[0]
        if n and t + RTLINK_ENTRY * n <= len(mz.image) and (secs := _rtlink_sections(data, mz, t, n, root)) is not None:
            found.append(secs)
    if len(found) != 1:
        raise FormatError(f"{root}: {len(found)} RTLink/Plus section tables tile the appended data, need exactly one")
    sections = found[0]
    img = mz.image
    runs: list[list[tuple[int, int, str, int]]] = []
    for p in range(len(img) - RTLINK_STUB + 1):
        if img[p] != 0xE8 or img[p + 3] != 0xEA:
            continue
        manager = (p + 3 + struct.unpack_from("<h", img, p + 1)[0]) & 0xFFFF
        off, seg, k = struct.unpack_from("<HHH", img, p + 4)
        if k >= len(sections) or sections[k].data or not sections[k].holds(seg * 16 + off):
            continue
        at = (seg - sections[k].load) * 16 + off
        if at >= len(sections[k].code):
            continue
        stub = (p, manager, sections[k].name, at)
        if runs and runs[-1][-1][0] == p - RTLINK_STUB and runs[-1][-1][1] == manager:
            runs[-1].append(stub)
        else:
            runs.append([stub])
    runs.sort(key=len, reverse=True)
    if not runs or (len(runs) > 1 and len(runs[1]) > 1):
        raise FormatError(f"{root}: expected one run of RTLink/Plus stubs, found {len(runs)} "
                          f"(lengths {[len(r) for r in runs[:4]]})")
    stubs = {p: (name, at) for p, _m, name, at in runs[0]}
    return sections, stubs, (runs[0][0][0], runs[0][-1][0] + RTLINK_STUB)


@dataclass
class OverlayBlock:
    name: str
    stub_segment: int  # unrelocated paragraph of the stub segment in the load image
    ovr_offset: int
    code: bytes
    fixups: list[int]
    previous_segment: int
    entries: list[tuple[int, int]] = field(default_factory=list)  # (stub image offset, payload)
    sentinels: list[tuple[int, int]] = field(default_factory=list)

    @property
    def stub_table_end(self) -> int:
        return self.stub_segment * 16 + STUB_HEADER_SIZE + STUB_SIZE * (len(self.entries) + len(self.sentinels))


def _looks_like_stub_header(image: bytes, p: int) -> bool:
    return (
        image[p : p + 4] == b"\xcd\x3f\x00\x00"
        and p + STUB_HEADER_SIZE <= len(image)
        and image[p + 0x10 : p + 0x20] == bytes(16)
    )


def find_stub_segments(image: bytes) -> list[int]:
    """Paragraphs whose bytes carry the INT 3Fh stub-segment signature."""
    return [p // 16 for p in range(0, len(image) - STUB_HEADER_SIZE + 1, 16) if _looks_like_stub_header(image, p)]


def parse_overlays(mz: MZImage, ovr: bytes, ovr_name: str = "MAIN.OVR") -> list[OverlayBlock]:
    image = mz.image
    header = OVR_HEADERS.get(ovr[:4])
    if header is None:
        raise FormatError(f"overlay file signature {ovr[:4]!r} is not one of {sorted(OVR_HEADERS)} (not a Turbo Pascal .OVR)")
    if header == 8 and (len(ovr) < 8 or struct.unpack_from("<I", ovr, 4)[0] != len(ovr) - 8):
        size = struct.unpack_from("<I", ovr, 4)[0] if len(ovr) >= 8 else None
        raise FormatError(f"FBOV overlay file declares {size!r} bytes after its 8-byte header, has {max(0, len(ovr) - 8)}")
    segs = find_stub_segments(image)
    if not segs:
        raise FormatError("no INT 3Fh overlay stub segments found in the load image")
    blocks: dict[int, OverlayBlock] = {}
    for seg in segs:
        p = seg * 16
        ovr_off, code_size, fix_size, n, prev = struct.unpack_from("<IHHHH", image, p + 4)
        where = f"stub segment {seg:#06x}"
        if n == 0:
            raise FormatError(f"{where}: entry count is 0")
        if code_size == 0:
            raise FormatError(f"{where}: code size is 0")
        if fix_size % 2:
            raise FormatError(f"{where}: odd fixup table size {fix_size}")
        if p + STUB_HEADER_SIZE + STUB_SIZE * n > len(image):
            raise FormatError(f"{where}: {n} stubs run past the load image")
        if ovr_off + code_size + fix_size > len(ovr):
            raise FormatError(f"{where}: code/fixups ({ovr_off:#x}+{code_size}+{fix_size}) run past the overlay file")
        code = ovr[ovr_off : ovr_off + code_size]
        fixups = [w for (w,) in struct.iter_unpack("<H", ovr[ovr_off + code_size : ovr_off + code_size + fix_size])]
        for w in fixups:
            if w + 2 > code_size:
                raise FormatError(f"{where}: fixup offset {w:#x} outside code ({code_size} bytes)")
        blk = OverlayBlock(f"{file_space(ovr_name)}-{seg:04x}", seg, ovr_off, code, fixups, prev)
        for i in range(n):
            sp = p + STUB_HEADER_SIZE + STUB_SIZE * i
            raw = image[sp : sp + STUB_SIZE]
            if raw[:2] != b"\xcd\x3f" or raw[4] != 0:
                raise FormatError(f"{where}: stub {i} at {sp:#x} is {raw.hex()}, expected CD 3F <offset> 00")
            payload = struct.unpack_from("<H", raw, 2)[0]
            if payload == SENTINEL_PAYLOAD:
                blk.sentinels.append((sp, payload))
            elif payload >= code_size:
                raise FormatError(f"{where}: stub {i} entry offset {payload:#x} is past the code ({code_size} bytes)")
            else:
                blk.entries.append((sp, payload))
        blocks[seg] = blk

    # The stub segments form one backward-linked chain; the .OVR holds their code in chain order.
    heads = [s for s, b in blocks.items() if b.previous_segment == 0]
    if len(heads) != 1:
        raise FormatError(f"expected one first stub segment (previous=0), found {len(heads)}: {[hex(s) for s in heads]}")
    succ: dict[int, int] = {}
    for s, b in blocks.items():
        if b.previous_segment == 0:
            continue
        if b.previous_segment not in blocks:
            raise FormatError(f"stub segment {s:#06x} links to unknown previous segment {b.previous_segment:#06x}")
        if b.previous_segment in succ:
            raise FormatError(f"stub segment {b.previous_segment:#06x} has two successors")
        succ[b.previous_segment] = s
    order = [heads[0]]
    while order[-1] in succ:
        order.append(succ[order[-1]])
    if len(order) != len(blocks):
        raise FormatError(f"stub segment chain covers {len(order)} of {len(blocks)} segments")
    pos = header
    for s in order:
        b = blocks[s]
        if b.ovr_offset != pos:
            raise FormatError(
                f"{b.name}: code at overlay offset {b.ovr_offset:#x}, expected {pos:#x} (blocks must tile the .OVR "
                "in chain order; overlapping or gapped chunks)"
            )
        pos += len(b.code) + 2 * len(b.fixups)
    if pos != len(ovr):
        raise FormatError(f"overlay blocks end at {pos:#x}, file has {len(ovr):#x} bytes")
    return [blocks[s] for s in order]


@dataclass
class Space:
    name: str
    data: bytes
    source_file: str
    file_base: int | None  # file offset of byte 0 of the space; None for an unpacked image (no file position)
    relocated_words: set[int]
    origin: int = 0  # lowest address holding the file's bytes (100h for a .COM: below it is the PSP, never code)

    def __contains__(self, addr: int) -> bool:
        return self.origin <= addr < len(self.data)


@dataclass
class Stub:
    image_addr: int
    block: str
    payload: int


class Program:
    """Address spaces of one executable file (MZ, .COM or loaded module) plus its overlays: an INT 3Fh overlay file,
    or RTLink/Plus sections appended to the EXE."""

    def __init__(self, exe: bytes, ovr: bytes | None = None, exe_name: str = "MAIN.EXE", ovr_name: str | None = "MAIN.OVR",
                 layout: str | None = None, in_file: bool = True, loaded_from: str | None = None):
        """Spaces: the load image is `MAIN_EXE` (offsets in the image), each overlay `MAIN_OVR-0020` (named by
        its stub segment, the segment callers write in `lcall 0x20, <stub entry>`; offsets inside its code).
        `layout`: see load_executable. `in_file=False`: the bytes were unpacked from a container (a record of a data file), so
        they have no file offset. `loaded_from`: how a program obtains this code at run time (loaded.py)."""
        self.exe_name = exe_name.upper()
        self.loaded_from = loaded_from
        self.mz = load_executable(exe, self.exe_name, layout)
        if not in_file:
            self.mz = replace(self.mz, file_base=None)
        if ovr is None:
            stubs = find_stub_segments(self.mz.image) if self.mz.layout.startswith("MZ") else []
            if stubs:
                raise FormatError(f"{self.exe_name} has {len(stubs)} INT 3Fh overlay stub segments but no overlay file was given for it")
            self.blocks: list[OverlayBlock] = []
            self.ovr_name: str | None = None
        else:
            self.ovr_name = (ovr_name or "MAIN.OVR").upper()
            self.blocks = parse_overlays(self.mz, ovr, self.ovr_name)
        self.root = file_space(self.exe_name)
        self.image = self.mz.image
        self.spaces: dict[str, Space] = {
            self.root: Space(self.root, self.image, self.exe_name, self.mz.file_base, set(self.mz.relocations),
                             COM_ORIGIN if self.mz.layout == "COM" else 0)
        }
        self.stubs: dict[int, Stub] = {}
        self.sentinel_stubs: dict[int, Stub] = {}
        self.stub_ranges: list[tuple[int, int, str]] = []
        for b in self.blocks:
            self.spaces[b.name] = Space(b.name, b.code, self.ovr_name, b.ovr_offset, set(b.fixups))
            for sp, payload in b.entries:
                self.stubs[sp] = Stub(sp, b.name, payload)
            for sp, payload in b.sentinels:
                self.sentinel_stubs[sp] = Stub(sp, b.name, payload)
            self.stub_ranges.append((b.stub_segment * 16, b.stub_table_end, b.name))
        self.sections: dict[str, RTSection] = {}
        self.section_list: list[RTSection] = []
        self._section_bases: dict[str, list[int]] = {}
        self.rt_stubs: dict[int, tuple[str, int]] = {}
        if self.mz.layout == "MZ" and RTLINK_SIGNATURE in self.image:
            self.section_list, rt_stubs, (start, end) = parse_rtlink(exe, self.mz, self.root)
            for s in self.section_list:
                if not s.data:
                    self.sections[s.name] = s
                    self.spaces[s.name] = Space(s.name, s.code, self.exe_name, s.file_offset, s.fixups)
                    words = (struct.unpack_from("<H", s.code, p)[0] for p in s.fixups if p + 2 <= len(s.code))
                    self._section_bases[s.name] = sorted({0} | {(w - s.load) * 16 for w in words if s.load <= w < s.load + s.paragraphs})
            self.rt_stubs = rt_stubs
            for sp, (name, at) in rt_stubs.items():
                self.stubs[sp] = Stub(sp, name, at)
            self.stub_ranges.append((start, end, f"{self.root} RTLink stub table"))
        self.stub_ranges.sort()
        self._segment_bases: list[int] | None = None
        self._ds_loads: set[int] | None = None

    @property
    def entry_id(self) -> str:
        return nid(self.root, self.mz.entry)

    def overlay_entry_ids(self) -> list[str]:
        return sorted({nid(st.block, st.payload) for st in self.stubs.values()})

    def module_entry_ids(self) -> list[str]:
        """A loaded module's exported entries: the slots of its leading jump table (offset 0 is the entry anyway)."""
        return [nid(self.root, s) for s in jump_table(self.image)] if self.mz.layout == "module" else []

    def stub_table_of(self, lin: int) -> str | None:
        for start, end, name in self.stub_ranges:
            if start <= lin < end:
                return name
            if start > lin:
                break
        return None

    def resolve_root_linear(self, lin: int) -> tuple[str | None, str]:
        """Node id of a load-image offset, following INT 3Fh stubs into their module."""
        if lin in self.stubs:
            st = self.stubs[lin]
            return nid(st.block, st.payload), f"stub {nid(self.root, lin)} -> {st.block}:{st.payload:04x}"
        if lin in self.sentinel_stubs:
            st = self.sentinel_stubs[lin]
            return None, f"stub {nid(self.root, lin)} of {st.block} is a sentinel (payload {st.payload:#x})"
        blk = self.stub_table_of(lin)
        if blk:
            return None, f"inside {blk} stub segment but not on an entry stub ({lin:#x})"
        if 0 <= lin < len(self.image):
            return nid(self.root, lin), "root"
        return None, f"far target {lin:#x} outside load image"

    def resolve_far(self, seg: int, off: int, space: str | None = None) -> tuple[str | None, str]:
        """A direct far target. From code in an RTLink section: that section, then its ancestors (loaded with it).
        Otherwise the one section whose load area holds the address (several sections sharing that area: None, it
        depends on which is loaded), else the resident image."""
        lin = seg * 16 + off
        if self.section_list:
            chain = []
            sec = self.sections.get(space) if space else None
            while sec is not None:
                chain.append(sec)
                sec = self.section_list[sec.parent] if sec.parent is not None else None
            for s in chain:
                if s.holds(lin):
                    return self._in_section(s, lin)
            if lin >= len(self.image):
                holders = [s for s in self.sections.values() if s.holds(lin)]
                if len(holders) == 1:
                    return self._in_section(holders[0], lin)
                if holders:
                    return None, f"far target {lin:#x} is in the load area of {len(holders)} overlay sections"
        return self.resolve_root_linear(lin)

    def _in_section(self, s: RTSection, lin: int) -> tuple[str | None, str]:
        at = lin - s.load * 16
        if at >= len(s.code):
            return None, f"far target {lin:#x} is past the code of {s.name}"
        return nid(s.name, at), f"in {s.name}"

    def segment_bases(self) -> list[int]:
        """Linear bases of every load-image segment named by a relocated segment word."""
        if self._segment_bases is None:
            segs = {0}
            for sp in self.spaces.values():
                for p in sp.relocated_words:
                    seg = struct.unpack_from("<H", sp.data, p)[0]
                    if seg * 16 < len(self.image):
                        segs.add(seg * 16)
            self._segment_bases = sorted(segs)
        return self._segment_bases

    def code_base(self, space: str, addr: int) -> int:
        """Offset (in its space) of the segment code at `addr` runs in: the nearest relocated segment base at or
        below it (an approximation: segments are only known from relocations); in an RTLink section the same over
        the section's own segments; 0 inside a Turbo Pascal overlay."""
        if space == self.root:
            return max(b for b in self.segment_bases() if b <= addr)
        bases = self._section_bases.get(space)
        return 0 if bases is None else max(b for b in bases if b <= addr)

    def ds_loads(self) -> set[int]:
        """Linear bases of the segments resident code loads into DS: `mov r16, SEG; mov ds, r16` with
        the SEG word relocated (B8+r imm16, then 8E D8+r)."""
        if self._ds_loads is None:
            img, relocated = self.image, self.spaces[self.root].relocated_words
            self._ds_loads = {
                struct.unpack_from("<H", img, p + 1)[0] * 16
                for p in range(len(img) - 4)
                if 0xB8 <= img[p] <= 0xBF and img[p + 3] == 0x8E and img[p + 4] == 0xD8 + img[p] - 0xB8 and p + 1 in relocated
            }
        return self._ds_loads

    def aliases(self) -> dict[str, str]:
        out: dict[str, str] = {}
        for b in self.blocks:
            for sp, payload in b.entries:
                target = nid(b.name, payload)
                out[f"{b.stub_segment:04x}:{sp - b.stub_segment * 16:04x}"] = target
                out[nid(self.root, sp)] = target
        for sp, (name, at) in self.rt_stubs.items():
            out[nid(self.root, sp)] = nid(name, at)
        return out
