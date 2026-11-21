import pytest
from conftest import DOS_EXIT, RETF, Module, build, call, jmp

from dosgraph.binary import Program
from dosgraph.emit import build_graph, render_listing
from dosgraph.flow import EXIT, analyze, control_dependence, descend, successors
from dosgraph.x86 import Decoder

R = "MAIN_EXE"


def code(size: int, parts: dict[int, bytes], fill: bytes = b"\x90") -> bytes:
    out = bytearray(fill * size)
    for at, b in parts.items():
        out[at : at + len(b)] = b
    return bytes(out)


def run(root: bytes, modules=None, relocs=(), stop=True):
    b = build(root, modules or [Module(RETF, [0])], relocs=relocs)
    prog = Program(b.exe, b.ovr)
    dec = Decoder(prog)
    an = analyze(prog, dec, stop_on_fallthrough=stop)
    graph = build_graph(prog, dec, an)
    return b, prog, dec, an, graph


def edges_from(graph, src):
    return {e["instruction_offset"]: e for e in graph["edges"] if e["source"] == src}


def hazards(an, kind):
    return [h for d in an.descents.values() for h in d.hazards if h["kind"] == kind]


def test_ret_variants():
    root = code(0x48, {0: call(0, 0x20) + call(3, 0x30) + call(6, 0x40) + DOS_EXIT,
                       0x20: b"\xc2\x04\x00", 0x30: b"\xca\x02\x00", 0x40: b"\xcf"})
    _b, _p, _d, an, g = run(root)
    for f in ("0020", "0030", "0040"):
        assert an.descents[f"{R}:{f}"].has_ret
    assert an.noreturn == {f"{R}:0000"}
    assert all(e["returns"] for e in edges_from(g, f"{R}:0000").values())


def test_noreturn_chain_and_dos_exit_via_ax():
    root = code(0x40, {0: call(0, 0x10) + b"\xc3", 0x10: call(0x10, 0x20) + b"\xc3",
                       0x20: call(0x20, 0x30) + b"\xc3", 0x30: b"\xb8\x00\x4c\xcd\x21"})
    _b, _p, _d, an, g = run(root)
    assert an.noreturn == {f"{R}:{x}" for x in ("0000", "0010", "0020", "0030")}
    assert [e["returns"] for e in g["edges"] if e["source"].startswith(R)] == [False, False, False]
    assert 3 not in an.descents[f"{R}:0000"].insns


def test_int21_without_exit_continues_and_int20_exits():
    root = code(0x20, {0: b"\xb4\x09\xcd\x21\xcd\x20"})
    _b, _p, _d, an, _g = run(root)
    d = an.descents[f"{R}:0000"]
    assert sorted(d.insns) == [0, 2, 4] and 4 in d.term


def test_self_loop_is_noreturn_and_has_no_conditions():
    root = code(0x20, {0: call(0, 0x10) + DOS_EXIT, 0x10: b"\xeb\xfe"})
    _b, _p, _d, an, g = run(root)
    assert f"{R}:0010" in an.noreturn
    assert edges_from(g, f"{R}:0000")[f"{R}:0000"]["returns"] is False
    assert control_dependence(an.descents[f"{R}:0010"]) == {}


def test_recursion_with_condition():
    root = code(0x20, {0: call(0, 0x10) + DOS_EXIT, 0x10: b"\x74\x03" + call(0x12, 0x10) + b"\xc3"})
    _b, _p, _d, an, g = run(root)
    e = edges_from(g, f"{R}:0010")[f"{R}:0012"]
    assert e["target"] == f"{R}:0010" and e["returns"] is True
    assert e["conditions"] == [{"direction": "fallthrough", "expression": "je 0x15", "offset": f"{R}:0010"}]


def test_jump_into_middle_of_instruction():
    root = code(0x20, {0: call(0, 0x10) + DOS_EXIT, 0x10: b"\x74\x01\xb8\xc3\x90\xc3"})
    _b, _p, _d, an, _g = run(root)
    d = an.descents[f"{R}:0010"]
    assert {0x12, 0x13} <= set(d.insns)
    assert [h["addr"] for h in hazards(an, "overlapping-instructions")] == [0x13]
    assert "; overlap" in render_listing(f"{R}:0010", d)


