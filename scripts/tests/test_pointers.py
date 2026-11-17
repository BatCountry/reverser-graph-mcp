"""Constant pointers followed from where the code builds them to the indirect transfers that use them."""

import pytest
from conftest import DOS_EXIT, RETF, Module, call, mz
from test_flow import R, code, edges_from, run

from dosgraph import pointers
from dosgraph.binary import Program
from dosgraph.flow import analyze
from dosgraph.pointers import (
    ALT_MAX,
    DGROUP,
    Alt,
    Const,
    MemRef,
    PtrLo,
    Seg,
    Word,
    _meet,
    fmt_where,
    merge,
    parse_mem,
)
from dosgraph.x86 import Decoder


def w16(n: int) -> bytes:
    return n.to_bytes(2, "little")


def store_imm(addr: int, value: int) -> bytes:  # mov word ptr [addr], value
    return b"\xc7\x06" + w16(addr) + w16(value)


def store_cs(addr: int) -> bytes:  # mov word ptr [addr], cs
    return b"\x8c\x0e" + w16(addr)


def far_var(addr: int, off: int) -> bytes:
    """[addr] = cs:off"""
    return store_imm(addr, off) + store_cs(addr + 2)


def lcall_mem(addr: int) -> bytes:  # lcall [addr]
    return b"\xff\x1e" + w16(addr)


def at(parts: list[bytes], i: int) -> int:
    """Offset of parts[i] when the parts are laid out from 0."""
    return sum(len(p) for p in parts[:i])


def site(g, src: str, off: int) -> list[dict]:
    return [e for e in g["edges"] if e["source"] == src and e["instruction_offset"] == f"{R}:{off:04x}"]


# ---------------------------------------------------------------- operands and lattice


@pytest.mark.parametrize("op,ref", [
    ("word ptr es:[di + 0x14]", MemRef("word", "es", ("di",), 0x14)),
    ("[bp - 6]", MemRef(None, None, ("bp",), 0xFFFA)),
    ("ptr [0x4fa4]", MemRef(None, None, (), 0x4FA4)),
    ("es:[bx + di]", MemRef(None, "es", ("bx", "di"), 0)),
    ("byte ptr cs:[0x10]", MemRef("byte", "cs", (), 0x10)),
    ("[0x10000]", MemRef(None, None, (), 0)),  # wraps like the CPU
    ("ax", None),
    ("0x30", None),
])
def test_parse_mem(op, ref):
    assert parse_mem(op) == ref


def test_fmt_where():
    assert fmt_where(("abs", DGROUP, 0x100)) == "ds:[0100]"
    assert fmt_where(("abs", ("para", 0x714), 0x124)) == "0714h:[0124]"
    assert fmt_where(("abs", ("space", "MAIN_OVR-0020", 0), 0xF)) == "MAIN_OVR-0020:[000f]"
    assert fmt_where(("indexed", DGROUP, 0x6786)) == "ds:[index+6786]"
    assert fmt_where(("field", 0x14, ("abs", DGROUP, 0x4FA4))) == "field +14h of the record ds:[4fa4] points at"
    assert fmt_where(("field", 0x18, ("site", f"{R}:0010"))) == "field +18h of a record"


def test_merge():
    a, b = Const(1, "x"), Const(2, "y")
    s = Seg(DGROUP, "z")
    assert merge([a, a]) == a
    assert merge([a, b]) == Alt(frozenset({a, b}))
    assert merge([Alt(frozenset({a})), b, s]) == Alt(frozenset({a, b, s}))
    assert merge([a, None]) is None and merge([None, a]) is None
    assert merge([Word(("abs", DGROUP, 1), "w"), Word(("abs", DGROUP, 3), "w")]) is None
    many = [Const(i, "x") for i in range(ALT_MAX + 1)]
    assert merge(many) is None and merge(many[:ALT_MAX]) == Alt(frozenset(many[:ALT_MAX]))


def test_meet_keeps_agreement_and_stack_tops():
    a, b = Const(1, "x"), Const(2, "y")
    s1 = {"ax": a, "bx": a, "cx": a, "@stack": [a, b], "@recent": {"k": a, "j": a}, "@down": True}
    s2 = {"ax": a, "bx": b, "@stack": [b], "@recent": {"k": a, "j": None}, "@down": True}
    m = _meet([s1, s2])
    assert m["ax"] == a and m["bx"] == Alt(frozenset({a, b})) and "cx" not in m
    assert m["@stack"] == [b] and m["@deep"] is True and m["@down"] is True and m["@recent"] == {"k": a}
    same = _meet([{"@stack": [a]}, {"@stack": [a]}])
    assert same == {"@stack": [a], "@recent": {}}
    assert _meet([{"@stack": [], "@deep": True}])["@deep"] is True
    assert "@down" not in _meet([{"@stack": [], "@down": True}, {"@stack": []}])


# ---------------------------------------------------------------- variables


