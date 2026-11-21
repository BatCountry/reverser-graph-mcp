"""16-bit x86 decoding (capstone) and control-transfer classification from the raw bytes."""

from __future__ import annotations

import struct
from dataclasses import dataclass

from capstone import CS_AC_READ, CS_AC_WRITE, CS_ARCH_X86, CS_MODE_16, Cs
from capstone import x86_const as X

from .binary import OVERLAY_TRAP, Program, nid

PREFIXES = {0x26, 0x2E, 0x36, 0x3E, 0x64, 0x65, 0x66, 0x67, 0xF0, 0xF2, 0xF3}
NON_8086_PREFIXES = {0x64, 0x65, 0x66, 0x67}
NON_8086_OPCODES = {0x0F, 0x60, 0x61, 0x62, 0x63, 0x68, 0x69, 0x6A, 0x6B, 0x6C, 0x6D, 0x6E, 0x6F, 0xC0, 0xC1, 0xC8, 0xC9}
MEM_ACCESS = {CS_AC_READ: "reads", CS_AC_WRITE: "writes", CS_AC_READ | CS_AC_WRITE: "reads and writes"}
PRINTABLE = set(range(0x20, 0x7F))


@dataclass
class Insn:
    space: str
    addr: int
    size: int
    raw: bytes
    mnemonic: str
    op_str: str
    # call | jmp | jcc | ret | icall | ijmp | int | exit | invalid | fpemu | other
    kind: str
    cond: int | None = None
    near_target: int | None = None  # same-space target before stub resolution
    far: tuple[int, int] | None = None  # (segment, offset) as encoded (unrelocated)
    far_relocated: bool | None = None
    overlay: tuple[int, int] | None = None  # Microsoft LINK overlay call: (segment number, offset) after `int 3Fh`
    non8086: bool = False

    @property
    def text(self) -> str:
        return f"{self.mnemonic} {self.op_str}".strip()

    @property
    def bytes_text(self) -> str:
        return f"{self.raw.hex()} {self.text}"

    @property
    def end(self) -> int:
        return self.addr + self.size


def modrm_len(data: bytes, pos: int) -> int:
    if pos >= len(data):
        return 1
    m = data[pos]
    mod, rm = m >> 6, m & 7
    if mod == 0:
        return 3 if rm == 6 else 1
    if mod == 1:
        return 2
    if mod == 2:
        return 3
    return 1


def _flag_masks() -> tuple[dict[str, int], dict[str, int]]:
    modify, test = {}, {}
    for flag in ("AF", "CF", "DF", "IF", "NT", "OF", "PF", "RF", "SF", "TF", "ZF"):
        m = 0
        for kind in ("MODIFY", "RESET", "SET", "UNDEFINED"):
            m |= getattr(X, f"X86_EFLAGS_{kind}_{flag}", 0)
        modify[flag] = m
        test[flag] = getattr(X, f"X86_EFLAGS_TEST_{flag}", 0)
    return modify, test


FLAG_MODIFY, FLAG_TEST = _flag_masks()