def test_call_to_last_byte_of_module():
    mod = Module(b"\xe8\x01\x00\xcb\xe8", [0])
    b, _p, _d, an, g = run(code(0x10, {0: DOS_EXIT}), [mod])
    last = f"{b.module_id(0)}:0004"
    assert an.descents[last].dirty and last not in an.noreturn
    assert hazards(an, "invalid-opcode-in-flow")
    assert edges_from(g, f"{b.module_id(0)}:0000")[f"{b.module_id(0)}:0000"]["returns"] is True


def test_retf_dispatch_with_and_without_return_address():
    root = code(0x40, {0: call(0, 0x10) + call(3, 0x20) + DOS_EXIT,
                       0x10: b"\xb8\x18\x00\x0e\x50\x06\x53\xcb\xc3",
                       0x20: b"\x0e\x50\x06\x53\xcb"})
    _b, _p, _d, an, g = run(root)
    with_ret, without = an.descents[f"{R}:0010"], an.descents[f"{R}:0020"]
    assert with_ret.cont == {0x17: 0x18} and with_ret.has_ret and f"{R}:0010" not in an.noreturn
    assert successors(with_ret)[0x17] == [(0x18, "")]
    assert without.cont == {} and f"{R}:0020" in an.noreturn
    assert edges_from(g, f"{R}:0010")[f"{R}:0017"] == {
        "conditions": [], "instruction": "retf", "instruction_offset": f"{R}:0017", "return_offset": f"{R}:0018", "returns": True,
        "source": f"{R}:0010", "target": f"unknown:{R}:0017", "through": "far pointer pushed and entered with retf"}
    assert g["nodes"][f"unknown:{R}:0017"]["reason"] == "the far pointer pushed for retf is computed at run time"
    # no return address is known for the second dispatch
    assert edges_from(g, f"{R}:0020")[f"{R}:0024"]["returns"] is False and "return_offset" not in edges_from(g, f"{R}:0020")[f"{R}:0024"]


def test_a_call_edge_names_the_return_address_it_pushes():
    # 00: call 0x20; 03: lcall [0x100]; 07: call 0x10; 0a: jmp 0x30 (a tail jump).   10: call 0x30, then it falls into 0x20
    root = code(0x40, {0: call(0, 0x20) + b"\xff\x1e\x00\x01" + call(7, 0x10) + b"\xeb\x24", 0x10: call(0x10, 0x30),
                       0x20: b"\xc3", 0x30: b"\xc3"})
    _b, _p, _d, _an, g = run(root)
    returns = {(e["instruction_offset"], e["target"]): e.get("return_offset") for e in g["edges"] if e["source"] in (f"{R}:0000", f"{R}:0010")}
    assert returns == {
        (f"{R}:0000", f"{R}:0020"): f"{R}:0003",  # a near call: the next instruction
        (f"{R}:0003", f"unknown:{R}:0003"): f"{R}:0007",  # an indirect far call
        (f"{R}:0007", f"{R}:0010"): f"{R}:000a",
        (f"{R}:000a", f"{R}:0030"): None,  # a jump pushes nothing
        (f"{R}:0010", f"{R}:0030"): f"{R}:0013",
        (f"{R}:001f", f"{R}:0020"): None,  # falling into the next function
    }