def test_call_through_a_variable_holding_a_constant_pointer():
    parts = [far_var(0x100, 0x30), lcall_mem(0x100), DOS_EXIT]
    _b, _p, _d, an, g = run(code(0x40, {0: b"".join(parts), 0x30: RETF}))
    t = f"{R}:0030"
    [e] = site(g, f"{R}:0000", at(parts, 1))
    assert e["target"] == t and e["through"] == "ds:[0100]" and e["returns"] is True and "provisional" not in e
    assert "pointer-target" in an.root_kinds[t] and g["nodes"][t]["provisional"] is False
    assert an.proof[t] == [f"lcall [0x100] at {R}:000a (stored at {R}:0006)"]
    assert g["nodes"][t]["evidence"][0] == an.proof[t][0]
    assert g["counts"]["resolved_indirect_sites"] == 1 and g["counts"]["unknown_targets"] == 0


def test_copies_between_variables_are_followed():
    # SaveExit := ExitProc; ExitProc := SaveExit (a cycle of copies), then a call through ExitProc
    parts = [far_var(0x100, 0x30),
             b"\xa1\x00\x01\x8b\x16\x02\x01\xa3\x04\x01\x89\x16\x06\x01",  # [104] := [100]
             b"\xa1\x04\x01\x8b\x16\x06\x01\xa3\x00\x01\x89\x16\x02\x01",  # [100] := [104]
             lcall_mem(0x104), DOS_EXIT]
    _b, _p, _d, an, g = run(code(0x40, {0: b"".join(parts), 0x30: RETF}))
    [e] = site(g, f"{R}:0000", at(parts, 3))
    assert e["target"] == f"{R}:0030"
    assert an.proof[f"{R}:0030"] == [f"lcall [0x104] at {R}:0026 (stored at {R}:0006, copied from ds:[0100] at {R}:0011)"]


def test_a_half_copied_variable_is_a_run_time_value():
    # [104] gets [100] in its low word but something else in its high word
    parts = [far_var(0x100, 0x30), b"\xa1\x00\x01\xa3\x04\x01", b"\xed\x89\x16\x06\x01", lcall_mem(0x104), DOS_EXIT]
    _b, _p, _d, _an, g = run(code(0x40, {0: b"".join(parts), 0x30: RETF}))
    [e] = site(g, f"{R}:0000", at(parts, 3))
    assert g["nodes"][e["target"]]["reason"] == f"ds:[0104] is also set from a value computed at run time (at {R}:000d)"


def test_a_variable_also_set_at_run_time_keeps_an_unknown_edge():
    parts = [far_var(0x100, 0x30), b"\xed\xa3\x00\x01", lcall_mem(0x100), DOS_EXIT]  # in ax, dx; mov [100h], ax
    _b, _p, _d, an, g = run(code(0x40, {0: b"".join(parts), 0x30: RETF}))
    es = site(g, f"{R}:0000", at(parts, 2))
    unknown = f"unknown:{R}:{at(parts, 2):04x}"
    assert [e["target"] for e in es] == [f"{R}:0030", unknown]
    assert g["nodes"][unknown]["reason"] == f"ds:[0100] is also set from a value computed at run time (at {R}:{at(parts, 1) + 1:04x})"
    assert es[1]["through"] == "ds:[0100]"


def test_read_modify_write_and_pop_into_a_variable_are_run_time_values():
    rmw = [far_var(0x100, 0x30), b"\xff\x06\x00\x01", lcall_mem(0x100), DOS_EXIT]  # inc word ptr [100h]
    _b, _p, _d, _an, g = run(code(0x40, {0: b"".join(rmw), 0x30: RETF}))
    assert "computed at run time" in g["nodes"][f"unknown:{R}:000e"]["reason"]
    pop = [far_var(0x100, 0x30), b"\x8f\x06\x00\x01", lcall_mem(0x100), DOS_EXIT]  # pop word ptr [100h]
    _b, _p, _d, _an, g = run(code(0x40, {0: b"".join(pop), 0x30: RETF}))
    assert "computed at run time" in g["nodes"][f"unknown:{R}:000e"]["reason"]


def test_nothing_stored_and_nil_only():
    parts = [b"\x31\xc0\xa3\x00\x01\xa3\x02\x01", lcall_mem(0x100), lcall_mem(0x200), DOS_EXIT]  # [100h] := nil
    _b, _p, _d, _an, g = run(code(0x40, {0: b"".join(parts)}))
    assert g["nodes"][f"unknown:{R}:0008"]["reason"] == "nothing stores a constant pointer into ds:[0100]"
    assert g["nodes"][f"unknown:{R}:000c"]["reason"] == "nothing stores a constant pointer into ds:[0200]"