class Decoder:
    """Decodes and caches instructions of every space of a Program."""

    def __init__(self, prog: Program):
        self.prog = prog
        self.cs = Cs(CS_ARCH_X86, CS_MODE_16)
        self.csd = Cs(CS_ARCH_X86, CS_MODE_16)
        self.csd.detail = True
        self.cache: dict[tuple[str, int], Insn | None] = {}
        self._flags: dict[tuple[str, int], tuple[int, int]] = {}
        self._writes: dict[tuple[str, int], frozenset[str]] = {}

    def __call__(self, space: str, addr: int) -> Insn | None:
        key = (space, addr)
        if key not in self.cache:
            self.cache[key] = self._decode(space, addr)
        return self.cache[key]

    def _decode(self, space: str, addr: int) -> Insn | None:
        sp = self.prog.spaces[space]
        data = sp.data
        if addr not in sp:
            return None
        # Microsoft LINK overlay call: `int 3Fh; db segment number; dw offset`, a far call through the overlay manager.
        if self.prog.link_segments and data[addr : addr + 2] == OVERLAY_TRAP:
            raw = data[addr : addr + 5]
            if len(raw) < 5:
                return Insn(space, addr, len(raw), raw, "(bad)", "", "invalid")
            number, off = raw[2], int.from_bytes(raw[3:], "little")
            return Insn(space, addr, 5, raw, "int", f"0x3f  ; overlay call: segment {number}, offset {off:#x}", "call",
                        overlay=(number, off))
        # Borland 8087 emulator: INT 34h..3Bh stand for WAIT+ESC D8..DF and are followed by the operand bytes.
        if data[addr] == 0xCD and addr + 1 < len(data) and 0x34 <= data[addr + 1] <= 0x3E:
            n = data[addr + 1]
            if n <= 0x3B:
                size = 2 + modrm_len(data, addr + 2)
            elif n == 0x3C:  # segment-override form: CD 3C <esc|seg> modrm
                size = 3 + modrm_len(data, addr + 3)
            elif n == 0x3D:  # FWAIT
                size = 2
            else:  # 3E: CD 3E xx
                size = 3
            raw = data[addr : addr + size]
            if len(raw) < size:
                return Insn(space, addr, len(raw), raw, "(bad)", "", "invalid")
            ops = f"{n:#x}" + (f"  ; 8087 emulator, operand bytes {raw[2:].hex()}" if size > 2 else "")
            return Insn(space, addr, size, raw, "int", ops, "fpemu")
        for ci in self.cs.disasm(data[addr : addr + 16], addr, 1):
            ins = Insn(space, addr, ci.size, bytes(ci.bytes), ci.mnemonic, ci.op_str, "other")
            classify(ins, sp.relocated_words, self.prog.root)
            return ins
        return Insn(space, addr, 1, data[addr : addr + 1], "(bad)", "", "invalid")

    def flags(self, ins: Insn) -> tuple[int, int]:
        """(modified-flags mask, tested-flags mask) of an instruction, capstone semantics."""
        key = (ins.space, ins.addr)
        if key not in self._flags:
            mod = tst = 0
            for ci in self.csd.disasm(ins.raw, ins.addr, 1):
                ef = ci.eflags
                mod = sum(1 << i for i, f in enumerate(FLAG_MODIFY) if ef & FLAG_MODIFY[f])
                tst = sum(1 << i for i, f in enumerate(FLAG_TEST) if ef & FLAG_TEST[f])
            self._flags[key] = (mod, tst)
        return self._flags[key]

    def writes(self, ins: Insn) -> frozenset[str]:
        """Registers an instruction writes, capstone semantics (FLAGS and IP left out)."""
        key = (ins.space, ins.addr)
        if key not in self._writes:
            regs: set[str] = set()
            for ci in self.csd.disasm(ins.raw, ins.addr, 1):
                regs = {ci.reg_name(r) for r in ci.regs_access()[1]} - {"flags", "ip"}
            self._writes[key] = frozenset(regs)
        return self._writes[key]

    def mem_access(self, ins: Insn) -> list[str]:
        """What an instruction does with each of its memory operands, in operand order: "reads", "writes" or "reads
        and writes" (capstone semantics); "calls through", "jumps through" and "takes the address of" where that is
        all it does with the operand (an indirect call or jump, `lea`)."""
        if ins.kind in ("icall", "ijmp"):
            return ["calls through" if ins.kind == "icall" else "jumps through"]
        return ["takes the address of" if ins.mnemonic == "lea" else MEM_ACCESS.get(op.access, "uses")
                for ci in self.csd.disasm(ins.raw, ins.addr, 1) for op in ci.operands if op.type == X.X86_OP_MEM]


