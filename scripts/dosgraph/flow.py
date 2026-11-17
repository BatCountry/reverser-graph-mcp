"""Recursive descent, non-returning analysis, code pointers and control dependence."""

from __future__ import annotations

import collections
from dataclasses import dataclass, field

from .binary import Program, nid, split_id
from .x86 import (
    Decoder,
    Insn,
    is_dos_exit,
    is_retf_dispatch,
    pascal_string_at,
    pointer_immediate,
    target_of,
)
from . import pointers
from .tables import JumpTable, resolve

EXIT = -1
TRAIL = 24  # instructions of the path into a run kept for reading a jump table's index range


@dataclass
class Descent:
    root: str
    insns: dict[int, Insn] = field(default_factory=dict)
    calls: list[tuple[Insn, str | None, str]] = field(default_factory=list)  # (site, resolved target, how)
    tails: list[tuple[Insn, str | None, str]] = field(default_factory=list)  # transfers leaving the function
    indirect: list[Insn] = field(default_factory=list)  # icall / ijmp / retf dispatch
    term: set[int] = field(default_factory=set)  # instructions after which control never continues here
    cont: dict[int, int] = field(default_factory=dict)  # retf dispatch -> pushed return address
    has_ret: bool = False
    has_ijmp: bool = False
    dirty: bool = False  # hit undecodable bytes, a stub table, or left the space
    hazards: list[dict] = field(default_factory=list)
    tables: dict[int, JumpTable] = field(default_factory=dict)  # resolved near jump tables, by jump site
    trails: dict[int, list[Insn]] = field(default_factory=dict)  # path each table's index range was read from
    why: dict[int, str] = field(default_factory=dict)  # unresolved indirect jump -> why the table was not followed


def _hazard(d: Descent, kind: str, space: str, addr: int, detail: str) -> None:
    d.hazards.append({"kind": kind, "space": space, "addr": addr, "root": d.root, "detail": detail})


def retf_continuation(prog: Program, ins: Insn, prev: list[Insn]) -> int | None:
    """Return address pushed by `mov r16, imm; ...; push cs; push r16; push seg; push off; retf`."""
    pushes = prev[-4:]
    if len(pushes) < 4 or pushes[0].raw != b"\x0e" or len(pushes[1].raw) != 1 or not 0x50 <= pushes[1].raw[0] <= 0x57:
        return None
    want = 0xB8 + pushes[1].raw[0] - 0x50
    for p in reversed(prev[-10:-4]):
        if len(p.raw) == 3 and p.raw[0] == want:
            return prog.code_base(ins.space, ins.addr) + int.from_bytes(p.raw[1:3], "little")
    return None


