"""Constant pointers: where code builds them, where it keeps them, and the indirect calls and jumps through them.

Every function is walked in address order. An instruction starts from what its only predecessor knew; a merge
point, or a jump target reached from further down, starts from nothing. The walk tracks the 16-bit registers,
DS, ES and the words pushed on the current straight-line run, holding:

* `Const`: an immediate (`mov ax, 34h`, `xor ax, ax`) and the site that loaded it;
* `Seg`: a segment: a relocated immediate word, CS, or DGROUP (what DS holds on entry to compiled code);
* `Word`: the word read from a memory location (`mov ax, [437Ah]`);
* `PtrLo` / `PtrHi`: the halves of a far pointer read with `les`/`lds` (a record base plus an offset);
* `Vec`: the old interrupt vector INT 21h/35h returns in ES:BX.

A far pointer is recorded (`PointerLoad`) wherever the code puts one: stored as a dword (offset word, segment
word above it), stored into a record through a pointer, pushed as an argument (segment, then offset), handed to
DOS as DS:DX for INT 21h/25h, or pushed for a `retf`. Every word store is recorded with what was stored, and
every indirect call or jump through memory or a register, and every `retf` dispatch, is recorded as a `Use`.
`resolve()` connects each use to the constant pointers stored where it reads: proof that the target is code. The
load image counts as a store where the linker left a far pointer (a relocated segment word behind an offset word),
and a near call through a table in its own segment that no code fills reads the table from the bytes (`code_table`).
"""

from __future__ import annotations

import collections
import math
import re
import struct
from dataclasses import dataclass, field

from .binary import Program, nid, split_id
from .x86 import Decoder, Insn, target_of

R16 = ("ax", "cx", "dx", "bx", "sp", "bp", "si", "di")
R8 = {"al": "ax", "ah": "ax", "cl": "cx", "ch": "cx", "dl": "dx", "dh": "dx", "bl": "bx", "bh": "bx"}
READ_ONLY = {"cmp", "test", "push", "call", "lcall", "jmp", "ljmp"}
DGROUP = ("dgroup",)
NUM = re.compile(r"^-?(?:0x[0-9a-f]+|\d+)$")
MEM = re.compile(r"^(?:(?:(\w+) )?ptr )?(?:([cdefgs]s):)?\[([^\]]+)\]$")  # any operand size (`xword ptr`), any segment
TERM = re.compile(r"([+-]?)\s*([a-z]{2}|0x[0-9a-f]+|\d+)")
TABLE_SPAN = 256  # entries a table run may have
ALT_MAX = 8  # alternatives a merged value may hold before it becomes unknown
WORLDS = 8  # distinct states an instruction may see (one per way in) before they are joined
MAX_PASSES = 64  # dataflow passes per function; values only ever widen, so this is never reached


# --------------------------------------------------------------------------
# Values
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class Const:
    n: int
    site: str


@dataclass(frozen=True)
class Seg:
    key: tuple  # ("para", n) | ("space", name, segment base in the space) | DGROUP
    site: str


@dataclass(frozen=True)
class Word:
    loc: tuple  # ("abs", segkey, addr)
    site: str


@dataclass(frozen=True)
class PtrLo:
    token: tuple  # ("abs", segkey, addr) the pointer was read from, or ("site", id) for a stack/indexed read
    k: int
    site: str


@dataclass(frozen=True)
class PtrHi:
    token: tuple
    site: str


@dataclass(frozen=True)
class Vec:
    n: int  # interrupt number
    part: str  # "off" | "seg"
    site: str


@dataclass(frozen=True)
class Alt:
    """One of a few constants or segments: the paths into a merge loaded different ones."""
    options: frozenset


def members(v, cls) -> list:
    """`v` itself when it is a `cls`, the `cls` options of an `Alt`, else nothing."""
    if isinstance(v, cls):
        return [v]
    if isinstance(v, Alt):
        return sorted((o for o in v.options if isinstance(o, cls)), key=repr)
    return []


def pairs(hi, lo) -> list[tuple[Seg, Const]]:
    """Every far pointer a (segment word, offset word) pair can hold."""
    return [(s, o) for s in members(hi, Seg) for o in members(lo, Const)]


def merge(vals: list):
    """The value a merge point holds: the common value, else the few constants/segments the paths loaded."""
    first = vals[0]
    if all(v == first for v in vals[1:]):
        return first
    opts: set = set()
    for v in vals:
        if isinstance(v, Alt):
            opts |= v.options
        elif isinstance(v, (Const, Seg)):
            opts.add(v)
        else:
            return None
    distinct = {o.n if isinstance(o, Const) else o.key for o in opts}  # one value loaded at several sites counts once
    return Alt(frozenset(opts)) if len(distinct) <= ALT_MAX else None


# --------------------------------------------------------------------------
# Facts
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class MemRef:
    size: str | None
    seg: str | None  # explicit override
    regs: tuple[str, ...]
    disp: int


@dataclass(frozen=True)
class PointerLoad:
    where: tuple  # ("abs", segkey, addr) | ("field", k, token) | ("arg", callee) | ("vector", n) | ("retf",)
    seg: tuple
    off: int
    site: str  # the instruction completing the pointer
    off_site: str  # the instruction that loaded the offset
    target: str | None


@dataclass(frozen=True)
class Store:
    where: tuple  # ("abs", segkey, addr) | ("field", k, token) | ("indexed", segkey, disp)
    value: object  # None when the stored word is unknown
    site: str