def classify(ins: Insn, relocated_words: set[int], root_space: str) -> None:
    raw = ins.raw
    i = 0
    while i < len(raw) and raw[i] in PREFIXES:
        if raw[i] in NON_8086_PREFIXES:
            ins.non8086 = True
        i += 1
    op = raw[i]  # capstone never returns a prefix-only instruction
    nxt = ins.addr + ins.size

    def near(rel: int) -> int:
        if ins.space == root_space:
            return nxt + rel  # load-image offset; all code segments start at or below the instruction
        return (nxt + rel) & 0xFFFF

    if 0x70 <= op <= 0x7F:
        ins.kind, ins.cond = "jcc", op - 0x70
        ins.near_target = near(struct.unpack_from("<b", raw, i + 1)[0])
    elif 0xE0 <= op <= 0xE3:
        ins.kind, ins.cond = "jcc", 0x10 + (op - 0xE0)
        ins.near_target = near(struct.unpack_from("<b", raw, i + 1)[0])
    elif op == 0x0F and i + 1 < len(raw) and 0x80 <= raw[i + 1] <= 0x8F:
        ins.kind, ins.cond, ins.non8086 = "jcc", raw[i + 1] - 0x80, True
        ins.near_target = near(struct.unpack_from("<h", raw, i + 2)[0])
    elif op == 0xEB:
        ins.kind = "jmp"
        ins.near_target = near(struct.unpack_from("<b", raw, i + 1)[0])
    elif op == 0xE9:
        ins.kind = "jmp"
        ins.near_target = near(struct.unpack_from("<h", raw, i + 1)[0])
    elif op == 0xE8:
        ins.kind = "call"
        ins.near_target = near(struct.unpack_from("<h", raw, i + 1)[0])
    elif op in (0x9A, 0xEA):
        ins.kind = "call" if op == 0x9A else "jmp"
        off, seg = struct.unpack_from("<HH", raw, i + 1)
        ins.far = (seg, off)
        ins.far_relocated = (ins.addr + i + 3) in relocated_words
    elif op in (0xC2, 0xC3, 0xCA, 0xCB, 0xCF):
        ins.kind = "ret"
    elif op == 0xFF and i + 1 < len(raw):
        reg = (raw[i + 1] >> 3) & 7
        if reg in (2, 3):
            ins.kind = "icall"
        elif reg in (4, 5):
            ins.kind = "ijmp"
    elif op == 0xCD:
        ins.kind = "exit" if raw[i + 1] == 0x20 else "int"
    elif op in NON_8086_OPCODES:
        # 186+/386 opcodes; on an 8086 0F is POP CS and 60-6F alias the short jcc range.
        ins.non8086 = True


def target_of(prog: Program, ins: Insn) -> tuple[str | None, str]:
    """Resolved node id of a direct transfer (INT 3Fh stubs and overlay calls followed) and how it was resolved."""
    if ins.overlay is not None:
        return prog.overlay_call(*ins.overlay)
    if ins.far is not None:
        seg, off = ins.far
        if not ins.far_relocated:
            return None, f"far segment word at {ins.addr + ins.size - 2:#x} is not relocated (absolute {seg:#x}:{off:#x})"
        return prog.resolve_far(seg, off, ins.space)
    if ins.near_target is None:
        return None, "no static target"
    if ins.space == prog.root:
        return prog.resolve_root_linear(ins.near_target)
    return nid(ins.space, ins.near_target), "near"


def is_push(ins: Insn) -> bool:
    r = ins.raw
    return (
        0x50 <= r[0] <= 0x57
        or r[0] in (0x06, 0x0E, 0x16, 0x1E, 0x68, 0x6A)
        or (r[0] == 0xFF and len(r) > 1 and (r[1] >> 3) & 7 == 6)
    )


def is_retf_dispatch(ins: Insn, prev: list[Insn]) -> bool:
    """`push cs; push <ret>; push <seg>; push <off>; retf`: a far call through a pointer, not a return."""
    pushes = prev[-4:]
    return (
        ins.raw[-1:] == b"\xcb"
        and len(pushes) == 4
        and all(is_push(p) for p in pushes)
        and any(p.raw == b"\x0e" for p in pushes)
    )


def is_dos_exit(ins: Insn, prev: list[Insn]) -> bool:
    """INT 21h with AH=4Ch or AH=00h set by one of the preceding instructions on the same path."""
    if ins.raw[-2:] != b"\xcd\x21":
        return False
    for p in reversed(prev[-4:]):
        r = p.raw
        if r[:1] == b"\xb4":  # mov ah, imm8
            return r[1] in (0x4C, 0x00)
        if r[:1] == b"\xb8":  # mov ax, imm16
            return r[2] in (0x4C, 0x00)
    return False


def pointer_immediate(ins: Insn) -> int | None:
    """imm16 of `mov r16, imm16`, `mov r/m16, imm16` or `push imm16` (candidate code pointer)."""
    raw = ins.raw
    i = 0
    while i < len(raw) and raw[i] in PREFIXES:
        i += 1
    op = raw[i]  # capstone never returns a prefix-only instruction
    if 0xB8 <= op <= 0xBF or op == 0x68:
        return struct.unpack_from("<H", raw, i + 1)[0]
    if op == 0xC7 and (raw[i + 1] >> 3) & 7 == 0:
        return struct.unpack_from("<H", raw, len(raw) - 2)[0]
    return None


def pascal_string_at(data: bytes, p: int) -> bool:
    n = data[p] if p < len(data) else 0
    return n >= 1 and p + 1 + n <= len(data) and all(b in PRINTABLE for b in data[p + 1 : p + 1 + n])