def test_chaining_to_the_previous_interrupt_handler():
    parts = [b"\xb8\x08\x35\xcd\x21",  # mov ax, 3508h; int 21h
             b"\x2e\x89\x1e\x00\x01\x2e\x8c\x06\x02\x01",  # mov cs:[100h], bx; mov cs:[102h], es
             b"\x2e\xff\x2e\x00\x01"]  # ljmp cs:[100h]
    _b, _p, _d, _an, g = run(code(0x20, {0: b"".join(parts)}))
    [e] = site(g, f"{R}:0000", at(parts, 2))
    assert e["through"] == "0000h:[0100]" and e["returns"] is False
    assert g["nodes"][e["target"]]["reason"] == f"the previous INT 08h handler, which DOS returned (INT 21h/35h) at {R}:0003"


def test_near_calls_through_a_variable_and_a_register():
    parts = [store_imm(0x100, 0x30), b"\xff\x16\x00\x01", b"\xb8\x38\x00\xff\xd0", b"\xff\x16\x02\x01", DOS_EXIT]
    _b, _p, _d, an, g = run(code(0x40, {0: b"".join(parts), 0x30: b"\xc3", 0x38: b"\xc3"}))
    assert [e["target"] for e in site(g, f"{R}:0000", at(parts, 1))] == [f"{R}:0030"]
    assert [e["target"] for e in site(g, f"{R}:0000", at(parts, 2) + 3)] == [f"{R}:0038"]
    assert an.proof[f"{R}:0038"] == [f"call ax at {R}:000d (register loaded at {R}:000a)"]
    [e] = site(g, f"{R}:0000", at(parts, 3))
    assert g["nodes"][e["target"]]["reason"] == "nothing stores a constant pointer into ds:[0102]"



# ---------------------------------------------------------------- tables


def table_program(entries: dict[int, int], extra: bytes = b"", base: int = 0x200, near: bool = False):
    body = b"".join((store_imm(base + 2 * i, off) if near else far_var(base + 4 * i, off)) for i, off in entries.items())
    use = (b"\xff\x97" if near else b"\xff\x9d") + w16(base)  # call word ptr [bx + base] / lcall [di + base]
    parts = [body, extra, use, DOS_EXIT]
    procs = {off: (b"\xc3" if near else RETF) for off in entries.values()}
    return parts, code(0x80, {0: b"".join(parts), **procs})


def test_far_table_run():
    parts, root = table_program({0: 0x60, 1: 0x64, 2: 0x68})
    _b, _p, _d, an, g = run(root)
    es = site(g, f"{R}:0000", at(parts, 2))
    assert [e["target"] for e in es] == [f"{R}:0060", f"{R}:0064", f"{R}:0068"]
    assert es[0]["through"] == "ds:[index+0200]"
    assert an.proof[f"{R}:0064"] == [f"lcall [di + 0x200] at {R}:{at(parts, 2):04x} (entry 1 of ds:[index+0200], stored at {R}:0010)"]


def test_table_run_starting_at_entry_one_and_ending_at_a_gap():
    parts, root = table_program({1: 0x60, 2: 0x64, 4: 0x68})
    _b, _p, _d, _an, g = run(root)
    assert [e["target"] for e in site(g, f"{R}:0000", at(parts, 2))] == [f"{R}:0060", f"{R}:0064"]


def test_table_written_through_an_index():
    aligned = b"\x89\x85\x04\x02"  # mov [di + 204h], ax
    parts, root = table_program({0: 0x60, 1: 0x64}, extra=aligned)
    _b, _p, _d, _an, g = run(root)
    es = site(g, f"{R}:0000", at(parts, 2))
    assert g["nodes"][es[-1]["target"]]["reason"] == f"ds:[index+0200] is also written through an index (at {R}:0014)"
    misaligned = b"\x89\x85\x05\x02"  # mov [di + 205h], ax: another array's fields
    parts, root = table_program({0: 0x60, 1: 0x64}, extra=misaligned)
    _b, _p, _d, _an, g = run(root)
    assert not any(e["target"].startswith("unknown:") for e in site(g, f"{R}:0000", at(parts, 2)))


def test_table_with_nothing_stored():
    parts, root = table_program({})
    _b, _p, _d, _an, g = run(root)
    [e] = site(g, f"{R}:0000", at(parts, 2))
    assert g["nodes"][e["target"]]["reason"] == "nothing stores constant pointers into the table at ds:[index+0200]"


def test_table_run_stops_at_its_span(monkeypatch):
    monkeypatch.setattr(pointers, "TABLE_SPAN", 2)
    parts, root = table_program({0: 0x60, 1: 0x64, 2: 0x68})
    _b, _p, _d, _an, g = run(root)
    assert [e["target"] for e in site(g, f"{R}:0000", at(parts, 2))] == [f"{R}:0060", f"{R}:0064"]


def test_segment_word_stored_before_the_offset_and_untracked_moves():
    # mov [102h], cs; mov ss, ax; mov [100h], 30h: the dword completes on its low word
    parts = [store_cs(0x102), b"\x8e\xd0", store_imm(0x100, 0x30), lcall_mem(0x100), DOS_EXIT]
    _b, _p, _d, _an, g = run(code(0x40, {0: b"".join(parts), 0x30: RETF}))
    assert [e["target"] for e in site(g, f"{R}:0000", at(parts, 3))] == [f"{R}:0030"]