@dataclass(frozen=True)
class Use:
    fid: str
    ins: Insn
    far: bool
    where: tuple | None  # ("abs", ...) | ("indexed", ...) | ("field", k, token) | ("stack", hi, lo) | ("reg", value) | None
    through: str


@dataclass(frozen=True)
class DataRef:
    """One instruction naming a memory location by its address: `mov [4f2ah], ax`, `call word ptr cs:[bx + 10h]`."""

    seg: tuple | None  # segment key; None: the segment register's value is not known at the site
    register: str  # the segment register the instruction reads through
    off: int  # the address; of an indexed operand, its displacement (the table's base)
    indexed: bool
    access: str  # Decoder.mem_access, or "takes the address of" for a far pointer the code builds
    fid: str
    site: str
    text: str


@dataclass(frozen=True)
class FrameRef:
    """One instruction naming a stack slot relative to BP: `mov [bp - 6], ax`, `lea di, [bp - 20h]`."""

    fid: str
    addr: int
    slot: int  # signed displacement from BP
    indexed: bool  # another register is added: `[bp + si - 20h]`
    access: str  # Decoder.mem_access


@dataclass
class Facts:
    loads: list[PointerLoad] = field(default_factory=list)
    stores: list[Store] = field(default_factory=list)
    uses: list[Use] = field(default_factory=list)
    vectors: list[tuple[str, int | None, str]] = field(default_factory=list)  # (target, interrupt if constant, site)
    ints: list[tuple[str, int, int | None]] = field(default_factory=list)  # (site, interrupt, AH or None), per state
    code_segments: set[int] = field(default_factory=set)  # paragraphs of the root segments holding decoded instructions
    starts: dict[str, set[int]] = field(default_factory=dict)  # space -> first bytes of the decoded instructions
    inside: dict[str, set[int]] = field(default_factory=dict)  # space -> their other bytes
    refs: list[DataRef] = field(default_factory=list)  # every memory operand with an address (data_references.json)
    frame: list[FrameRef] = field(default_factory=list)  # every BP-relative stack operand (frame_references.json)


@dataclass(frozen=True)
class Target:
    node: str
    evidence: str
    provisional: bool  # matched by record field offset only


@dataclass
class Resolved:
    use: Use
    targets: list[Target]
    reason: str | None  # why the transfer (also) goes somewhere unknown; None when fully resolved


# --------------------------------------------------------------------------
# Operands
# --------------------------------------------------------------------------


def parse_mem(op: str) -> MemRef | None:
    m = MEM.match(op.strip())
    if not m:
        return None
    regs: list[str] = []
    disp = 0
    for sign, tok in TERM.findall(m.group(3)):
        if NUM.match(tok):
            disp += -int(tok, 0) if sign == "-" else int(tok, 0)
        else:
            regs.append(tok)
    return MemRef(m.group(1), m.group(2), tuple(regs), disp & 0xFFFF)


def segkey(v: object) -> tuple | None:
    return v.key if isinstance(v, Seg) else None


def fmt_seg(key: tuple) -> str:
    if key == DGROUP:
        return "ds"
    return f"{key[1]:04x}h" if key[0] == "para" else key[1]


def fmt_where(w: tuple) -> str:
    if w[0] == "abs":
        return f"{fmt_seg(w[1])}:[{w[2]:04x}]"
    if w[0] == "indexed":
        return f"{fmt_seg(w[1])}:[index+{w[2]:04x}]"
    tok = w[2]
    rec = f"the record {fmt_where(tok)} points at" if tok[0] == "abs" else "a record"
    return f"field +{w[1]:02x}h of {rec}"


def far_target(prog: Program, seg: tuple, off: int, dgroup: int | None) -> str | None:
    if seg[0] == "space":
        return nid(seg[1], seg[2] + (off & 0xFFFF))
    para = seg[1] if seg[0] == "para" else dgroup
    if para is None:
        return None
    return prog.resolve_far(para, off & 0xFFFF)[0]


def code_segment(prog: Program, ins: Insn, dgroup: int | None) -> tuple:
    """The segment `ins` runs in, as a segment key."""
    if ins.space == prog.root:
        n = prog.code_base(ins.space, ins.addr) // 16
        return DGROUP if n == dgroup else ("para", n)
    return ("space", ins.space, prog.code_base(ins.space, ins.addr))


def near_target(prog: Program, ins: Insn, off: int) -> str:
    return nid(ins.space, prog.code_base(ins.space, ins.addr) + (off & 0xFFFF))


# --------------------------------------------------------------------------
# The walk
# --------------------------------------------------------------------------


def _meet(states: list[dict]) -> dict:
    """What the states agree on (see merge), as a fresh state the walk may change. A register some path
    left unknown is unknown; stacks keep their common top, with `@deep` marking unknown words below it."""
    first, rest = states[0], states[1:]
    out = {}
    for k in first:
        if k[0] != "@" and all(k in s for s in rest):
            v = merge([s[k] for s in states])
            if v is not None:
                out[k] = v
    recents = [s.get("@recent", {}) for s in states]
    out["@recent"] = {k: v for k in recents[0] if all(k in r for r in recents[1:])
                      and (v := merge([r[k] for r in recents])) is not None}
    if all(s.get("@down") for s in states):
        out["@down"] = True
    stacks = [s["@stack"] for s in states]
    n = min(len(x) for x in stacks)
    out["@stack"] = [merge([x[len(x) - n + i] for x in stacks]) for i in range(n)]
    if any(s.get("@deep") for s in states) or any(len(x) != n for x in stacks):
        out["@deep"] = True
    return out