def descend(
    prog: Program,
    dec: Decoder,
    root_id: str,
    func_starts: dict[str, set[int]],
    noreturn: set[str],
    stop_on_fallthrough: bool = False,
    unresolved: frozenset[int] = frozenset(),
) -> Descent:
    """Recursive descent from `root_id`.

    Follows jcc/jmp inside the function, stops at ret/retf/iret, DOS exits, indirect jumps and
    unconditional jumps; calls fall through unless the callee is in `noreturn`.  Jumps to another
    function start (or another space) are tail transfers and are not followed.  Falling through into
    another function's start continues (the code is reachable from here) unless `stop_on_fallthrough`.
    A near indirect jump through a table whose index range the preceding code bounds (see tables.py) is
    followed into every entry, unless its site is in `unresolved`: when the finished descent shows that
    the path the range was read from can also be entered elsewhere, the descent is redone without it.
    """
    space, start = split_id(root_id)
    sp = prog.spaces[space]
    d = Descent(root_id)
    starts_here = func_starts.get(space, set())
    work: list[tuple[int, str | None, list[Insn]]] = [(start, None, [])]  # (address, via, path that led here)
    while work:
        a, via, entry = work.pop()
        prev: list[Insn] = []
        first = True
        while True:
            if a in d.insns:
                break
            if stop_on_fallthrough and not first and a != start and a in starts_here:
                _hazard(d, "fallthrough-into-function-start", space, a,
                        f"code after {prev[-1].addr:04x} ({prev[-1].mnemonic}) runs into function {nid(space, a)}")
                d.tails.append((prev[-1], nid(space, a), "fallthrough"))
                break
            first = False
            if a not in sp:
                d.dirty = True
                _hazard(d, "ran-off-space", space, a,
                        f"flow reaches {a:#x}, outside {space} (size {len(sp.data):#x}); via {via}")
                break
            if space == prog.root and prog.stub_table_of(a):
                d.dirty = True
                _hazard(d, "flow-into-overlay-stub-table", space, a,
                        f"flow reaches {prog.stub_table_of(a)} INT 3Fh stub table at {a:#x}; "
                        f"previous {prev[-1].bytes_text if prev else via}")
                break
            ins = dec(space, a)
            if ins.kind == "invalid":
                d.dirty = True
                _hazard(d, "invalid-opcode-in-flow", space, a,
                        f"undecodable bytes {ins.raw.hex()} reached; previous {prev[-1].bytes_text if prev else via}")
                break
            d.insns[a] = ins
            if ins.non8086:
                _hazard(d, "non-8086-instruction", space, a, ins.bytes_text)
            if ins.kind == "fpemu":
                _hazard(d, "fp-emulator-int", space, a, f"Borland 8087-emulator sequence {ins.raw.hex()}")
            prev.append(ins)
            k = ins.kind
            if k == "ret":
                if is_retf_dispatch(ins, prev[:-1]):
                    d.indirect.append(ins)
                    back = retf_continuation(prog, ins, prev[:-1])
                    _hazard(d, "retf-dispatch", space, a, "push cs; push x3; retf: computed far call, "
                            + (f"returning to {back:04x}" if back is not None else "return address unknown"))
                    if back is not None:
                        d.cont[a] = back
                        work.append((back, f"{a:04x} (retf dispatch return)", []))
                    else:
                        d.term.add(a)
                else:
                    d.term.add(a)
                    d.has_ret = True
                break
            if k == "exit" or is_dos_exit(ins, prev[:-1]):
                d.term.add(a)
                break
            if k == "ijmp":
                table = "its index range was read from a path with other entries" if a in unresolved else resolve(prog, dec, ins, entry + prev)
                if isinstance(table, JumpTable):
                    d.tables[a], d.trails[a] = table, entry + prev
                    for t in dict.fromkeys(table.targets):
                        if t in starts_here and t != start:
                            d.tails.append((ins, nid(space, t), "jump-table"))
                        else:
                            work.append((t, f"{a:04x} (jump table)", []))
                    break
                d.indirect.append(ins)
                d.has_ijmp = True
                d.why[a] = str(table)
                d.term.add(a)
                _hazard(d, "indirect-jmp", space, a, f"{ins.bytes_text}: jump table / computed dispatch, not followed ({table})")
                break
            if k == "icall":
                d.indirect.append(ins)
                a = ins.end
                continue
            if k in ("call", "jmp", "jcc"):
                tgt, how = target_of(prog, ins)
                if k == "call":
                    d.calls.append((ins, tgt, how))
                    if tgt in noreturn:
                        d.term.add(a)
                        break
                    a = ins.end
                    continue
                if tgt is None:
                    d.dirty = True
                    d.tails.append((ins, None, how))
                    _hazard(d, "unresolvable-jump", space, a, f"{ins.bytes_text}: {how}")
                else:
                    tsp, toff = split_id(tgt)
                    if tsp != space or (toff in starts_here and toff != start):
                        d.tails.append((ins, tgt, how))
                    elif toff not in sp:
                        d.dirty = True
                        d.tails.append((ins, None, f"target {toff:#x} outside {space}"))
                        _hazard(d, "jump-outside-space", space, a, f"{ins.bytes_text}: target {toff:#x} outside {space}")
                    else:
                        work.append((toff, f"{ins.addr:04x}", (entry + prev)[-TRAIL:]))
                if k == "jmp":
                    break
                a = ins.end
                continue
            a = ins.end
    if d.tables:
        preds = straight_preds(d)
        shared = {site for site, t in d.tables.items() if not _single_entry(d.trails[site][t.guard_from:], preds)}
        if shared:
            return descend(prog, dec, root_id, func_starts, noreturn, stop_on_fallthrough, unresolved | shared)
    # instruction streams of this function that overlap (jump into the middle of an instruction)
    interior: dict[int, int] = {}
    for a, ins in d.insns.items():
        for b in range(a + 1, ins.end):
            interior.setdefault(b, a)
    for a in d.insns:
        if a in interior:
            _hazard(d, "overlapping-instructions", space, a,
                    f"instruction at {a:04x} starts inside the instruction at {interior[a]:04x}")
    return d