def test_vector_outside_its_module_is_no_handler():
    mod = Module(b"\x0e\x1f\xba\x00\x05\xb8\x08\x25\xcd\x21\xcb", [0])  # DS:DX = module:0500, past its end
    b, _p, _d, an, _g = run(code(0x10, {0: DOS_EXIT}), [mod])
    assert an.proof == {} and [p.target for p in an.loads] == [f"{b.module_id(0)}:0500"]


def test_near_table_run():
    parts, root = table_program({0: 0x60, 1: 0x64}, near=True)
    _b, _p, _d, _an, g = run(root)
    assert [e["target"] for e in site(g, f"{R}:0000", at(parts, 2))] == [f"{R}:0060", f"{R}:0064"]


def test_unresolved_jump_table_keeps_the_table_reason():
    _b, _p, _d, _an, g = run(code(0x40, {0: b"\x2e\xff\xa7\x20\x00"}))  # jmp word ptr cs:[bx + 20h], no guard
    reason = g["nodes"][f"unknown:{R}:0000"]["reason"]
    assert reason.startswith("jump table not followed: ")


# ---------------------------------------------------------------- records


def test_record_field_pointers_are_provisional_matches():
    les = b"\xc4\x3e\x00\x04"  # les di, [400h]
    setter = les + b"\x26\xc7\x45\x10\x60\x00" + b"\x26\x8c\x4d\x12" + b"\xc3"  # es:[di+10h] = cs:0060
    builder = les + b"\xfc\xb8\x68\x00\xab\x8c\xc8\xab\xc3"  # cld; stosw cs:0068 into fields +0, +2
    user = (les + b"\x26\xff\x5d\x10") + (les + b"\x26\xff\x1d") + (les + b"\x26\xff\x5d\x14") + b"\xc3"  # a call forgets ES:DI
    root = code(0x80, {0: call(0, 0x20) + call(3, 0x30) + call(6, 0x40) + DOS_EXIT,
                       0x20: setter, 0x30: builder, 0x40: user, 0x60: RETF, 0x68: RETF})
    _b, _p, _d, an, g = run(root)
    [e10] = site(g, f"{R}:0040", 0x44)
    assert e10["target"] == f"{R}:0060" and e10["provisional"] is True
    assert e10["through"] == "field +10h of the record ds:[0400] points at"
    [e0] = site(g, f"{R}:0040", 0x4C)
    assert e0["target"] == f"{R}:0068"
    [e14] = site(g, f"{R}:0040", 0x53)
    assert g["nodes"][e14["target"]]["reason"] == "nothing stores a constant pointer into field +14h of the record ds:[0400] points at"
    assert g["nodes"][f"{R}:0060"]["provisional"] is True and "pointer-target" not in an.root_kinds[f"{R}:0060"]


def test_a_record_pointer_register_follows_constant_adjustments():
    les = b"\xc4\x3e\x00\x04"  # les di, [400h]
    setter = les + b"\x83\xc7\x04" + b"\x26\xc7\x45\x0c\x60\x00" + b"\x26\x8c\x4d\x0e" + b"\xc3"  # add di, 4; es:[di+0ch], [di+0eh]
    user = les + b"\x26\xff\x5d\x10" + b"\xc3"  # lcall es:[di+10h]
    root = code(0x80, {0: call(0, 0x20) + call(3, 0x40) + DOS_EXIT, 0x20: setter, 0x40: user, 0x60: RETF})
    _b, _p, _d, _an, g = run(root)
    [e] = site(g, f"{R}:0040", 0x44)
    assert e["target"] == f"{R}:0060" and e["through"] == "field +10h of the record ds:[0400] points at"


def test_stack_instructions_the_walk_does_not_track_leave_known_variables_alone():
    parts = [far_var(0x100, 0x30),
             b"\x9c\x9d",  # pushf; popf
             b"\x16\x07",  # push ss; pop es: a value that is not tracked
             b"\x50\x83\xc4\x02",  # push ax; add sp, 2: the tracked stack is dropped
             lcall_mem(0x100), DOS_EXIT]
    _b, _p, _d, _an, g = run(code(0x40, {0: b"".join(parts), 0x30: RETF}))
    [e] = site(g, f"{R}:0000", at(parts, 4))
    assert e["target"] == f"{R}:0030"


def test_fields_through_an_unknown_index_or_pointer():
    les = b"\xc4\x3e\x00\x04"
    parts = [les, b"\x26\xff\x19", b"\x26\xff\x5f\x10", DOS_EXIT]  # lcall es:[bx + di]; lcall es:[bx + 10h]
    _b, _p, _d, _an, g = run(code(0x40, {0: b"".join(parts)}))
    for off in (at(parts, 1), at(parts, 2)):
        [e] = site(g, f"{R}:0000", off)
        assert "registers whose values are not known here" in g["nodes"][e["target"]]["reason"]


