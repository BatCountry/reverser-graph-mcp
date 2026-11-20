"""Near jump tables: `jmp word ptr [seg:][bx|si|di + disp]` whose index range the code itself bounds.

The index range comes from a small abstract interpretation of the straight-line path that leads to the
jump (the run of instructions decoded before it, plus the run that branched into it): unsigned
`cmp reg, imm` + `jcc` guards, and register arithmetic the dispatch idioms use (`sub bh, bh`,
`sub bl, 0FAh`, `add bl, bl`, `shl bx, 1`, `and bx, 1Fh`, `mov bx, ax`, `xchg ax, bx`, ...). Where the path
leaves a loop that CX counts (`mov cx, N; ...; loop`), a register every pass moves by the same constant holds
its N values: the search of a value table that ends in `jmp cs:[bx + 2N]`. The table
base is the code segment for a `cs:` override, or the code segment for a DS-relative table when code in
that segment loads DS with its own segment (the DS = CS idiom of resident assembler modules). Every
entry must decode as code in the same space. Anything else stays an unresolved indirect jump.
"""

from __future__ import annotations

import re
import struct
from dataclasses import dataclass, field

from .binary import Program
from .x86 import Decoder, Insn

MAX_ENTRIES = 256
LOOP = 0x12  # Insn.cond of `loop` (E0..E2, loopne/loope/loop, are 10h..12h; they count CX down)
LOOP_TAIL = 16  # instructions looked at, behind a branch, for the `loop` that closes the loop it leaves
BASE_REG = {7: "bx", 4: "si", 5: "di"}
FAMILY = {
    "al": "ax", "ah": "ax", "ax": "ax", "bl": "bx", "bh": "bx", "bx": "bx",
    "cl": "cx", "ch": "cx", "cx": "cx", "dl": "dx", "dh": "dx", "dx": "dx",
    "si": "si", "di": "di", "bp": "bp", "sp": "sp",
}
LOW = {"al", "bl", "cl", "dl"}
HIGH = {"ah", "bh", "ch", "dh"}