def test_basic_blocks_follow_lone_jumps_and_name_what_follows():
    from dosgraph.emit import control_flow
    from dosgraph.flow import basic_blocks

    # 10: je 14; 12: jmp 18; 14: nop; 15: jmp 18; 17: (skipped); 18: ret
    root = code(0x30, {0: call(0, 0x10) + DOS_EXIT, 0x10: b"\x74\x02\xeb\x04\x90\xeb\x01\x90\xc3"}, b"\x90")
    _b, _p, _d, an, _g = run(root)
    blocks, nxt, block_of = basic_blocks(an.descents[f"{R}:0010"])
    assert blocks == {0x10: [0x10], 0x12: [0x12], 0x14: [0x14, 0x15], 0x18: [0x18]}
    assert nxt == {0x10: [(0x14, "taken"), (0x12, "fallthrough")], 0x12: [(0x18, "")], 0x14: [(0x18, "")], 0x18: [(EXIT, "")]}
    assert block_of == {0x10: 0x10, 0x12: 0x12, 0x14: 0x14, 0x15: 0x14, 0x18: 0x18}
    flow = control_flow(an)
    assert flow[f"{R}:0010"] == [
        {"instructions": ["0010"], "next": [["0014", "taken"], ["0012", "fallthrough"]]},
        {"instructions": ["0012"], "next": [["0018", ""]]},
        {"instructions": ["0014", "0015"], "next": [["0018", ""]]},
        {"instructions": ["0018"], "next": [[None, ""]]}]
    # the entry: a call does not end a block; the DOS exit leaves the function
    assert flow[f"{R}:0000"] == [{"instructions": ["0000", "0003", "0005"], "next": [[None, ""]]}] and list(flow) == sorted(flow)


def test_conditions_and_flag_setter():
    root = code(0x60, {0: call(0, 0x10) + DOS_EXIT,
                       0x10: b"\x3d\x01\x00\x74\x05" + call(0x15, 0x40) + b"\xeb\x03" + call(0x1A, 0x50) + b"\xc3",
                       0x40: b"\xc3", 0x50: b"\xc3"})
    _b, _p, _d, an, g = run(root)
    es = edges_from(g, f"{R}:0010")
    assert es[f"{R}:0015"]["conditions"] == [
        {"direction": "fallthrough", "expression": "je 0x1a after cmp ax, 1", "offset": f"{R}:0013"}]
    assert es[f"{R}:001a"]["conditions"][0]["direction"] == "taken"
    assert edges_from(g, f"{R}:0000")[f"{R}:0000"]["conditions"] == []


def test_call_sets_flags_and_merge_point_has_no_setter():
    root = code(0x60, {0: call(0, 0x10) + DOS_EXIT,
                       0x10: call(0x10, 0x40) + b"\x72\x03" + call(0x15, 0x50) + b"\xc3",
                       0x20: b"\x74\x02\xeb\x00\x75\x03" + call(0x26, 0x50) + b"\xc3",
                       0x30: call(0x30, 0x20) + b"\xc3", 0x40: b"\xc3", 0x50: b"\xc3"})
    root = root[:3] + call(3, 0x30) + DOS_EXIT + root[10:]
    _b, _p, _d, an, g = run(root)
    c = edges_from(g, f"{R}:0010")[f"{R}:0015"]["conditions"]
    assert c == [{"direction": "fallthrough", "expression": "jb 0x18 after call 0x40", "offset": f"{R}:0013"}]
    c2 = edges_from(g, f"{R}:0020")[f"{R}:0026"]["conditions"]
    assert c2 == [{"direction": "fallthrough", "expression": "jne 0x29", "offset": f"{R}:0024"}]


def test_loop_body_depends_on_loop_branch():
    root = code(0x40, {0: call(0, 0x10) + DOS_EXIT, 0x10: call(0x10, 0x30) + b"\x49\x75\xfa\xc3", 0x30: b"\xc3"})
    _b, _p, _d, an, g = run(root)
    c = edges_from(g, f"{R}:0010")[f"{R}:0010"]["conditions"]
    assert c == [{"direction": "taken", "expression": "jne 0x10 after dec cx", "offset": f"{R}:0014"}]