class _Walk:
    def __init__(self, prog: Program, dec: Decoder, facts: Facts, dgroup: int | None, descents: dict):
        self.prog, self.dec, self.facts, self.dgroup, self.descents = prog, dec, facts, dgroup, descents
        self._pops: dict[str, int | None] = {}

    def pops(self, callee: str | None) -> int | None:
        """Words a callee's returns remove: return address plus `ret n` arguments, the same on every
        return (`push cs; call near` into a `retf` routine pops the pushed CS too); None if unknown."""
        if callee not in self.descents:
            return None
        if callee not in self._pops:
            d = self.descents[callee]
            ns = set()
            for i in d.insns.values():
                if i.kind == "ret" and not any(i is x for x in d.indirect):
                    op = i.raw[0]
                    imm = int.from_bytes(i.raw[1:3], "little") // 2 if op in (0xC2, 0xCA) else 0
                    ns.add(imm + (2 if op in (0xCA, 0xCB) else 1) if op != 0xCF else None)
            self._pops[callee] = next(iter(ns)) if len(ns) == 1 and None not in ns else None
        return self._pops[callee]

    def seg_of_para(self, n: int, site: str) -> Seg:
        return Seg(DGROUP if n == self.dgroup else ("para", n), site)

    def code_seg(self, ins: Insn) -> tuple:
        return code_segment(self.prog, ins, self.dgroup)

    def imm(self, ins: Insn, n: int, site: str):
        sp = self.prog.spaces[ins.space]
        if len(ins.raw) >= 3 and ins.end - 2 in sp.relocated_words and int.from_bytes(ins.raw[-2:], "little") == n:
            own = self.prog.sections.get(ins.space)
            if own is not None and own.holds(n * 16):  # overlays share their load area: the code means its own
                return Seg(("space", ins.space, (n - own.load) * 16), site)
            return self.seg_of_para(n, site)
        return Const(n, site)

    def value(self, st: dict, ins: Insn, op: str, site: str):
        if op in R16:
            return st.get(op)
        if op == "cs":
            return Seg(self.code_seg(ins), site)
        if op in ("ds", "es"):
            return st.get(op)
        if NUM.match(op):
            return self.imm(ins, int(op, 0) & 0xFFFF, site)
        ref = parse_mem(op)
        if ref is not None and ref.size == "word":
            w = self.locate(st, ins, ref)
            if w is not None and w[0] == "abs":
                return Word(w, site)
        return None

    def locate(self, st: dict, ins: Insn, ref: MemRef) -> tuple | None:
        seg = ref.seg or ("ss" if "bp" in ref.regs else "ds")
        if seg == "ss":
            return None
        sv = Seg(self.code_seg(ins), "") if seg == "cs" else st.get(seg)
        vals = [st.get(r) for r in ref.regs]
        if all(isinstance(v, Const) for v in vals):
            key = segkey(sv)
            return ("abs", key, (ref.disp + sum(v.n for v in vals)) & 0xFFFF) if key else None
        if isinstance(sv, PtrHi):
            lo = [v for v in vals if isinstance(v, PtrLo) and v.token == sv.token]
            if len(vals) == 1 and lo:
                return ("field", (lo[0].k + ref.disp) & 0xFFFF, sv.token)
            return None
        key = segkey(sv)
        return ("indexed", key, ref.disp) if key else None

    # ---- facts

    def store(self, st: dict, where: tuple | None, value, site: str) -> None:
        if where is None:
            return
        self.facts.stores.append(Store(where, value, site))
        if where[0] == "indexed":
            return
        recent = st.setdefault("@recent", {})
        recent[where] = value
        lo_w = where[:1] + ((where[1] - 2) & 0xFFFF,) + where[2:] if where[0] == "field" else where[:2] + ((where[2] - 2) & 0xFFFF,)
        hi_w = where[:1] + ((where[1] + 2) & 0xFFFF,) + where[2:] if where[0] == "field" else where[:2] + ((where[2] + 2) & 0xFFFF,)
        for s, o in pairs(value, recent.get(lo_w)):
            self.pointer(lo_w, s, o, site)
        for s, o in pairs(recent.get(hi_w), value):
            self.pointer(where, s, o, site)

    def pointer(self, where: tuple, seg: Seg, off: Const, site: str) -> None:
        self.facts.loads.append(PointerLoad(where, seg.key, off.n, site, off.site,
                                            far_target(self.prog, seg.key, off.n, self.dgroup)))

    def use(self, fid: str, ins: Insn, far: bool, where: tuple | None, through: str) -> None:
        self.facts.uses.append(Use(fid, ins, far, where, through))

    # ---- one function

    def run(self, fid: str, d, preds: dict[int, list[int]], isr: bool) -> None:
        """Forward dataflow to a fixpoint, then one more pass over the settled states that records facts.
        Each instruction sees up to WORLDS distinct states (one per way in), so registers loaded together on
        one path stay together (CX:BX = 0:0 on one path, 10FCh:CS on another, never 10FCh:0). A loop head
        (reached from further down) and a merge point reached in more ways than that keep only what their
        ways in agree on (_meet), so loops settle instead of unrolling."""
        start = int(fid.rsplit(":", 1)[1], 16)
        entry = {"@stack": []} if isr else {"@stack": [], "ds": Seg(DGROUP, fid)}
        order = sorted(d.insns)
        out: dict[int, list[dict]] = {}
        joined: set[int] = {a for a in order for p in preds.get(a, []) if p >= a}

        def worlds_in(a: int) -> list[dict] | None:
            ws = [w for p in preds.get(a, []) if p in out for w in out[p]]
            if a == start or not preds.get(a):
                ws.append(entry)
            if not ws:
                return None  # only reached from below, not walked yet
            uniq: list[dict] = []
            for w in ws:
                if w not in uniq:
                    uniq.append(w)
            if len(uniq) > WORLDS or a in joined:
                joined.add(a)
                return [_meet(uniq)]
            return [_meet([w]) for w in uniq]

        facts, self.facts = self.facts, Facts()  # passes before the fixpoint record nothing
        for _ in range(MAX_PASSES):
            changed = False
            for a in order:
                ws = worlds_in(a)
                if ws is not None:
                    for w in ws:
                        self.step(fid, d, d.insns[a], w)
                    if out.get(a) != ws:
                        out[a], changed = ws, True
            if not changed:
                break
        else:
            raise RuntimeError(f"pointer dataflow in {fid} did not settle in {MAX_PASSES} passes")
        self.facts = facts
        for a in order:
            for w in worlds_in(a) or []:
                self.step(fid, d, d.insns[a], w)

    def references(self, fid: str, ins: Insn, st: dict, site: str, ops: list[str]) -> None:
        """Record the memory operands that name an address: an absolute one (also through registers holding
        constants), or `[index + T]` in a known segment. An absolute operand read through a segment register whose
        value is not known here is recorded without a segment. A BP-relative operand in the stack segment is a
        frame reference instead; pointer dereferences name nothing."""
        refs = [r for op in ops if (r := parse_mem(op)) is not None]
        for ref, access in zip(refs, self.dec.mem_access(ins) if refs else [], strict=True):
            if "bp" in ref.regs and ref.seg in (None, "ss"):
                slot = ref.disp - 0x10000 if ref.disp >= 0x8000 else ref.disp
                self.facts.frame.append(FrameRef(fid, ins.addr, slot, len(ref.regs) > 1, access))
            w = self.locate(st, ins, ref)
            register = ref.seg or "ds"
            if w is not None and w[0] in ("abs", "indexed"):
                self.facts.refs.append(DataRef(w[1], register, w[2], w[0] == "indexed", access, fid, site, ins.text))
            elif w is None and not ref.regs:
                self.facts.refs.append(DataRef(None, register, ref.disp, False, access, fid, site, ins.text))

    def step(self, fid: str, d, ins: Insn, st: dict) -> None:
        site = nid(ins.space, ins.addr)
        m = ins.mnemonic
        ops = [o.strip() for o in ins.op_str.split(",")] if ins.op_str else []
        stack: list = st["@stack"]
        self.references(fid, ins, st, site, ops)
        if m == "mov" and len(ops) == 2:
            dst, src = ops
            if dst in R16 or dst in ("ds", "es"):
                v = self.value(st, ins, src, site)
                st.pop(dst, None) if v is None else st.__setitem__(dst, v)
                if dst == "ax":
                    st.pop("ah", None), st.pop("al", None)
                return
            if dst in R8:
                st.pop(R8[dst], None)
                if dst in ("ah", "al"):
                    st.pop(dst, None)
                    if NUM.match(src):
                        st[dst] = int(src, 0) & 0xFF
                return
            ref = parse_mem(dst)
            if ref is not None:
                v = self.value(st, ins, src, site) if ref.size == "word" else None
                self.store(st, self.locate(st, ins, ref), v, site)
                return
            return  # mov ss / mov sreg <- mem: nothing tracked
        if m == "push" and ops:
            stack.append(self.value(st, ins, ops[0], site))
            return
        if m == "pushf":
            stack.append(None)
            return
        if m in ("pop", "popf"):
            v = stack.pop() if stack else None
            if ops and (ops[0] in R16 or ops[0] in ("ds", "es")):
                st.pop(ops[0], None) if v is None else st.__setitem__(ops[0], v)
                if ops[0] == "ax":
                    st.pop("ah", None), st.pop("al", None)
            elif ops and (ref := parse_mem(ops[0])) is not None:
                self.store(st, self.locate(st, ins, ref), v, site)
            return
        if m in ("les", "lds") and len(ops) == 2:
            ref = parse_mem(ops[1])
            w = self.locate(st, ins, ref) if ref is not None else None
            token = w if w is not None and w[0] == "abs" else ("site", site)
            st[ops[0]] = PtrLo(token, 0, site)
            st["es" if m == "les" else "ds"] = PtrHi(token, site)
            return
        if m in ("xor", "sub") and len(ops) == 2 and ops[0] == ops[1] and ops[0] in R16:
            st[ops[0]] = Const(0, site)
            if ops[0] == "ax":
                st["ah"], st["al"] = 0, 0
            return
        if m in ("add", "sub", "inc", "dec") and ops and ops[0] in R16:
            v = st.get(ops[0])
            if m in ("inc", "dec"):
                delta = 1 if m == "inc" else -1
            elif len(ops) == 2 and NUM.match(ops[1]):
                delta = int(ops[1], 0) if m == "add" else -int(ops[1], 0)
            else:
                delta = None
            if delta is not None and isinstance(v, PtrLo):
                st[ops[0]] = PtrLo(v.token, (v.k + delta) & 0xFFFF, v.site)
            elif delta is not None and isinstance(v, Const):
                st[ops[0]] = Const((v.n + delta) & 0xFFFF, v.site)
            else:
                self.forget(st, ins)
            if ops[0] == "sp":
                stack.clear()
            return
        if m in ("cld", "std"):
            st["@down"] = m == "std"
            return
        if m in ("stosw", "stosb", "rep stosw", "rep stosb"):
            width = 2 if m.endswith("w") else 1
            di, step = st.get("di"), -width if st.get("@down") else width
            if m.startswith("rep"):
                cx = st.get("cx")
                if isinstance(cx, Const) and isinstance(di, (Const, PtrLo)):
                    n = (step * cx.n) & 0xFFFF
                    st["di"] = Const((di.n + n) & 0xFFFF, di.site) if isinstance(di, Const) else PtrLo(di.token, (di.k + n) & 0xFFFF, di.site)
                else:
                    st.pop("di", None)
                st["cx"] = Const(0, site)
                return
            if width == 2:
                self.store(st, self.locate(st, ins, MemRef("word", "es", ("di",), 0)), st.get("ax"), site)
            if isinstance(di, Const):
                st["di"] = Const((di.n + step) & 0xFFFF, di.site)
            elif isinstance(di, PtrLo):
                st["di"] = PtrLo(di.token, (di.k + step) & 0xFFFF, di.site)
            return
        if ins.kind == "int" and ins.raw[-2:-1] == b"\xcd":
            self.interrupt(st, ins, site)
            return
        if ins.kind == "call":
            self.arguments(st, ins, site)
            return
        if ins.kind in ("icall", "ijmp") and ins.addr not in d.tables:
            far = m in ("lcall", "ljmp")
            op = ops[0] if ops else ""
            ref = parse_mem(op)
            if ref is not None:
                w = self.locate(st, ins, ref)
                through = fmt_where(w) if w is not None else op
                self.use(fid, ins, far, w, through)
            else:
                self.use(fid, ins, far, ("reg", st.get(op)), op)
            if ins.kind == "icall":
                self.after_call(st)
            return
        if ins.kind == "ret" and any(i is ins for i in d.indirect):
            lo = stack[-1] if stack else None
            hi = stack[-2] if len(stack) > 1 else None
            for s, o in pairs(hi, lo):
                self.pointer(("retf",), s, o, site)
            if isinstance(hi, PtrHi) and isinstance(lo, PtrLo) and hi.token == lo.token and lo.k == 0 and hi.token[0] == "abs":
                self.use(fid, ins, True, hi.token, f"{fmt_where(hi.token)} (pushed and entered with retf)")
            else:
                self.use(fid, ins, True, ("stack", hi, lo), "far pointer pushed and entered with retf")
            return
        if ops and ins.mnemonic not in READ_ONLY:
            ref = parse_mem(ops[0])
            if ref is not None and ref.size == "word":
                self.store(st, self.locate(st, ins, ref), None, site)  # add/inc/xchg/pop... [m]: run-time value
        self.forget(st, ins)

    def forget(self, st: dict, ins: Insn) -> None:
        for r in self.dec.writes(ins):
            fam = R8.get(r, r)
            st.pop(fam, None)
            if fam == "ax":
                st.pop("ah", None), st.pop("al", None)
            if fam == "sp":
                st["@stack"].clear()

    def interrupt(self, st: dict, ins: Insn, site: str) -> None:
        n = ins.raw[-1]
        ax = st.get("ax")
        ah = ax.n >> 8 if isinstance(ax, Const) else st.get("ah")
        al = ax.n & 0xFF if isinstance(ax, Const) else st.get("al")
        self.facts.ints.append((site, n, ah if isinstance(ah, int) else None))
        if n == 0x21 and ah == 0x25:  # set vector AL to DS:DX: a handler, even where AL is not a constant
            for s, o in pairs(st.get("ds"), st.get("dx")):
                tgt = far_target(self.prog, s.key, o.n, self.dgroup)
                self.facts.loads.append(PointerLoad(("vector", al), s.key, o.n, site, o.site, tgt))
                if tgt is not None:
                    self.facts.vectors.append((tgt, al, site))
        # DOS keeps SI, DI, BP and DS; a BIOS or other handler is only trusted with BP and DS
        for r in ("ax", "bx", "cx", "dx", "es", "ah", "al") + (() if n == 0x21 else ("si", "di")):
            st.pop(r, None)
        if n == 0x21 and ah == 0x35 and al is not None:
            st["bx"], st["es"] = Vec(al, "off", site), Vec(al, "seg", site)

    def arguments(self, st: dict, ins: Insn, site: str) -> None:
        stack = st["@stack"]
        callee = target_of(self.prog, ins)[0]
        for hi, lo in zip(stack, stack[1:]):
            for s, o in pairs(hi, lo):
                self.pointer(("arg", callee or ins.text), s, o, site)
        total = self.pops(callee)
        own = 1 if ins.far is None and ins.overlay is None else 2  # return address the call itself pushed
        self.after_call(st, total - own if total is not None and total >= own else None)

    def after_call(self, st: dict, words: int | None = None) -> None:
        """Registers a callee may change are forgotten (it keeps DS, BP and SP); the stack loses the
        callee's arguments, or everything when that count is unknown."""
        for r in ("ax", "bx", "cx", "dx", "si", "di", "es", "ah", "al", "@recent"):
            st.pop(r, None)
        stack = st["@stack"]
        if words is None or words > len(stack):
            stack.clear()
            st["@deep"] = True
        elif words:
            del stack[-words:]