def test_stosw_direction_and_rep():
    les = b"\xc4\x3e\x00\x04"
    # std: stosw walks down; rep stosw with a known count skips the filled words; unknown count forgets DI
    down = les + b"\xfd\xb8\x60\x00\xab\x8c\xc8\xab"  # std; [+0] = 60h, then [-2] = cs: no dword
    rep = les + b"\xfc\xb9\x02\x00\x31\xc0\xf3\xab\xb8\x60\x00\xab\x8c\xc8\xab"  # skip 4 bytes, then [+4]:[+6]
    lost = les + b"\xfc\xed\x91\xf3\xab\xb8\x64\x00\xab\x8c\xc8\xab"  # cx unknown: DI unknown afterwards
    byte = les + b"\xfc\xaa\xb8\x68\x00\xab\x8c\xc8\xab"  # stosb moves DI by one: [+1]:[+3]
    reps = les + b"\xfc\xb9\x03\x00\xf3\xaa\xb8\x6c\x00\xab\x8c\xc8\xab"  # rep stosb by 3: [+3]:[+5]
    const_di = b"\xbf\x00\x05\x8c\xd8\x8e\xc0\xfc\xb8\x70\x00\xab\x8c\xc8\xab"  # es = ds, di = 500h: ds:[500]
    root = code(0xC0, {0: b"".join(call(3 * i, 0x20 + 0x18 * i) for i in range(6)) + DOS_EXIT,
                       0x20: down + b"\xc3", 0x38: rep + b"\xc3", 0x50: lost + b"\xc3", 0x68: byte + b"\xc3",
                       0x80: reps + b"\xc3", 0x98: const_di + b"\xc3"})
    _b, _p, _d, an, _g = run(root)
    loads = {(p.where[0], p.where[1]) if p.where[0] == "field" else p.where: p.off for p in an.loads}
    assert loads == {("field", 4): 0x60, ("field", 1): 0x68, ("field", 3): 0x6C, ("abs", DGROUP, 0x500): 0x70}


# ---------------------------------------------------------------- stack and calls


def test_retf_with_a_constant_far_pointer_is_a_far_call():
    # push cs; push offset ret; push cs; push 30h... built with registers: mov ax, 30h; mov bx, 0Bh
    body = b"\xbb\x0d\x00\xb8\x30\x00\x0e\x53\x0e\x50\xcb\xc3"
    _b, _p, _d, an, g = run(code(0x40, {0: call(0, 0x10) + DOS_EXIT, 0x10: body, 0x30: RETF}))
    [e] = site(g, f"{R}:0010", 0x1A)
    assert e["target"] == f"{R}:0030" and e["through"] == "far pointer pushed and entered with retf"
    assert an.proof[f"{R}:0030"] == [f"retf at {R}:001a (pushed at {R}:0013)"]


def test_retf_through_a_stored_pointer():
    body = b"\xc4\x1e\x00\x01\xb8\x1f\x00\x0e\x50\x06\x53\xcb\xc3"  # les bx,[100h]; mov ax,1Fh; push cs,ax,es,bx; retf
    _b, _p, _d, an, g = run(code(0x40, {0: far_var(0x100, 0x30) + call(10, 0x10) + DOS_EXIT, 0x10: body, 0x30: RETF}))
    [e] = site(g, f"{R}:0010", 0x1B)
    assert e["target"] == f"{R}:0030" and e["through"] == "ds:[0100] (pushed and entered with retf)" and e["returns"] is True


def test_pointer_arguments_and_callee_pops():
    # push cs; mov ax, 30h; push ax; call f (f: ret 4): a far pointer argument, then the stack is balanced again
    f = b"\xc2\x04\x00"
    body = b"\x0e\xb8\x28\x00\x50" + call(5, 0x40) + b"\x0e\x1f"  # after the call: push cs; pop ds
    vec = b"\xba\x34\x00\xb8\x08\x25\xcd\x21"
    root = code(0x48, {0: body + vec + DOS_EXIT, 0x28: b"\x55\x89\xe5\x5d\xcb", 0x34: b"\xcf", 0x40: f})
    _b, _p, _d, an, g = run(root)
    assert an.address_taken[f"{R}:0028"] == [f"far pointer 0000h:0028 built at {R}:0001, passed to {R}:0040 at {R}:0005"]
    assert g["nodes"][f"{R}:0028"]["provisional"] is True
    assert "interrupt-vector" in an.root_kinds[f"{R}:0034"]  # DS came from the stack after the call