def test_far_calls_through_stubs_relocations_and_fixups():
    # root: call far stub 0 of the module (relocated); unrelocated far call; far call into stub header
    seg = 0x40 // 16
    root = code(0x40, {0: b"\x9a\x20\x00" + bytes([seg, 0]) + b"\x9a\x10\x00\x00\x00"
                       + b"\x9a\x02\x00" + bytes([seg, 0]) + DOS_EXIT, 0x30: b"\xc3"})
    mod = Module(b"\x9a\x30\x00\x00\x00\xea\x31\x00\x00\x00", [0], fixups=[3, 8])
    root = root[:0x31] + b"\xc3" + root[0x32:]
    b, prog, _d, an, g = run(root, [mod], relocs=[3, 13])
    mid = b.module_id(0)
    es = edges_from(g, f"{R}:0000")
    assert es[f"{R}:0000"]["target"] == f"{mid}:0000" and es[f"{R}:0000"]["instruction"] == f"lcall {seg}, 0x20"
    assert es[f"{R}:0005"]["target"] == f"unknown:{R}:0005"
    assert es[f"{R}:000a"]["target"] == f"unknown:{R}:000a"
    me = edges_from(g, f"{mid}:0000")
    assert me[f"{mid}:0000"]["target"] == f"{R}:0030"
    assert me[f"{mid}:0005"] | {"conditions": []} == {
        "conditions": [], "instruction": "ljmp 0:0x31", "instruction_offset": f"{mid}:0005",
        "returns": False, "source": f"{mid}:0000", "target": f"{R}:0031"}
    assert "tail-target" in an.root_kinds[f"{R}:0031"]
    assert g["aliases"][f"{seg:04x}:0020"] == f"{mid}:0000"
    assert prog.segment_bases() == [0, 0x40]


def test_indirect_call_and_jump():
    root = code(0x20, {0: call(0, 0x10) + DOS_EXIT, 0x10: b"\xff\xd0\xff\xe0"})
    _b, _p, _d, an, g = run(root)
    es = edges_from(g, f"{R}:0010")
    assert es[f"{R}:0010"]["returns"] is True and es[f"{R}:0012"]["returns"] is False
    assert g["nodes"][f"unknown:{R}:0012"] == {
        "id": f"unknown:{R}:0012", "kind": "unknown-target", "space": None, "address": None,
        "file_offset": None, "source_file": None, "listing": None, "entrypoint": False,
        "reason": "ax holds a value computed at run time"}
    assert f"{R}:0010" not in an.noreturn and hazards(an, "indirect-jmp")


SET_VECTOR_DS_CS = b"\x0e\x1f"  # push cs; pop ds: DS:DX names the handler in this code segment


def test_interrupt_vector_handler():
    root = code(0x30, {0: SET_VECTOR_DS_CS + b"\xb4\x25\xb0\x08\xba\x20\x00\xcd\x21" + DOS_EXIT, 0x20: b"\x50\x58\xcf"})
    _b, _p, _d, an, g = run(root)
    h = f"{R}:0020"
    assert "interrupt-vector" in an.root_kinds[h] and g["nodes"][h]["entrypoint"] is True
    assert an.proof[h] == [f"installed as the INT 08h handler at {R}:0009 (INT 21h/25h)"]
    assert g["nodes"][h]["provisional"] is False


def test_interrupt_vector_needs_a_known_ds():
    # DS still holds DGROUP, whose paragraph this program never names: DS:DX is no known address
    root = code(0x30, {0: b"\xb4\x25\xb0\x08\xba\x20\x00\xcd\x21" + DOS_EXIT, 0x20: b"\x50\x58\xcf"})
    _b, _p, _d, an, _g = run(root)
    assert f"{R}:0020" not in an.descents and an.proof == {}


def test_interrupt_vector_into_shared_code():
    # handler at 0x18 jumps into code reached from the entry: a proven entry may share code
    root = code(0x30, {0: SET_VECTOR_DS_CS + b"\xba\x18\x00\xb8\x08\x25\xcd\x21" + call(0x0A, 0x20) + b"\xc3",
                       0x18: jmp(0x18, 0x21), 0x20: b"\x90\xc3"})
    _b, _p, _d, an, _g = run(root)
    assert "interrupt-vector" in an.root_kinds[f"{R}:0018"]


def test_vector_to_reached_instruction_is_promoted():
    root = code(0x30, {0: SET_VECTOR_DS_CS + b"\xba\x0d\x00\xb8\x08\x25\xcd\x21" + call(0x0A, 0x20) + b"\xc3", 0x20: b"\xc3"})
    _b, _p, _d, an, g = run(root)
    assert "interrupt-vector" in an.root_kinds[f"{R}:000d"] and f"{R}:000d" in an.descents
    assert edges_from(g, f"{R}:0000")[f"{R}:000a"]["target"] == f"{R}:0020"


def anchor(k: int, payload: bytes) -> dict[int, bytes]:
    """Function at k: mov ax, k+4; ret; immediately followed by the candidate bytes."""
    return {k: b"\xb8" + (k + 4).to_bytes(2, "little") + b"\xc3" + payload}