def dgroup(prog: Program, descents: dict) -> int | None:
    """Paragraph the startup code keeps in DS: the first `mov ds, r16` on the startup path (the program entry
    function or, before that, the first function it calls), with r16 loaded from a relocated segment word (`mov r16,
    SEG`: Turbo Pascal, Turbo C) or from CS (`mov r16, cs`: a driver keeping its data in its code segment), plus any
    `add r16, imm` in between (the sound drivers: `mov ax, cs; add ax, 2b0h; mov ds, ax`). Any other instruction
    writing r16 forgets it."""
    entry = descents.get(prog.entry_id)
    if entry is None:
        return None
    order = [entry]
    for ins in sorted(entry.insns.values(), key=lambda i: i.addr):
        if ins.kind == "call" and ins.far is not None:
            tgt = prog.resolve_far(*ins.far)[0]
            if tgt in descents:
                order.insert(0, descents[tgt])
            break
    relocated = prog.spaces[prog.root].relocated_words
    for d in order:
        held: dict[str, int] = {}
        for ins in sorted(d.insns.values(), key=lambda i: i.addr):
            ops = [o.strip() for o in ins.op_str.split(",")]
            if ins.mnemonic == "mov" and len(ops) == 2 and ops[0] in R16 and NUM.match(ops[1]) and ins.end - 2 in relocated:
                held[ops[0]] = int(ops[1], 0)
            elif ins.mnemonic == "mov" and len(ops) == 2 and ops[0] in R16 and ops[1] == "cs" and ins.space == prog.root:
                held[ops[0]] = prog.code_base(ins.space, ins.addr) // 16
            elif ins.mnemonic == "mov" and len(ops) == 2 and ops[0] == "ds":
                return held.get(ops[1])
            elif ins.mnemonic == "add" and len(ops) == 2 and ops[0] in held and NUM.match(ops[1]):
                held[ops[0]] = (held[ops[0]] + int(ops[1], 0)) & 0xFFFF
            elif ops[0] in held and ins.mnemonic not in ("cmp", "test", "push"):
                del held[ops[0]]
    return None