@dataclass(frozen=True)
class Range:
    """Values lo, lo + stride, ..., hi (unsigned)."""

    lo: int
    hi: int
    stride: int = 1

    def shifted(self, k: int) -> Range:
        return Range(self.lo + k, self.hi + k, self.stride)

    def doubled(self) -> Range:
        return Range(self.lo * 2, self.hi * 2, self.stride * 2)

    def clamp(self, lo: int, hi: int) -> Range | None:
        """Intersection with [lo, hi], keeping the progression; None when empty."""
        lo, hi = max(lo, self.lo), min(hi, self.hi)
        if hi < lo:
            return None
        lo = self.lo + -(-(lo - self.lo) // self.stride) * self.stride
        hi = self.lo + (hi - self.lo) // self.stride * self.stride
        return Range(lo, hi, self.stride) if lo <= hi else None


@dataclass
class Reg:
    """What is known about one register family (ax/bx/cx/dx: bytes or word; si/di/...: word)."""

    origin: int  # index in the trail of the first instruction this knowledge depends on
    word: Range | None = None
    low: Range | None = None
    high: int | None = None

    def get_word(self) -> Range | None:
        if self.word is not None:
            return self.word
        if self.low is not None and self.high is not None:
            return self.low.shifted(self.high * 256)
        return None

    def get_low(self) -> Range | None:
        if self.low is not None:
            return self.low
        return self.word if self.word is not None and self.word.hi <= 0xFF else None

    def get_high(self) -> int | None:
        if self.high is not None:
            return self.high
        return 0 if self.word is not None and self.word.hi <= 0xFF else None


@dataclass
class JumpTable:
    site: int
    segment: str  # "cs" or "ds"
    offset: int  # table offset as the instruction writes it (displacement)
    index: Range  # byte offsets into the table the jump can use
    targets: list[int] = field(default_factory=list)  # one per entry, in table order
    guard_from: int = 0  # trail index from which the path to the jump must have a single entry
    loops: list[list[Insn]] = field(default_factory=list)  # per counted loop on that path: its leaving branch ... its `loop`
    keys: list[int] = field(default_factory=list)  # per entry, the value the code read through the index register
    key_read: str = ""  # that read: "4688 (word ptr cs:[bx])"

    def describe(self) -> str:
        return (f"jump table {self.segment}:{self.offset:04x}, index {self.index.lo:#x}..{self.index.hi:#x} "
                f"step {self.index.stride} ({len(self.targets)} entries): " + " ".join(f"{t:04x}" for t in self.targets))

    def lines(self) -> list[str]:
        """The table, and which value leads to which entry when the code read the value through the register it then
        jumps through."""
        if not self.keys:
            return [self.describe()]
        width = 2 if "byte" in self.key_read else 4
        return [self.describe(), f"value read at {self.key_read} -> entry: "
                + ", ".join(f"{k:0{width}x} -> {t:04x}" for k, t in zip(self.keys, self.targets))]


def _imm(text: str) -> int | None:
    try:
        return int(text, 0)
    except ValueError:
        return None


def _width(reg: str) -> int:
    return 8 if reg in LOW or reg in HIGH else 16


# unsigned conditions: (taken, fallthrough) as (lo, hi) bounds given the compared immediate k and width max m
_CONSTRAINTS = {
    2: (lambda k, m: (0, k - 1), lambda k, m: (k, m)),  # jb
    3: (lambda k, m: (k, m), lambda k, m: (0, k - 1)),  # jae
    6: (lambda k, m: (0, k), lambda k, m: (k + 1, m)),  # jbe
    7: (lambda k, m: (k + 1, m), lambda k, m: (0, k)),  # ja
    4: (lambda k, m: (k, k), None),  # je
    5: (None, lambda k, m: (k, k)),  # jne
}


class _Interp:
    def __init__(self, dec: Decoder):
        self.dec = dec
        self.regs: dict[str, Reg] = {}
        self.version: dict[str, int] = {}

    def _touch(self, fam: str) -> None:
        self.version[fam] = self.version.get(fam, 0) + 1

    def _forget(self, fam: str) -> None:
        self.regs.pop(fam, None)
        self._touch(fam)

    def read(self, reg: str) -> tuple[Range | None, int]:
        st = self.regs.get(FAMILY[reg])
        if st is None:
            return None, 0
        if reg in LOW:
            return st.get_low(), st.origin
        if reg in HIGH:
            h = st.get_high()
            return (Range(h, h) if h is not None else None), st.origin
        return st.get_word(), st.origin

    def write(self, reg: str, value: Range | None, origin: int) -> None:
        fam = FAMILY[reg]
        self._touch(fam)
        if reg in LOW | HIGH:
            self._write_byte(reg, value, origin)
        elif value is None:
            self.regs.pop(fam, None)
        else:
            self.regs[fam] = Reg(origin, word=value)

    def _write_byte(self, reg: str, value: Range | None, origin: int) -> None:
        fam = FAMILY[reg]
        old = self.regs.get(fam)
        low = old.get_low() if old else None
        high = old.get_high() if old else None
        start = min(origin, old.origin) if old else origin
        if reg in LOW:
            low = value
        else:
            high = value.lo if value is not None and value.lo == value.hi else None
        if low is None and high is None:
            self.regs.pop(fam, None)
        else:
            self.regs[fam] = Reg(start, low=low, high=high)

    def step(self, ins: Insn, i: int) -> None:
        """Abstract effect of `ins` (trail index `i`) on the tracked registers."""
        if ins.kind in ("call", "icall", "int", "fpemu", "exit"):
            for fam in list(self.regs):
                self._forget(fam)  # the callee or handler may change any register
            return
        ops = [o.strip() for o in ins.op_str.split(",")] if ins.op_str else []
        m = ins.mnemonic
        dst = ops[0] if ops and ops[0] in FAMILY else None
        src = ops[1] if len(ops) > 1 else None
        if m in ("sub", "xor") and dst and src == dst:
            self.write(dst, Range(0, 0), i)
            return
        if m == "mov" and dst and src is not None:
            k = _imm(src)
            if k is not None:
                self.write(dst, Range(k, k), i)
                return
            if src in FAMILY and _width(src) == _width(dst):
                value, origin = self.read(src)
                self.write(dst, value, min(origin, i) if value is not None else i)
                return
        if m == "xchg" and dst and src in FAMILY and _width(src) == _width(dst):
            a, oa = self.read(dst)
            b, ob = self.read(src)
            self.write(dst, b, ob if b is not None else i)
            self.write(src, a, oa if a is not None else i)
            return
        if dst and m in ("add", "sub", "shl", "sal", "and", "inc", "dec"):
            cur, origin = self.read(dst)
            top = (1 << _width(dst)) - 1
            new: Range | None = None
            k = _imm(src) if src is not None else None
            if m == "and" and k is not None:
                new = Range(0, min(k, cur.hi) if cur else k)
                origin = origin if cur else i
            elif cur is not None:
                if (m == "add" and src == dst) or (m in ("shl", "sal") and k == 1):
                    new = cur.doubled()
                elif m == "add" and k is not None:
                    new = cur.shifted(k)
                elif m == "sub" and k is not None and cur.lo >= k:
                    new = cur.shifted(-k)
                elif m == "inc":
                    new = cur.shifted(1)
                elif m == "dec" and cur.lo >= 1:
                    new = cur.shifted(-1)
            if new is not None and new.hi > top:
                new = None
            self.write(dst, new, origin if new is not None else i)
            return
        # anything else that writes a register makes it unknown
        for ci in self.dec.csd.disasm(ins.raw, ins.addr, 1):
            _read, written = ci.regs_access()
            for r in written:
                name = ci.reg_name(r)
                if name in FAMILY:
                    self._forget(FAMILY[name])

    def constrain(self, cmp: Insn, cmp_version: int | None, jcc: Insn, direction: str, i: int) -> None:
        """Apply `cmp reg, imm` + `jcc` taken/fallthrough to reg, when reg was not rewritten in between."""
        ops = [o.strip() for o in cmp.op_str.split(",")]
        if len(ops) != 2 or ops[0] not in FAMILY or (k := _imm(ops[1])) is None or jcc.cond not in _CONSTRAINTS:
            return
        reg = ops[0]
        if cmp_version != self.version.get(FAMILY[reg], 0):
            return
        rule = _CONSTRAINTS[jcc.cond][0 if direction == "taken" else 1]
        if rule is None:
            return
        top = (1 << _width(reg)) - 1
        lo, hi = rule(k & top, top)
        cur, origin = self.read(reg)
        base = cur if cur is not None else Range(0, top)
        start = min(origin, i) if cur is not None else i
        self.write(reg, base.clamp(lo, hi), start)

    def loop_head(self, body: list[Insn]) -> None:
        """The state at the first instruction of a loop that `loop` closes, on any of its passes; `body` is the
        loop without that `loop`. With CX = N on entry and untouched by the body there are N passes, and a 16-bit
        register the body only moves by constants (`add bx, 2`, `inc si`) holds start, start + step, ... Every other
        register the body writes is unknown."""
        steps: dict[str, int | None] = {}
        for ins in body:
            ops = [o.strip() for o in ins.op_str.split(",")] if ins.op_str else []
            k = {"inc": 1, "dec": -1}.get(ins.mnemonic)
            if ins.mnemonic in ("add", "sub") and len(ops) == 2 and (n := _imm(ops[1])) is not None:
                k = n if ins.mnemonic == "add" else -n
            if k is not None and ops[0] in FAMILY and _width(ops[0]) == 16 and steps.get(ops[0], 0) is not None:
                steps[ops[0]] = steps.get(ops[0], 0) + k
                continue
            clobbered = self.regs if ins.kind not in ("other", "jcc") else {FAMILY[r] for r in self.dec.writes(ins) if r in FAMILY}
            steps.update(dict.fromkeys(clobbered))
        count, counted = self.read("cx")
        passes = count.lo if count is not None and count.lo == count.hi and "cx" not in steps else 0  # CX = 0 is 65536 passes
        for fam, step in steps.items():
            cur, origin = self.read(fam)
            last = cur.lo + (passes - 1) * step if passes and step is not None and cur is not None and cur.lo == cur.hi else -1
            if step == 0:
                continue
            if 0 <= last <= 0xFFFF:
                self.write(fam, Range(min(cur.lo, last), max(cur.lo, last), abs(step)), min(origin, counted))
            else:
                self._forget(fam)


def _loop_left(dec: Decoder, trail: list[Insn], i: int) -> tuple[int, list[Insn]] | None:
    """If the branch trail[i] leaves a loop closed by `loop`: (trail index of the loop's first instruction, the
    instructions from the branch on to that `loop`). The loop is one straight run, and the trail holds it from its
    first instruction to the branch."""
    ins = trail[i]
    a = ins.end if trail[i + 1].addr == ins.near_target else ins.near_target
    tail = [ins]
    while tail[-1] is ins or tail[-1].cond != LOOP:
        nxt = dec(ins.space, a)
        if nxt is None or len(tail) > LOOP_TAIL or (nxt.kind != "other" and nxt.cond != LOOP):
            return None
        tail.append(nxt)
        a = nxt.end
    head = next((h for h in range(i, -1, -1) if trail[h].addr == tail[-1].near_target), None)
    if head is None or any(p.end != q.addr for p, q in zip(trail[head:i], trail[head + 1 : i + 1])):
        return None
    return head, tail


def index_range(dec: Decoder, trail: list[Insn], reg: str) -> tuple[Range, int, list[list[Insn]]] | None:
    """Range of `reg` at the last instruction of `trail` (the jump), the trail index it depends on, and for every
    counted loop the trail leaves the instructions from the leaving branch to the `loop` (_loop_left)."""
    it = _Interp(dec)
    loops: dict[int, tuple[int, list[Insn]]] = {}  # trail index of a loop's first instruction -> (of its leaving branch, tail)
    for i, ins in enumerate(trail[:-1]):
        if ins.kind == "jcc" and (left := _loop_left(dec, trail, i)) is not None:
            loops[left[0]] = (i, left[1])
    setter: tuple[Insn, int | None, int] | None = None  # (cmp, version of its register then, trail index)
    for i, ins in enumerate(trail[:-1]):
        if i in loops:
            leave, tail = loops[i]
            it.loop_head(trail[i : leave + 1] + tail[1:-1])
            setter = None  # a later pass arrives with the flags of the loop's end
        if ins.kind == "jcc":
            nxt = trail[i + 1].addr
            direction = None
            if nxt == ins.end and nxt != ins.near_target:
                direction = "fallthrough"
            elif nxt == ins.near_target and nxt != ins.end:
                direction = "taken"
            if setter is not None and direction is not None:
                it.constrain(setter[0], setter[1], ins, direction, setter[2])
            if ins.cond in (0x10, 0x11, LOOP):
                it.write("cx", None, i)  # loopne, loope and loop count CX down
            continue
        modified, _tested = dec.flags(ins)
        if modified:
            setter = None
            if ins.mnemonic == "cmp":
                ops = [o.strip() for o in ins.op_str.split(",")]
                fam = FAMILY.get(ops[0]) if ops else None
                setter = (ins, it.version.get(fam, 0) if fam else None, i)
        if ins.mnemonic != "cmp":
            it.step(ins, i)
    value, origin = it.read(reg)
    return (value, origin, [tail for _leave, tail in loops.values()]) if value is not None else None


def _keys(dec: Decoder, data: bytes, base: int, trail: list[Insn], reg: str, index: Range, count: int,
          loops: list[list[Insn]]) -> tuple[list[int], str]:
    """The value per entry that the code read through `reg` (`mov ax, cs:[bx]`, `cmp al, cs:[bx + 1]`) while it held
    the value the jump then uses: what a search loop over a value table compared against. ([], "") if it read none.
    Looked for back to where `reg` was written, and no further than the start of a loop (an earlier pass differs)."""
    heads = {tail[-1].near_target for tail in loops}
    for ins in reversed(trail[:-1]):
        if any(FAMILY.get(r) == reg for r in dec.writes(ins)):
            break
        m = re.search(rf"(byte|word) ptr cs:\[{reg}(?: ([+-]) (\w+))?\]", ins.op_str)
        if m is not None and (ins.mnemonic == "cmp" or (ins.mnemonic == "mov" and not ins.op_str.startswith(m.group(0)))):
            size = 1 if m.group(1) == "byte" else 2
            d = int(m.group(3), 0) * (-1 if m.group(2) == "-" else 1) if m.group(3) else 0
            at = [base + ((d + index.lo + k * index.stride) & 0xFFFF) for k in range(count)]
            if any(a + size > len(data) for a in at):
                break
            return [int.from_bytes(data[a : a + size], "little") for a in at], f"{ins.addr:04x} ({m.group(0)})"
        if ins.addr in heads:
            break
    return [], ""


def resolve(prog: Program, dec: Decoder, ijmp: Insn, trail: list[Insn]) -> JumpTable | str:
    """The jump table behind a near indirect jump, or why it could not be resolved."""
    raw = ijmp.raw
    i, seg = 0, None
    while raw[i] in (0x26, 0x2E, 0x36, 0x3E):
        seg = raw[i]
        i += 1
    if (raw[i + 1] >> 3) & 7 != 4:
        return "far jump through a pointer in memory"
    modrm = raw[i + 1]
    mod, rm = modrm >> 6, modrm & 7
    if mod == 3:
        return "jump through a register"
    if rm not in BASE_REG:
        return "addressing mode is not [bx|si|di + disp]"
    reg = BASE_REG[rm]
    disp = 0 if mod == 0 else struct.unpack_from("<b" if mod == 1 else "<h", raw, i + 2)[0]
    space = prog.spaces[ijmp.space]
    base = prog.code_base(ijmp.space, ijmp.addr)
    if seg == 0x2E:
        segment = "cs"
    elif seg is None or seg == 0x3E:
        if ijmp.space != prog.root or base not in prog.ds_loads():
            return "DS-relative table and DS is not known to equal CS here"
        segment = "ds"
    else:
        return "table addressed through ES or SS"
    found = index_range(dec, trail, reg)
    if found is None:
        return f"index range of {reg} unknown"
    index, origin, loops = found
    if index.stride % 2:
        return f"index {reg} is not a multiple of 2 ({index})"
    count = (index.hi - index.lo) // index.stride + 1
    if count > MAX_ENTRIES:
        return f"{count} entries"
    table = base + ((disp + index.lo) & 0xFFFF)
    targets = []
    for k in range(count):
        at = table + k * index.stride
        if at + 2 > len(space.data):
            return f"table entry {k} at {at:#x} is outside {ijmp.space}"
        t = base + struct.unpack_from("<H", space.data, at)[0]
        if t not in space or (ijmp.space == prog.root and prog.stub_table_of(t)):
            return f"entry {k} target {t:#x} is not code in {ijmp.space}"
        ins = dec(ijmp.space, t)
        if ins is None or ins.kind == "invalid":
            return f"entry {k} target {t:#x} does not decode"
        targets.append(t)
    keys, key_read = _keys(dec, space.data, base, trail, reg, index, count, loops)
    return JumpTable(ijmp.addr, segment, disp & 0xFFFF, index, targets, origin, loops, keys, key_read)