CANDIDATES = {
    "good": b"\x55\x89\xe5\x5d\xc3",
    "string": b"\x05hello",
    "zeros": b"\x00\x00\x00\x00\xc3",
    "zero-run": b"\x90\x00\x00\x00\x00\xc3",
    "loop": b"\xeb\xfe",
    "non8086": b"\x0f\xa2\xc3",
    "mid": b"\xeb\xfb",
    "boundary": b"\xeb\xfd",
    "invalid": b"\xff\xf8",
}


def test_address_taken_validation():
    parts = {}
    anchors = {}
    for i, (name, payload) in enumerate(CANDIDATES.items()):
        k = 0x40 + 0x20 * i
        anchors[name] = k
        parts.update(anchor(k, payload))
    entry = b"".join(call(3 * i, k) for i, k in enumerate(anchors.values()))
    ft = 0x40 + 0x20 * len(anchors)
    parts.update(anchor(ft, b"\x90"))
    parts[ft + 5] = b"\xc3"
    entry += call(len(entry), ft) + call(len(entry) + 3, ft + 5)
    parts[0] = entry + DOS_EXIT
    _b, _p, _d, an, _g = run(code(ft + 0x10, parts))
    accepted = {f"{R}:{anchors[n] + 4:04x}" for n in ("good",)}
    assert accepted <= set(an.descents) and "address-taken" in an.root_kinds[f"{R}:{anchors['good'] + 4:04x}"]
    reasons = {n: an.rejected_pointers.get(f"{R}:{anchors[n] + 4:04x}", [None])[-1] for n in CANDIDATES if n != "good"}
    assert reasons == {
        "string": "length-prefixed string",
        "zeros": "decodes through zero-filled bytes (data)",
        "zero-run": "decodes through zero-filled bytes (data)",
        "loop": "no terminator",
        "non8086": "decodes to non-8086 instructions",
        "mid": "overlaps already-decoded instructions mid-instruction",
        "boundary": "runs into already-decoded instructions",
        "invalid": "decodes into invalid/out-of-space flow",
    }
    assert an.rejected_pointers[f"{R}:{ft + 4:04x}"][-1] == "falls through into an existing function start"


def test_far_pointer_stored_in_memory():
    # mov ax, 20h; mov dx, SEG; mov [100h], ax; mov [102h], dx: a far pointer kept in a variable
    seg = 0x30 // 16
    root = code(0x30, {0: b"\xb8\x20\x00\xba" + bytes([seg, 0]) + b"\xa3\x00\x01\x89\x16\x02\x01" + DOS_EXIT})
    b, _p, _d, an, g = run(root, relocs=[4])
    target = f"{b.module_id(0)}:0000"
    assert an.address_taken[target] == [f"far pointer 0003h:0020 built at {R}:0000, stored into ds:[0100] at {R}:0009"]
    assert "address-taken" in an.root_kinds[target]


def test_far_pointer_in_registers_only_is_not_a_pointer():
    # `mov cx, 21h; mov bx, 714h; mov es, bx`: a count next to a segment, never kept as a
    # dword. Here cx = 0 and bx = 4 (relocated) would read as 0004h:0000, the procedure at 40h.
    root = code(0x48, {0: b"\xb9\x00\x00\xbb\x04\x00\x8e\xc3" + DOS_EXIT, 0x40: b"\x55\x89\xe5\x5d\xc3"})
    _b, _p, _d, an, _g = run(root, relocs=[4])
    assert an.address_taken == {} and an.rejected_pointers == {} and f"{R}:0040" not in an.descents