def _single_entry(path: list[Insn], preds: dict[int, list[int]]) -> bool:
    """Every instruction after the first is reached only from the one before it."""
    return all(set(preds.get(q.addr, [])) == {p.addr} for p, q in zip(path, path[1:]))


def may_return(d: Descent, noreturn: set[str]) -> bool:
    if d.has_ret or d.has_ijmp or d.dirty:
        return True
    return any(t is None or t not in noreturn for _i, t, h in d.tails)


def uncovered_run_starts(prog: Program, space: str, reached: set[int], dec: Decoder) -> set[int]:
    """Starts of maximal byte runs not covered by any reached instruction (stub tables excluded)."""
    sp = prog.spaces[space]
    cov = bytearray(len(sp.data))
    for a in reached:
        n = min(dec.cache[(space, a)].size, len(sp.data) - a)
        cov[a : a + n] = b"\x01" * n
    out = set()
    for a in range(sp.origin, len(sp.data)):
        if not cov[a] and (a == sp.origin or cov[a - 1]) and not (space == prog.root and prog.stub_table_of(a)):
            out.add(a)
    return out


PROVEN = {"program-entry", "overlay-entry", "module-entry", "call-target", "tail-target", "interrupt-vector", "pointer-target"}


@dataclass
class Analysis:
    descents: dict[str, Descent]
    noreturn: set[str]
    root_kinds: dict[str, set[str]]
    address_taken: dict[str, list[str]]  # code pointer target -> how its address was built (guess evidence)
    rejected_pointers: dict[str, list[str]]  # candidate -> evidence + reason
    proof: dict[str, list[str]] = field(default_factory=dict)  # pointer-target / vector -> the transfer that proves it
    resolved: list[pointers.Resolved] = field(default_factory=list)  # every indirect call/jump/retf dispatch
    facts: pointers.Facts = field(default_factory=pointers.Facts)  # stores, constant far pointers, vectors
    dgroup: int | None = None  # paragraph the startup code loads into DS

    @property
    def loads(self) -> list[pointers.PointerLoad]:
        """Every constant far pointer the code builds."""
        return self.facts.loads

    def provisional(self, fid: str) -> bool:
        """Code that exists only because a pointer to it is built somewhere: no transfer to it is known."""
        return not (self.root_kinds.get(fid, set()) & PROVEN)


def _valid_root(prog: Program, tgt: str | None) -> bool:
    if not tgt:
        return False
    sp_name, off = split_id(tgt)
    if sp_name not in prog.spaces or off not in prog.spaces[sp_name]:
        return False
    return not (sp_name == prog.root and prog.stub_table_of(off))


def _explore(prog, dec, roots, kinds, noreturn, stop_on_fallthrough) -> dict[str, Descent]:
    """Descend every root, adding direct call targets and cross-space/tail targets until closed."""
    while True:
        starts: dict[str, set[int]] = collections.defaultdict(set)
        for r in roots:
            s, o = split_id(r)
            starts[s].add(o)
        descents = {r: descend(prog, dec, r, starts, noreturn, stop_on_fallthrough) for r in sorted(roots)}
        new = set()
        for d in descents.values():
            for _ins, tgt, how in d.calls:
                if tgt not in roots and _valid_root(prog, tgt):
                    new.add(tgt)
                    kinds[tgt].add("call-target")
            for _ins, tgt, how in d.tails:
                if how != "fallthrough" and tgt not in roots and _valid_root(prog, tgt):
                    new.add(tgt)
                    kinds[tgt].add("tail-target")
        if not new:
            return descents
        roots |= new