@pytest.mark.parametrize("callee,stack_after", [
    (b"\xc3", ["x", "cs"]),  # ret: no arguments
    (b"\xc2\x02\x00", ["x"]),  # ret 2
    (b"\xc2\x08\x00", []),  # ret 8: more than was tracked
    (b"\xcb", ["x"]),  # retf from a near call: the pushed CS goes too
    (b"\x74\x01\xc3\xc2\x02\x00", []),  # ret and ret 2: unknown
    (b"\xcf", []),  # iret: unknown
    (b"\xeb\xfe", []),  # never returns: unknown
])
def test_callee_pops(callee, stack_after):
    from dosgraph.flow import straight_preds

    root = code(0x40, {0: call(0, 0x10) + DOS_EXIT, 0x10: b"\x53\x0e" + call(0x12, 0x30) + b"\xc3", 0x30: callee})
    b, prog, dec, an, _g = run(root)
    facts = pointers.Facts()
    w = pointers._Walk(prog, dec, facts, None, an.descents)
    seen = {}
    orig = w.step

    def step(fid, d, ins, st):
        orig(fid, d, ins, st)
        if ins.addr == 0x12:
            seen["after"] = ["cs" if isinstance(v, Seg) else "x" for v in st["@stack"]]
            seen["deep"] = st.get("@deep", False)

    w.step = step
    d = an.descents[f"{R}:0010"]
    w.run(f"{R}:0010", d, straight_preds(d), False)
    assert seen["after"] == stack_after
    assert w.pops(None) is None and w.pops("nowhere") is None


def test_dos_keeps_di_and_bios_does_not():
    keep = b"\xbf\x00\x01\xb4\x30\xcd\x21\xff\x15\xc3"  # mov di, 100h; int 21h; call word ptr [di]
    lose = b"\xbf\x00\x01\xb4\x00\xcd\x10\xff\x15\xc3"  # mov di, 100h; int 10h; call word ptr [di]
    root = code(0x60, {0: store_imm(0x100, 0x50) + call(6, 0x20) + call(9, 0x30) + DOS_EXIT,
                       0x20: keep, 0x30: lose, 0x50: b"\xc3"})
    _b, _p, _d, _an, g = run(root)
    assert [e["target"] for e in site(g, f"{R}:0020", 0x27)] == [f"{R}:0050"]
    [e] = site(g, f"{R}:0030", 0x37)  # DI unknown: [di] reads like a table based at 0
    assert g["nodes"][e["target"]]["reason"] == "nothing stores constant pointers into the table at ds:[index+0000]"


def test_interrupt_handlers_start_with_an_unknown_ds():
    # the handler reads [100h] before loading DS: that is not DGROUP's [100h]
    handler = lcall_mem(0x100) + b"\xcf"
    body = b"\x0e\x1f\xba\x40\x00\xb8\x08\x25\xcd\x21"
    _b, _p, _d, an, g = run(code(0x48, {0: far_var(0x100, 0x30) + body + DOS_EXIT, 0x30: RETF, 0x40: handler}))
    [e] = site(g, f"{R}:0040", 0x40)
    assert "not known here" in g["nodes"][e["target"]]["reason"]


# ---------------------------------------------------------------- paths


def test_registers_loaded_together_stay_together():
    # path A: cx:bx = 0:0 (nil); path B: cx:bx = 60h:cs. The pair 60h:0 / 0:cs must never appear.
    body = (b"\x85\xc0\x74\x07"  # test ax, ax; je B
            b"\x31\xc9\x31\xdb\xeb\x05\x90"  # A: xor cx,cx; xor bx,bx; jmp M (+ pad)
            b"\xb9\x60\x00\x8c\xcb"  # B: mov cx, 60h; mov bx, cs
            b"\x89\x0e\x00\x01\x89\x1e\x02\x01" + lcall_mem(0x100) + b"\xc3")  # M: [100h] = bx:cx; lcall [100h]
    _b, _p, _d, an, g = run(code(0x80, {0: call(0, 0x10) + DOS_EXIT, 0x10: body, 0x60: RETF}))
    assert {(p.seg, p.off) for p in an.loads} == {(("para", 0), 0x60)}
    assert [e["target"] for e in g["edges"] if e.get("through") == "ds:[0100]"] == [f"{R}:0060"]