def test_tail_jump_and_fallthrough_edges():
    root = code(0x30, {0: call(0, 0x10) + call(3, 0x20) + call(6, 0x18) + DOS_EXIT,
                       0x10: jmp(0x10, 0x20), 0x18: b"\x90", 0x19: b"\xc3", 0x20: b"\xc3"})
    root = root[:9] + call(9, 0x19) + DOS_EXIT + root[0x10:]
    _b, _p, _d, an, g = run(root)
    t = edges_from(g, f"{R}:0010")[f"{R}:0010"]
    assert (t["target"], t["returns"], t["instruction"]) == (f"{R}:0020", False, "jmp 0x20")
    f = edges_from(g, f"{R}:0018")[f"{R}:0018"]
    assert (f["target"], f["returns"], f["instruction"]) == (f"{R}:0019", False, "nop")
    assert sorted(an.descents[f"{R}:0018"].insns) == [0x18]
    _b, _p, _d, an2, _g = run(root, stop=False)
    assert sorted(an2.descents[f"{R}:0018"].insns) == [0x18, 0x19]


def test_bad_flow_hazards():
    seg = 0x20 // 16
    mod = Module(b"\xe9\x00\x10" + b"\xe8\x00\x00" + b"\x90", [0, 3])
    root = code(0x20, {0: call(0, 0x10) + call(3, 0x14) + call(6, 0x1F) + DOS_EXIT,
                       0x10: jmp(0x10, 0x22), 0x14: b"\x66\x90\xc3"})
    b, _p, _d, an, g = run(root, [mod])
    kinds = {h["kind"] for d in an.descents.values() for h in d.hazards}
    assert {"unresolvable-jump", "flow-into-overlay-stub-table", "jump-outside-space", "ran-off-space",
            "non-8086-instruction"} <= kinds
    assert edges_from(g, f"{R}:0010")[f"{R}:0010"]["target"] == f"unknown:{R}:0010"
    assert edges_from(g, f"{b.module_id(0)}:0000")[f"{b.module_id(0)}:0000"]["target"] == f"unknown:{b.module_id(0)}:0000"
    assert seg == b.stub_segments[0]


def test_fp_emulator_decoding():
    mod = Module(b"\xcd\x35\x06\x34\x12\xcd\x3c\x26\x47\x08\xcd\x3d\xcd\x3e\x11\xcb\xcd\x35\x06", [0])
    b, prog, dec, an, _g = run(code(0x10, {0: DOS_EXIT}), [mod])
    m = b.module_id(0)
    assert [(i.addr, i.size) for i in an.descents[f"{m}:0000"].insns.values()] == [(0, 5), (5, 5), (10, 2), (12, 3), (15, 1)]
    assert dec(m, 16).kind == "invalid" and dec(m, 0).text == "int 0x35  ; 8087 emulator, operand bytes 063412"
    assert dec(m, 10).text == "int 0x3d" and dec(m, 999) is None
    assert hazards(an, "fp-emulator-int")


def test_stop_on_fallthrough_records_tail():
    root = code(0x20, {0: call(0, 0x10) + call(3, 0x11) + DOS_EXIT, 0x10: b"\x90\xc3"})
    b = build(root, [Module(RETF, [0])])
    prog = Program(b.exe, b.ovr)
    dec = Decoder(prog)
    d = descend(prog, dec, f"{R}:0010", {R: {0x10, 0x11}}, set(), stop_on_fallthrough=True)
    assert d.tails[0][1:] == (f"{R}:0011", "fallthrough") and successors(d)[0x10] == [(EXIT, "")]


@pytest.mark.parametrize("stop", [True, False])
def test_listing_gap_marker(stop):
    root = code(0x20, {0: call(0, 0x10) + DOS_EXIT, 0x10: jmp(0x10, 0x18), 0x18: b"\xc3"})
    _b, _p, _d, an, _g = run(root, stop=stop)
    assert render_listing(f"{R}:0010", an.descents[f"{R}:0010"]) == (
        f"; {R}:0010\n0010  e90500        jmp 0x18\n; ...\n0018  c3            ret\n")