def analyze(prog: Program, dec: Decoder, stop_on_fallthrough: bool = False) -> Analysis:
    """Functions = program entry, overlay entries and everything reachable from them by direct calls, tail
    transfers and resolved indirect transfers (pointers.py), plus validated pointer guesses; with a
    non-returning fixpoint.

    Both loops terminate: each round adds at least one new root (finitely many addresses), and the
    non-returning set only grows (descents shrink as it grows)."""
    kinds: dict[str, set[str]] = collections.defaultdict(set)
    roots: set[str] = {prog.entry_id}
    kinds[prog.entry_id].add("program-entry")
    for e in prog.overlay_entry_ids():
        kinds[e].add("overlay-entry")
        roots.add(e)
    for e in prog.module_entry_ids():
        kinds[e].add("module-entry")
        roots.add(e)
    address_taken: dict[str, list[str]] = {}
    rejected: dict[str, list[str]] = {}
    while True:
        noreturn: set[str] = set()
        while True:
            descents = _explore(prog, dec, roots, kinds, noreturn, stop_on_fallthrough)
            new = noreturn | {r for r, d in descents.items() if not may_return(d, noreturn)}
            if new == noreturn:
                break
            noreturn = new
        dg = pointers.dgroup(prog, descents)
        facts = pointers.collect(prog, dec, descents, kinds, straight_preds, dg)
        resolved = pointers.resolve(prog, facts, dg)
        proof: dict[str, list[str]] = collections.defaultdict(list)
        for tgt, ev in pointers.proven(resolved).items():
            if _valid_root(prog, tgt):
                kinds[tgt].add("pointer-target")
                proof[tgt].extend(ev)
        for tgt, n, site in facts.vectors:
            if _valid_root(prog, tgt):
                kinds[tgt].add("interrupt-vector")
                proof[tgt].append(f"installed as the INT {n:02X}h handler at {site} (INT 21h/25h)")
        proven = {t for t in proof if t not in roots}
        fresh = _pointer_guesses(prog, dec, descents, roots | proven, noreturn, address_taken, rejected,
                                 stop_on_fallthrough, facts)
        for k in address_taken:
            kinds[k].add("address-taken")
        if not fresh and not proven:
            return Analysis(descents, noreturn, dict(kinds), address_taken, rejected, dict(proof), resolved, facts, dg)
        for k, v in fresh.items():
            address_taken[k] = v
            kinds[k].add("address-taken")
        roots |= proven | set(fresh)