def test_too_many_ways_in_are_joined():
    # nine ways into M, each with its own BX: more than WORLDS states, so M keeps what they agree on. AX is one of
    # two near pointers on every way in, so the join still knows both; BX (nine values) becomes unknown.
    n = pointers.WORLDS + 1
    block = 15  # mov bx, i; mov ax, p; cmp cx, i; jne next; jmp M
    m = 0x10 + block * (n - 1) + 6
    body = b""
    for i in range(n - 1):
        here = 0x10 + block * i
        body += b"\xbb" + w16(i) + b"\xb8" + w16(0xC0 + 2 * (i % 2)) + b"\x81\xf9" + w16(i) + b"\x75\x03"
        body += b"\xe9" + w16(m - (here + block))
    body += b"\xbb" + w16(n) + b"\xb8" + w16(0xC0)  # the last way in falls through
    body += b"\x89\x1e\x02\x01\xa3\x00\x01\xff\x16\x00\x01\xc3"  # M: [102h] = bx; [100h] = ax; call [100h]
    assert 0x10 + len(body) < 0xC0
    _b, _p, _d, an, g = run(code(0x100, {0: call(0, 0x10) + DOS_EXIT, 0x10: body, 0xC0: b"\xc3", 0xC2: b"\xc3"}))
    [r] = [r for r in an.resolved if r.use.ins.text == "call word ptr [0x100]"]
    assert sorted(t.node for t in r.targets) == [f"{R}:00c0", f"{R}:00c2"] and r.reason is None
    assert any(s.where == ("abs", DGROUP, 0x102) and s.value is None for s in pointers.collect(
        _p, _d, an.descents, an.root_kinds, __import__("dosgraph.flow").flow.straight_preds, None).stores)


def test_loops_settle():
    # a counter incremented in a loop never unrolls: the loop head joins
    body = b"\x31\xc0\x40\x3d\x10\x00\x75\xfa\xc3"  # xor ax,ax; L: inc ax; cmp ax,10h; jne L; ret
    _b, _p, _d, an, _g = run(code(0x40, {0: call(0, 0x10) + DOS_EXIT, 0x10: body}))
    assert f"{R}:0010" in an.descents


def test_unsettled_dataflow_fails_loudly(monkeypatch):
    monkeypatch.setattr(pointers, "MAX_PASSES", 1)
    body = b"\x31\xc0\x40\x3d\x10\x00\x75\xfa\xc3"
    with pytest.raises(RuntimeError, match="did not settle in 1 passes"):
        run(code(0x40, {0: call(0, 0x10) + DOS_EXIT, 0x10: body}))


# ---------------------------------------------------------------- DGROUP and emit


def test_dgroup_is_the_first_ds_load_on_the_setup_path():
    # entry: lcall init (0001h:0000); init: mov dx, 0005h (relocated); mov ds, dx; retf
    init = b"\xba\x05\x00\x8e\xda\xcb"
    root = code(0x30, {0: b"\x9a\x00\x00\x01\x00" + DOS_EXIT, 0x10: init})
    b, prog, _dec, an, _g = run(root, relocs=[3, 0x11])
    assert pointers.dgroup(prog, an.descents) == 5
    no_far_call = code(0x30, {0: b"\xba\x06\x00\x8e\xda" + DOS_EXIT})
    _b, prog, _dec, an, _g = run(no_far_call, relocs=[1])
    assert pointers.dgroup(prog, an.descents) == 6
    unknown = code(0x30, {0: b"\x8e\xd8" + DOS_EXIT})  # mov ds, ax: nothing known about ax
    _b, prog, _dec, an, _g = run(unknown)
    assert pointers.dgroup(prog, an.descents) is None
    none = code(0x30, {0: DOS_EXIT})
    _b, prog, _dec, an, _g = run(none)
    assert pointers.dgroup(prog, an.descents) is None
    assert pointers.dgroup(prog, {}) is None
    # the entry's first far call goes nowhere decodable (unrelocated segment): the entry itself is searched
    stray = code(0x30, {0: b"\xba\x07\x00\x8e\xda\x9a\x00\x00\x00\x10" + DOS_EXIT})
    _b, prog, _dec, an, _g = run(stray, relocs=[1])
    assert pointers.dgroup(prog, an.descents) == 7


def test_dgroup_segments_resolve_and_compare_as_ds():
    # init loads DS = 0002h; code stores a pointer with segment 0002h (relocated): that is DGROUP
    init = b"\xba\x02\x00\x8e\xda\xcb"
    body = store_imm(0x100, 0x08) + b"\xc7\x06\x02\x01\x02\x00" + lcall_mem(0x100)
    root = code(0x40, {0: b"\x9a\x00\x00\x03\x00" + body + DOS_EXIT, 0x28: RETF, 0x30: init})
    b, prog, _dec, an, g = run(root, relocs=[3, 0x31, 0x0F])
    assert pointers.dgroup(prog, an.descents) == 2
    assert [p.seg for p in an.loads] == [DGROUP]
    assert [e["target"] for e in g["edges"] if e.get("through") == "ds:[0100]"] == [f"{R}:0028"]


def dgroup_of(data: bytes, name: str) -> int | None:
    prog = Program(data, None, name, None)
    return pointers.dgroup(prog, analyze(prog, Decoder(prog)).descents)


def test_dgroup_from_cs_is_the_code_segment_in_the_load_image():
    assert dgroup_of(b"\x8c\xc8\x8e\xd8\xc3", "A.COM") == 0  # mov ax, cs; mov ds, ax: a .COM's one segment
    # an EXE entered in segment 0002h (a relocated word names it): DGROUP = 0002h
    root = code(0x30, {0x10: b"\x02\x00", 0x20: b"\x8c\xc8\x8e\xd8" + DOS_EXIT})
    assert dgroup_of(mz(root, relocs=[0x10], entry=(2, 0)), "A.EXE") == 2
    assert dgroup_of(b"\x8c\xca\x8e\xd8\xc3", "A.COM") is None  # mov dx, cs; mov ds, ax: DS is not what CS gave