def test_decoder_branches():
    from dosgraph.x86 import pointer_immediate, target_of

    mod = Module(b"\xe2\xfe" + b"\x0f\x84\x00\x00" + b"\xff\x06\x00\x01" + b"\x26\x8b\x05"
                 + b"\xcd\x35\x86\x34\x12" + b"\xcd\x35\xc0" + b"\xcd\x35", [0])
    b, prog, dec, _an, _g = run(code(0x10, {0: DOS_EXIT}), [mod])
    m = b.module_id(0)
    loop, jcc32, inc, seg, fp2, fp3, trunc = (dec(m, a) for a in (0, 2, 6, 10, 13, 18, 21))
    assert (loop.kind, loop.cond, loop.near_target) == ("jcc", 0x12, 0)
    assert (jcc32.kind, jcc32.cond, jcc32.near_target, jcc32.non8086) == ("jcc", 4, 6, True)
    assert inc.kind == "other" and seg.kind == "other" and not seg.non8086
    assert (fp2.size, fp3.size, trunc.kind) == (5, 3, "invalid")
    assert target_of(prog, inc) == (None, "no static target")
    mov_mem = Module(b"\xc7\x06\x00\x01\x34\x12\x68\x78\x56\xcb", [0])
    b2, _p, dec2, _a, _g = run(code(0x10, {0: DOS_EXIT}), [mov_mem])
    assert pointer_immediate(dec2(b2.module_id(0), 0)) == 0x1234
    assert pointer_immediate(dec2(b2.module_id(0), 6)) == 0x5678
    assert pointer_immediate(inc) is None


def test_int21_after_unrelated_instructions_falls_through():
    root = code(0x20, {0: call(0, 0x10) + DOS_EXIT, 0x10: b"\x90\x90\x90\x90\xcd\x21\xc3"})
    _b, _p, _d, an, _g = run(root)
    assert an.descents[f"{R}:0010"].has_ret


def test_retf_dispatch_patterns_without_known_return():
    root = code(0x40, {0: call(0, 0x10) + call(3, 0x20) + DOS_EXIT,
                       0x10: b"\x50\x0e\x06\x53\xcb",
                       0x20: b"\xbb\x18\x00\x0e\x50\x06\x53\xcb"})
    _b, _p, _d, an, _g = run(root)
    assert an.descents[f"{R}:0010"].cont == {} and an.descents[f"{R}:0020"].cont == {}
    assert {f"{R}:0010", f"{R}:0020"} <= an.noreturn


def test_call_past_module_end_and_vector_lookahead_at_end():
    mod = Module(b"\xe8\x00\x10\xcb", [0])
    mod2 = Module(b"\xb4\x25\xba\x00\x00", [0])
    b, _p, _d, an, g = run(code(0x10, {0: DOS_EXIT}), [mod, mod2])
    e = edges_from(g, f"{b.module_id(0)}:0000")[f"{b.module_id(0)}:0000"]
    assert e["target"] == f"unknown:{b.module_id(0)}:0000" and e["returns"] is True
    assert an.descents[f"{b.module_id(1)}:0000"].dirty
    assert not any("interrupt-vector" in k for k in an.root_kinds.values())


def test_far_pointers_invalid_and_unreached():
    # 0005h:0022 lies past the end of the image; 0000h:0040 is an unreached procedure
    root = code(0x48, {0: b"\xb8\x22\x00\xba\x05\x00\xa3\x00\x01\x89\x16\x02\x01"
                          b"\xb8\x40\x00\xba\x00\x00\xa3\x04\x01\x89\x16\x06\x01" + DOS_EXIT,
                       0x40: b"\x55\x89\xe5\x5d\xc3"})
    _b, _p, _d, an, _g = run(root, relocs=[4, 0x11])
    assert an.address_taken == {f"{R}:0040": [f"far pointer 0000h:0040 built at {R}:000d, stored into ds:[0104] at {R}:0016"]}
    assert [p.target for p in an.loads if p.off == 0x22] == [None]


def test_flag_setter_walks_back_within_limit():
    root = code(0x60, {0: call(0, 0x10) + call(3, 0x50) + DOS_EXIT,
                       0x10: b"\x3d\x01\x00" + b"\x90" * 13 + b"\x74\x03" + call(0x22, 0x40) + b"\xc3",
                       0x40: b"\xc3",
                       0x50: b"\x3d\x01\x00\x90\x90\x74\x03" + call(0x57, 0x40) + b"\xc3"})
    _b, _p, _d, _an, g = run(root)
    assert edges_from(g, f"{R}:0010")[f"{R}:0022"]["conditions"][0]["expression"] == "je 0x25"
    assert edges_from(g, f"{R}:0050")[f"{R}:0057"]["conditions"][0]["expression"] == "je 0x5a after cmp ax, 1"