def collect(prog: Program, dec: Decoder, descents: dict, kinds: dict, preds_of, dg: int | None) -> Facts:
    """Walk every function; `preds_of(descent)` gives its single-step predecessors (flow.straight_preds)."""
    facts = Facts()
    for fid, d in descents.items():
        space = split_id(fid)[0]
        facts.starts.setdefault(space, set()).update(d.insns)
        inside = facts.inside.setdefault(space, set())
        for a, ins in d.insns.items():
            inside.update(range(a + 1, ins.end))
    facts.code_segments = {prog.code_base(prog.root, a) // 16 for a in facts.starts.get(prog.root, ())}
    w = _Walk(prog, dec, facts, dg, descents)
    for fid in sorted(descents):
        d = descents[fid]
        built = len(facts.loads)
        w.run(fid, d, preds_of(d), "interrupt-vector" in kinds.get(fid, ()))
        for p in facts.loads[built:]:  # a far pointer the code builds names the location it points at
            at = d.insns[split_id(p.off_site)[1]]
            facts.refs.append(DataRef(p.seg, "", p.off & 0xFFFF, False, "takes the address of", fid, p.off_site, at.text))
    facts.loads = list(dict.fromkeys(facts.loads))  # each path through a site records it again
    facts.stores = list(dict.fromkeys(facts.stores))
    facts.vectors = list(dict.fromkeys(facts.vectors))
    facts.refs = list(dict.fromkeys(facts.refs))
    facts.frame = list(dict.fromkeys(facts.frame))
    return facts


# --------------------------------------------------------------------------
# Resolution
# --------------------------------------------------------------------------


def _runtime(value) -> bool:
    return not isinstance(value, (Const, Seg, Alt))


def resolve(prog: Program, facts: Facts, dg: int | None) -> list[Resolved]:
    by_loc: dict[tuple, list[Store]] = collections.defaultdict(list)
    for s in facts.stores:
        by_loc[s.where[:2] if s.where[0] == "field" else s.where].append(s)
    ptrs: dict[tuple, list[PointerLoad]] = collections.defaultdict(list)
    for p in facts.loads:
        if p.where[0] == "abs":
            ptrs[p.where].append(p)
        elif p.where[0] == "field":
            ptrs[p.where[:2]].append(p)
    indexed: dict[tuple, list[Store]] = collections.defaultdict(list)
    for s in facts.stores:
        if s.where[0] == "indexed":
            indexed[s.where[1]].append(s)
    out: list[Resolved] = []
    for u in facts.uses:
        w = u.where
        if w is None:
            out.append(Resolved(u, [], f"{u.through}: read through registers whose values are not known here (set by a caller, or computed)"))
        elif w[0] == "reg":
            consts = members(w[1], Const)  # only near: a far call or jump through a register does not decode
            ts = [Target(near_target(prog, u.ins, c.n), f"register loaded at {c.site}", False) for c in consts]
            out.append(Resolved(u, _dedupe(ts), None if ts else f"{u.through} holds a value computed at run time"))
        elif w[0] == "stack":
            ts = [Target(t, f"pushed at {o.site}", False) for s, o in pairs(w[1], w[2])
                  if (t := far_target(prog, s.key, o.n, dg))]
            out.append(Resolved(u, _dedupe(ts), None if ts else "the far pointer pushed for retf is computed at run time"))
        elif w[0] == "abs":
            out.append(_resolve_var(prog, u, w, by_loc, ptrs, dg))
        elif w[0] == "indexed":
            out.append(_resolve_table(prog, u, w, by_loc, ptrs, indexed, dg, facts))
        else:
            hits = [p for p in ptrs.get(w[:2], []) if p.target]
            ts = [Target(p.target, f"stored into that field at {p.site}", True) for p in hits]
            out.append(Resolved(u, _dedupe(ts), None if ts else f"nothing stores a constant pointer into {u.through}"))
    return _per_site(out)


def _per_site(rs: list[Resolved]) -> list[Resolved]:
    """One result per (function, site): the targets of every path through it; unknown if any path is."""
    merged: dict[tuple[str, int], Resolved] = {}
    for r in rs:
        k = (r.use.fid, r.use.ins.addr)
        if k not in merged:
            merged[k] = Resolved(r.use, list(r.targets), r.reason)
        else:
            m = merged[k]
            m.targets = _dedupe(m.targets + r.targets)
            m.reason = m.reason or r.reason
    return list(merged.values())


def _dedupe(ts: list[Target]) -> list[Target]:
    seen: dict[str, Target] = {}
    for t in ts:
        seen.setdefault(t.node, t)
    return list(seen.values())


def code_pointer(prog: Program, code_segments: set[int], seg: int, off: int, space: str) -> str | None:
    """The node a far address found in `space` names, if it is an address of code: in an overlay, or in a root segment
    that holds decoded instructions, and inside that segment (not past the next segment's start). A far pointer to
    data, or two unrelated words, look the same in the bytes."""
    tgt = prog.resolve_far(seg, off, space)[0]
    if tgt is None or split_id(tgt)[0] != prog.root:
        return tgt
    return tgt if seg in code_segments and prog.code_base(prog.root, seg * 16 + off) == seg * 16 else None


def initial_pointer(prog: Program, w: tuple, dg: int | None) -> tuple[int, int, str, str] | None:
    """The far pointer the load image holds at the location `w`, when the linker relocated its segment word: what the
    variable holds before any code stores into it. Returns (segment, offset, the space it is in, where it is). None
    as well when the location is in the data segment and it is not known where that is."""
    key, addr = w[1], w[2]
    para = dg if key == DGROUP else key[1]
    if para is None:
        return None
    space, pos = (key[1], key[2] + addr) if key[0] == "space" else (prog.root, para * 16 + addr)
    sp = prog.spaces[space]
    if pos + 2 not in sp.relocated_words:
        return None
    off, seg = struct.unpack_from("<HH", sp.data, pos)
    return seg, off, space, nid(space, pos)


def _var_values(prog, u: Use, w: tuple, by_loc, ptrs, seen: set, via: str, dg: int | None):
    """Constant pointers that can reach variable `w`: stored into it, or into a variable copied into it
    (`mov ax, [a]; mov dx, [a+2]; mov [w], ax; mov [w+2], dx`, e.g. `ExitProc := SaveExit`), or the far pointer
    the load image holds there. Returns (targets, a stored INT 21h/35h vector, a store of some other run-time value)."""
    seen.add(w)
    lo = by_loc.get(w, [])
    hi = by_loc.get(w[:2] + ((w[2] + 2) & 0xFFFF,), []) if u.far else []
    if u.far:
        ts = [Target(p.target, f"stored at {p.site}{via}", False) for p in ptrs.get(w, []) if p.target]
        init = initial_pointer(prog, w, dg)
        if init is not None and (tgt := prog.resolve_far(init[0], init[1], init[2])[0]) is not None:
            ts.append(Target(tgt, f"in the load image at {init[3]}{via}", False))
    else:
        ts = [Target(near_target(prog, u.ins, c.n), f"stored at {s.site}{via}", False)
              for s in lo for c in members(s.value, Const)]
    sources = {s.value.loc: s for s in lo if isinstance(s.value, Word)}
    if u.far:
        hi_src = {s.value.loc for s in hi if isinstance(s.value, Word)}
        sources = {loc: s for loc, s in sources.items() if loc[:2] + ((loc[2] + 2) & 0xFFFF,) in hi_src}
        his = {loc[:2] + ((loc[2] + 2) & 0xFFFF,) for loc in sources}
        explained = {s.site for s in sources.values()} | {s.site for s in hi if isinstance(s.value, Word) and s.value.loc in his}
    else:
        explained = {s.site for s in sources.values()}
    vec = next((s.value for s in lo + hi if isinstance(s.value, Vec)), None)
    runtime = next((s for s in lo + hi if _runtime(s.value) and not isinstance(s.value, Vec) and s.site not in explained), None)
    for loc, s in sorted(sources.items()):
        if loc not in seen:
            t2, v2, r2 = _var_values(prog, u, loc, by_loc, ptrs, seen, f", copied from {fmt_where(loc)} at {s.site}{via}", dg)
            ts += t2
            vec = vec or v2
            runtime = runtime or r2
    return ts, vec, runtime


def _resolve_var(prog, u: Use, w: tuple, by_loc, ptrs, dg: int | None) -> Resolved:
    ts, vec, runtime = _var_values(prog, u, w, by_loc, ptrs, set(), "", dg)
    if vec is not None:
        reason = f"the previous INT {vec.n:02X}h handler, which DOS returned (INT 21h/35h) at {vec.site}"
    elif runtime is not None:
        reason = f"{fmt_where(runtime.where)} is also set from a value computed at run time (at {runtime.site})"
    elif not ts:
        reason = f"nothing stores a constant pointer into {u.through}"
    else:
        reason = None
    return Resolved(u, _dedupe(ts), reason)


def _resolve_table(prog, u: Use, w: tuple, by_loc, ptrs, indexed, dg: int | None, facts: Facts) -> Resolved:
    """Entries T, T+4, ... (T+2, ... for a near table) as far as each holds a constant pointer: stored there, or, in a
    far table, held there by the load image and pointing at code (a table of far data pointers may follow it). A near
    table nothing stores into, in the segment of the code that reads it, is read from the bytes (code_table)."""
    key, base = w[1], w[2]
    code_segments = facts.code_segments
    step = 4 if u.far else 2

    def entry(k: int) -> list[Target]:
        loc = ("abs", key, (base + k) & 0xFFFF)
        n = f"entry {k // step} of {u.through}"
        if not u.far:
            return [Target(near_target(prog, u.ins, c.n), f"{n}, stored at {s.site}", False)
                    for s in by_loc.get(loc, []) for c in members(s.value, Const)]
        found = [Target(p.target, f"{n}, stored at {p.site}", False) for p in ptrs.get(loc, []) if p.target]
        init = initial_pointer(prog, loc, dg)
        if init is not None and (tgt := code_pointer(prog, code_segments, init[0], init[1], init[2])) is not None:
            found.append(Target(tgt, f"{n}, in the load image at {init[3]}", False))
        return found

    first = next((k for k in (0, step) if entry(k)), None)
    ts: list[Target] = []
    end = base
    if first is not None:
        for i in range(TABLE_SPAN):
            found = entry(first + i * step)
            if not found:
                break
            ts += found
            end = ((base + first + i * step) & 0xFFFF) + step
    writers = [s for s in indexed.get(key, []) if base <= s.where[2] < max(end, base + step) and (s.where[2] - base) % step == 0]
    if not (ts or writers) and u.ins.kind == "icall" and not u.far and key == code_segment(prog, u.ins, dg):
        ts = code_table(prog, facts, u, base)
    if writers:
        reason = f"{u.through} is also written through an index (at {writers[0].site})"
    elif not ts:
        reason = f"nothing stores constant pointers into the table at {u.through}"
    else:
        reason = None
    return Resolved(u, _dedupe(ts), reason)


def code_table(prog: Program, facts: Facts, u: Use, base: int) -> list[Target]:
    """Near pointers read from a table that lies in the code's own segment and that no code fills: the words from its
    start up to where code begins, which is the first decoded instruction or the lowest address the table itself names
    (a table does not overlap what it points to). Every word must name a byte of the space that is not inside a
    decoded instruction and not inside the table. If one does not, or nothing ends the run, this is no such table and
    nothing is taken. As for stored tables, the first entry may be the second word (an index that starts at 1)."""
    sp = prog.spaces[u.ins.space]
    starts, inside = facts.starts[u.ins.space], facts.inside[u.ins.space]
    cb = prog.code_base(u.ins.space, u.ins.addr)
    table = cb + base
    for first in (0, 2):
        found = _table_run(sp, starts, inside, cb, table, table + first)
        if found:
            return _dedupe([Target(nid(u.ins.space, t), f"entry {first // 2 + i} of {u.through}, in the bytes at {nid(u.ins.space, table + first + 2 * i)}", False)
                            for i, t in enumerate(found)])
    return []


def _table_run(sp, starts: set[int], inside: set[int], cb: int, table: int, start: int) -> list[int]:
    limit = math.inf  # the lowest address behind it that the table names
    found: list[int] = []
    pos = start
    while not (pos in starts or pos in inside or pos + 1 in starts or limit <= pos + 1):
        if pos + 2 > len(sp.data) or len(found) == TABLE_SPAN:
            return []
        t = cb + struct.unpack_from("<H", sp.data, pos)[0]
        if t not in sp or t in inside or table <= t <= pos + 1:
            return []
        found.append(t)
        limit = min(limit, t) if t > pos else limit
        pos += 2
    return found


def proven(resolved: list[Resolved]) -> dict[str, list[str]]:
    """Targets a resolved indirect transfer reaches through a stored constant pointer -> evidence."""
    out: dict[str, list[str]] = collections.defaultdict(list)
    for r in resolved:
        for t in r.targets:
            if not t.provisional:
                out[t.node].append(f"{r.use.ins.text} at {nid(r.use.ins.space, r.use.ins.addr)} ({t.evidence})")
    return out


def describe_load(p: PointerLoad) -> str:
    w = p.where
    if w[0] in ("abs", "field"):
        into = f"stored into {fmt_where(w)}"
    elif w[0] == "arg":
        into = f"passed to {w[1]}"
    elif w[0] == "vector":
        into = f"installed as {vector_text(w[1])}"
    else:
        into = "pushed and entered with retf"
    return f"far pointer {fmt_seg(p.seg)}:{p.off:04x} built at {p.off_site}, {into} at {p.site}"


def vector_text(n: int | None) -> str:
    return "an interrupt handler (the vector number is not a constant there)" if n is None else f"the INT {n:02X}h handler"