@pytest.mark.parametrize("code,dg", [
    ("8cc805b0028ed8c3", 0x2B0),          # mov ax, cs; add ax, 2b0h; mov ds, ax: the sound drivers
    ("8cc805ffff8ed8c3", 0xFFFF),         # add wraps at 16 bits
    ("8cc805010005ffff8ed8c3", 0x0000),   # two adds: 1 + ffffh wraps to 0
    ("8cc883c0108ed8c3", 0x10),           # add ax, 10h (sign-extended immediate form)
    ("8cc83d01008ed8c3", 0),              # cmp ax, 1 reads ax only
    ("8cc8a900018ed8c3", 0),              # test ax, 100h reads ax only
    ("8cc8508ed8c3", 0),                  # push ax reads ax only
    ("8cc831c08ed8c3", None),             # xor ax, ax overwrites it
    ("8cc801d88ed8c3", None),             # add ax, bx: not a constant
    ("8cc8b800008ed8c3", None),           # mov ax, 0 (not relocated) overwrites it
    ("8cc881c300018ed8c3", 0),            # add bx, 100h: another register
])
def test_dgroup_follows_constant_adds_and_forgets_overwrites(code, dg):
    assert dgroup_of(bytes.fromhex(code), "A.COM") == dg


def test_dgroup_from_cs_in_an_overlay_is_unknown():
    # entry: lcall 0001h:0020h (stub 0 of the overlay); the overlay does mov ax, cs; mov ds, ax: wherever it is loaded
    b, prog, _dec, an, _g = run(b"\x9a\x20\x00\x01\x00" + DOS_EXIT, [Module(b"\x8c\xc8\x8e\xd8" + RETF, [0])], relocs=[3])
    assert b.stub_segments == [1] and f"{b.module_id(0)}:0000" in an.descents
    assert pointers.dgroup(prog, an.descents) is None


def test_pointer_to_no_function_and_evidence_cap():
    # inside an overlay module: a pointer past the module's end resolves to no decoded function
    mod = Module(far_var(0x100, 0x500) + lcall_mem(0x100) + RETF, [0])
    b, _p, _d, an, g = run(code(0x10, {0: DOS_EXIT}), [mod])
    m = b.module_id(0)
    [e] = [e for e in g["edges"] if e["source"] == f"{m}:0000" and e["instruction"] == "lcall [0x100]"]
    assert g["nodes"][e["target"]]["reason"] == f"the stored pointers lead to no decoded function: {m}:0500"
    # one procedure whose pointer is stored six times: the node keeps four lines and a pointer to the rest
    many = b"".join(far_var(0x100 + 4 * i, 0x60) for i in range(6))
    _b, _p, _d, an, g = run(code(0x80, {0: many + DOS_EXIT, 0x60: b"\x55\x89\xe5\x5d\xcb"}))
    ev = g["nodes"][f"{R}:0060"]["evidence"]
    assert len(ev) == 5 and ev[-1] == "(2 more in navigation/analysis.json)"


def test_far_target_of_each_segment_kind(monkeypatch):
    b, prog, _dec, _an, _g = run(code(0x20, {0: DOS_EXIT}))
    assert pointers.far_target(prog, ("space", "MAIN_OVR-x", 0), 0x10010, None) == "MAIN_OVR-x:0010"
    # a segment of a multi-segment space (an RTLink section): offsets count from that segment's base
    assert pointers.far_target(prog, ("space", "TOOL_EXE-0003", 0x7b0), 0xb, None) == "TOOL_EXE-0003:07bb"
    assert pointers.far_target(prog, DGROUP, 0, None) is None
    assert pointers.far_target(prog, DGROUP, 2, 0) == f"{R}:0002"
    assert pointers.far_target(prog, ("para", 0), 0x1, None) == f"{R}:0001"


def test_describe_load_for_every_destination():
    load = lambda where: pointers.PointerLoad(where, ("para", 0x1F), 0x22, "S:2", "S:1", None)  # noqa: E731
    assert pointers.describe_load(load(("abs", DGROUP, 0x10))).endswith("stored into ds:[0010] at S:2")
    assert "stored into field +04h of a record" in pointers.describe_load(load(("field", 4, ("site", "x"))))
    assert "passed to X" in pointers.describe_load(load(("arg", "X")))
    assert "installed as the INT 1Ch handler" in pointers.describe_load(load(("vector", 0x1C)))
    assert pointers.describe_load(load(("retf",))) == "far pointer 001fh:0022 built at S:1, pushed and entered with retf at S:2"
    assert isinstance(PtrLo(("site", "x"), 0, "s"), PtrLo)