def test_loop_instruction_condition_has_no_flag_setter():
    root = code(0x40, {0: call(0, 0x10) + DOS_EXIT,
                       0x10: b"\xb9\x03\x00" + call(0x13, 0x30) + b"\xe2\xfb\xc3", 0x30: b"\xc3"})
    _b, _p, _d, _an, g = run(root)
    assert edges_from(g, f"{R}:0010")[f"{R}:0013"]["conditions"] == [
        {"direction": "taken", "expression": "loop 0x13", "offset": f"{R}:0016"}]


def test_listing_entry_chunk_first_when_entry_is_mid_chunk():
    from dosgraph.emit import instruction_owners

    root = code(0x20, {0: call(0, 0x12) + DOS_EXIT, 0x10: b"\x90\xc3\xeb\xfc"})
    _b, _p, _d, an, _g = run(root)
    text = render_listing(f"{R}:0012", an.descents[f"{R}:0012"], instruction_owners(an))
    assert text == (f"; {R}:0012\n0012  ebfc          jmp 0x10\n; ...\n"
                    "0010  90            nop\n0011  c3            ret\n")


def test_listing_shared_chunk_labels():
    from dosgraph.emit import instruction_owners

    funcs = [0x20 + 4 * i for i in range(7)]
    parts = {0: b"".join(call(3 * i, f) for i, f in enumerate(funcs)) + DOS_EXIT}
    for f in funcs:
        parts[f] = jmp(f, 0x40)
    parts[0x40] = b"\x90\xc3"
    _b, _p, _d, an, _g = run(code(0x48, parts))
    owners = instruction_owners(an)
    text = render_listing(f"{R}:0020", an.descents[f"{R}:0020"], owners)
    others = ", ".join(f"{R}:{f:04x}" for f in funcs[1:6])
    assert text == (f"; {R}:0020\n0020  e91d00        jmp 0x40\n; ...\n"
                    f"; shared with {others} (1 more)\n0040  90            nop\n0041  c3            ret\n")
    two = run(code(0x48, {0: call(0, 0x20) + call(3, 0x24) + DOS_EXIT, 0x20: jmp(0x20, 0x40),
                          0x24: jmp(0x24, 0x40), 0x40: b"\xc3"}))[3]
    assert f"; shared with {R}:0024\n0040" in render_listing(f"{R}:0020", two.descents[f"{R}:0020"],
                                                            instruction_owners(two))
    entry = render_listing(f"{R}:0000", an.descents[f"{R}:0000"], owners)
    assert "shared" not in entry and entry.startswith(f"; {R}:0000\n0000  e81d00")


def test_far_pointer_guess_never_splits_a_listing():
    # A stored far pointer is a guess like any immediate: landing in decoded code (after a ret, or after the
    # push bp of a procedure, as a constant-heavy startup seemed to) does not cut that code into a new node.
    stores = (b"\xb8\x43\x00\xba\x00\x00\xa3\x00\x01\x89\x16\x02\x01"  # 0000:0043 -> ds:[100], after a ret
              b"\xb9\x61\x00\xbb\x00\x00\x89\x0e\x04\x01\x89\x1e\x06\x01")  # 0000:0061 -> ds:[104], after push bp
    root = code(0x68, {0: stores + call(0x1B, 0x40) + call(0x1E, 0x60) + DOS_EXIT,
                       0x40: b"\x74\x01\xc3\xc3",
                       0x60: b"\x55\x89\xe5\x5d\xc3"})
    _b, _p, _d, an, g = run(root, relocs=[4, 0x11])
    assert an.address_taken == {}
    assert an.rejected_pointers[f"{R}:0043"] == [
        f"far pointer 0000h:0043 built at {R}:0000, stored into ds:[0100] at {R}:0009", "runs into already-decoded instructions"]
    assert an.rejected_pointers[f"{R}:0061"] == [
        f"far pointer 0000h:0061 built at {R}:000d, stored into ds:[0104] at {R}:0017", "runs into already-decoded instructions"]
    assert f"{R}:0061" not in g["nodes"] and len(an.descents[f"{R}:0060"].insns) == 4