def _pointer_guesses(prog, dec, descents, roots, noreturn, address_taken, rejected, stop_on_fallthrough,
                     facts: pointers.Facts) -> dict[str, list[str]]:
    """Code that exists only because its address is built somewhere (no transfer to it is known yet).

    * every constant far pointer the code builds (pointers.py: stored, passed, pushed), and
    * a `mov r16/r/m16, imm16` / `push imm16` that is not part of one and not a relocated segment word, whose
      value (+ the code segment base) is the first byte of a run no instruction covers.
    A built pointer may be a string or a record as easily as a procedure, and a number may be a count
    (`mov cx, 21h; mov bx, 714h; mov es, bx`), so each candidate must decode as a
    self-contained 8086 procedure: clean flow, a terminator, no zero fill, no Pascal string at the start,
    no contact with already-decoded code. A guess never splits an existing listing. Accepted guesses are
    provisional functions (Analysis.provisional); candidates that are already functions only gain evidence.
    Returns accepted candidates -> evidence.
    """
    reached: dict[str, set[int]] = collections.defaultdict(set)
    for r, d in descents.items():
        reached[split_id(r)[0]].update(d.insns)
    cand: dict[str, list[str]] = collections.defaultdict(list)
    for p in facts.loads:
        if _valid_root(prog, p.target):
            cand[p.target].append(pointers.describe_load(p))
    offsets = {p.off_site for p in facts.loads}
    for sp_name, addrs in reached.items():
        sp = prog.spaces[sp_name]
        run_starts = uncovered_run_starts(prog, sp_name, addrs, dec)
        for a in sorted(addrs):
            ins = dec.cache[(sp_name, a)]
            imm = pointer_immediate(ins)
            site = nid(sp_name, a)
            if imm is None or site in offsets or ins.end - 2 in sp.relocated_words:
                continue
            base = prog.code_base(sp_name, a)
            if base + imm in run_starts:
                cand[nid(sp_name, base + imm)].append(f"immediate {imm:04x} at {site}")
    interior: dict[str, set[int]] = {}
    for sp_name, addrs in reached.items():
        s: set[int] = set()
        for a in addrs:
            s.update(range(a + 1, dec.cache[(sp_name, a)].end))
        interior[sp_name] = s
    starts: dict[str, set[int]] = collections.defaultdict(set)
    for r in roots:
        s, o = split_id(r)
        starts[s].add(o)
    fresh: dict[str, list[str]] = {}
    for k, ev in cand.items():
        ev = list(dict.fromkeys(ev))
        if k in roots:
            address_taken.setdefault(k, [])
            address_taken[k].extend(x for x in ev if x not in address_taken[k])
            continue
        if k in rejected:
            continue
        sp_name, off = split_id(k)
        data = prog.spaces[sp_name].data
        here, inside = reached.get(sp_name, set()), interior.get(sp_name, set())
        why = None
        if pascal_string_at(data, off):
            why = "length-prefixed string"
        else:
            probe = descend(prog, dec, k, starts, noreturn, stop_on_fallthrough)
            mid = any(a in inside or any(b in here for b in range(a + 1, i.end)) for a, i in probe.insns.items())
            if probe.dirty or not probe.insns:
                why = "decodes into invalid/out-of-space flow"
            elif any(h["kind"] == "non-8086-instruction" for h in probe.hazards):
                why = "decodes to non-8086 instructions"
            elif mid:
                why = "overlaps already-decoded instructions mid-instruction"
            elif not (probe.term or probe.tails):
                why = "no terminator"
            elif data[off : off + 2] == b"\x00\x00" or sum(i.raw == b"\x00\x00" for i in probe.insns.values()) >= 2:
                why = "decodes through zero-filled bytes (data)"
            elif any(h == "fallthrough" for _i, _t, h in probe.tails):
                why = "falls through into an existing function start"
            elif any(a in here for a in probe.insns):
                why = "runs into already-decoded instructions"
        if why:
            rejected[k] = ev + [why]
        else:
            fresh[k] = ev
    return fresh


# --------------------------------------------------------------------------
# Control dependence
# --------------------------------------------------------------------------


def successors(d: Descent) -> dict[int, list[tuple[int, str]]]:
    """Instruction-level CFG of a descent.  EXIT stands for leaving the function."""
    succ: dict[int, list[tuple[int, str]]] = {}
    for a, ins in d.insns.items():
        if a in d.term:
            out = [(EXIT, "")]
        elif a in d.cont:
            out = [(d.cont[a] if d.cont[a] in d.insns else EXIT, "")]
        elif ins.kind == "jmp":
            t = ins.near_target if ins.far is None else None
            out = [(t if t in d.insns else EXIT, "")]
        elif ins.kind == "jcc":
            t = ins.near_target
            out = [(t if t in d.insns else EXIT, "taken"), (ins.end if ins.end in d.insns else EXIT, "fallthrough")]
        else:
            out = [(ins.end if ins.end in d.insns else EXIT, "")]
        succ[a] = out
    return succ


def control_dependence(d: Descent) -> dict[int, list[tuple[int, str]]]:
    """For every instruction, the (jcc address, direction) pairs it is directly control dependent on."""
    if not d.insns:
        return {}
    succ = successors(d)
    _space, start = split_id(d.root)
    preds: dict[int, list[int]] = collections.defaultdict(list)
    for a, outs in succ.items():
        for b, _ in outs:
            if b != EXIT:
                preds[b].append(a)
    # basic blocks
    leader = {a for a in d.insns if a == start or len(preds[a]) != 1 or len(succ[preds[a][0]]) != 1}
    block_of: dict[int, int] = {}
    blocks: dict[int, list[int]] = {}
    for a in sorted(leader):
        cur, body = a, []
        while True:
            body.append(cur)
            block_of[cur] = a
            nxt = succ[cur]
            if len(nxt) != 1 or nxt[0][0] == EXIT or nxt[0][0] in leader:
                break
            cur = nxt[0][0]
        blocks[a] = body
    bsucc: dict[int, list[tuple[int, str]]] = {
        b: [(block_of[t] if t != EXIT else EXIT, lab) for t, lab in succ[body[-1]]] for b, body in blocks.items()
    }
    # blocks that cannot reach EXIT (infinite loops) get a virtual exit edge
    bpred: dict[int, set[int]] = collections.defaultdict(set)
    for b, outs in bsucc.items():
        for t, _ in outs:
            bpred[t].add(b)
    reach = {EXIT}
    stack = [EXIT]
    while stack:
        x = stack.pop()
        for p in bpred[x]:
            if p not in reach:
                reach.add(p)
                stack.append(p)
    for b in blocks:
        if b not in reach:
            bsucc[b] = bsucc[b] + [(EXIT, "")]
            bpred[EXIT].add(b)
    # post-dominators: dominators of the reverse graph rooted at EXIT (Cooper/Harvey/Kennedy)
    order: list[int] = []
    seen = {EXIT}
    stack2: list[tuple[int, list[int]]] = [(EXIT, sorted(bpred[EXIT]))]
    while stack2:
        node, rest = stack2[-1]
        if rest:
            nxt = rest.pop()
            if nxt not in seen:
                seen.add(nxt)
                stack2.append((nxt, sorted(bpred[nxt])))
        else:
            order.append(node)
            stack2.pop()
    po = {n: i for i, n in enumerate(order)}
    rpo = list(reversed(order))
    ipdom: dict[int, int] = {EXIT: EXIT}

    def intersect(x: int, y: int) -> int:
        while x != y:
            while po[x] < po[y]:
                x = ipdom[x]
            while po[y] < po[x]:
                y = ipdom[y]
        return x

    changed = True
    while changed:
        changed = False
        for b in rpo:
            if b == EXIT:
                continue
            # the reverse-DFS parent precedes b in this order, so at least one successor is processed
            cands = [t for t, _ in bsucc[b] if t in ipdom]
            new = cands[0]
            for t in cands[1:]:
                new = intersect(new, t)
            if ipdom.get(b) != new:
                ipdom[b] = new
                changed = True
    cd: dict[int, list[tuple[int, str]]] = collections.defaultdict(list)
    for b, outs in bsucc.items():
        branch = outs[:2]  # a virtual exit edge (infinite loop) is never a decision
        if [lab for _, lab in branch] != ["taken", "fallthrough"] or branch[0][0] == branch[1][0]:
            continue
        jcc = blocks[b][-1]
        for t, lab in branch:
            runner = t
            while runner != ipdom[b] and runner != EXIT:
                cd[runner].append((jcc, lab))  # each (branch, direction) walks a pdom-tree path once
                runner = ipdom[runner]
    return {a: sorted(cd[block_of[a]]) for a in d.insns if cd.get(block_of[a])}


def straight_preds(d: Descent) -> dict[int, list[int]]:
    preds: dict[int, list[int]] = collections.defaultdict(list)
    for a, outs in successors(d).items():
        for b, _ in outs:
            if b != EXIT:
                preds[b].append(a)
    return preds


def flag_setter(dec: Decoder, d: Descent, jcc: Insn, preds: dict[int, list[int]], limit: int = 12) -> Insn | None:
    """Nearest preceding instruction on the single-predecessor path that sets a flag the jcc tests
    (a call counts: the callee sets the flags).  `preds` comes from `straight_preds(d)`."""
    _mod, tested = dec.flags(jcc)
    if not tested:
        return None
    cur = jcc.addr
    for _ in range(limit):
        ps = preds.get(cur, [])
        if len(ps) != 1:
            return None
        p = d.insns[ps[0]]
        if p.kind in ("call", "icall"):
            return p
        mod, _ = dec.flags(p)
        if mod & tested:
            return p
        cur = p.addr
    return None
