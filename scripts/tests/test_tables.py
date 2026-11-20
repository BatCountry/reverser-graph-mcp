import struct

import pytest
from conftest import DOS_EXIT, Module, RETF, build, call, jmp, mz

from dosgraph.binary import Program
from dosgraph.emit import build_graph, diagnostics, render_listing
from dosgraph.flow import analyze
from dosgraph.tables import Range, _keys, index_range
from dosgraph.x86 import Decoder

R = "MAIN_EXE"


def code(size: int, parts: dict[int, bytes], fill: bytes = b"\x90") -> bytes:
    out = bytearray(fill * size)
    for at, b in parts.items():
        out[at : at + len(b)] = b
    return bytes(out)


def words(*ws: int) -> bytes:
    return b"".join(struct.pack("<H", w) for w in ws)


def run(root: bytes, relocs=()):
    b = build(root, [Module(RETF, [0])], relocs=relocs)
    prog = Program(b.exe, b.ovr)
    dec = Decoder(prog)
    an = analyze(prog, dec, stop_on_fallthrough=True)
    return prog, dec, an, build_graph(prog, dec, an)


def unresolved(an) -> list[str]:
    return [h["detail"] for d in an.descents.values() for h in d.hazards if h["kind"] == "indirect-jmp"]


# The music driver's command dispatch (a root procedure): commands FAh..FFh index a
# cs-relative table after `cmp bl, 0FAh; jae`; one case calls a helper, one loops back.
DISPATCH = {
    0x00: call(0, 0x10) + DOS_EXIT,
    0x10: b"\x8a\x1d",  # mov bl, [di]
    0x12: b"\x80\xfb\xfa",  # cmp bl, 0xfa
    0x15: b"\x73\x03",  # jae 0x1a
    0x17: jmp(0x17, 0x40),
    0x1a: b"\x2a\xff",  # sub bh, bh
    0x1c: b"\x80\xeb\xfa",  # sub bl, 0xfa
    0x1f: b"\x02\xdb",  # add bl, bl
    0x21: b"\x2e\xff\xa7\x60\x00",  # jmp word ptr cs:[bx + 0x60]
    0x26: call(0x26, 0x50) + RETF,
    0x2a: b"\xc3", 0x2c: b"\xc3", 0x2e: b"\xc3", 0x30: b"\xc3",
    0x32: b"\xeb\xdc",  # jmp 0x10
    0x40: b"\xc3",
    0x50: b"\xc3",
    0x60: words(0x26, 0x2A, 0x2C, 0x2E, 0x30, 0x32),
}


def test_guarded_cs_table_is_followed_into_every_case():
    _p, _d, an, g = run(code(0x70, DISPATCH))
    d = an.descents[f"{R}:0010"]
    assert d.tables[0x21].targets == [0x26, 0x2A, 0x2C, 0x2E, 0x30, 0x32]
    assert {0x26, 0x2A, 0x32} <= set(d.insns) and not d.has_ijmp and not unresolved(an)
    assert f"unknown:{R}:0021" not in g["nodes"]
    # the case's call is an edge, guarded by the dispatch's jae
    edge = next(e for e in g["edges"] if e["instruction_offset"] == f"{R}:0026")
    assert edge["target"] == f"{R}:0050" and edge["conditions"][0]["offset"] == f"{R}:0015"
    listing = render_listing(f"{R}:0010", d)
    assert "0021  2effa76000    jmp word ptr cs:[bx + 0x60]\n; jump table cs:0060, index 0x0..0xa step 2 (6 entries): 0026 002a 002c 002e 0030 0032\n" in listing
    assert diagnostics(_p, an)["jump_tables"] == {f"{R}:0021": d.tables[0x21].describe()}


def test_compiler_idiom_bounded_by_fallthrough_guard():
    # cmp bx, 3; ja default; shl bx, 1; jmp cs:[bx + 60h]
    parts = {0: call(0, 0x10) + DOS_EXIT, 0x10: b"\x83\xfb\x03\x77\x2b\xd1\xe3\x2e\xff\xa7\x60\x00",
             0x20: b"\xc3", 0x22: b"\xc3", 0x24: b"\xc3", 0x26: b"\xc3", 0x40: b"\xc3", 0x60: words(0x20, 0x22, 0x24, 0x26)}
    _p, _d, an, _g = run(code(0x70, parts))
    assert an.descents[f"{R}:0010"].tables[0x17].targets == [0x20, 0x22, 0x24, 0x26]


def test_masked_index_through_di():
    # and di, 3; shl di, 1; jmp cs:[di + 60h]
    parts = {0: call(0, 0x10) + DOS_EXIT, 0x10: b"\x83\xe7\x03\xd1\xe7\x2e\xff\xa5\x60\x00",
             0x20: b"\xc3", 0x22: b"\xc3", 0x24: b"\xc3", 0x26: b"\xc3", 0x60: words(0x20, 0x22, 0x24, 0x26)}
    _p, _d, an, _g = run(code(0x70, parts))
    assert an.descents[f"{R}:0010"].tables[0x15].targets == [0x20, 0x22, 0x24, 0x26]


def test_ds_relative_table_needs_the_ds_equals_cs_idiom():
    # mov ax, <this segment>; mov ds, ax; then the dispatch with a DS-relative table
    parts = dict(DISPATCH)
    parts[0x00] = b"\xb8\x00\x00\x8e\xd8" + call(5, 0x10) + DOS_EXIT
    parts[0x21] = b"\xff\xa7\x60\x00\x90"  # jmp word ptr [bx + 0x60]
    _p, _d, an, _g = run(code(0x70, parts), relocs=(1,))
    assert an.descents[f"{R}:0010"].tables[0x21].segment == "ds"
    _p, _d, an, g = run(code(0x70, parts))  # same bytes, but the segment word is not relocated
    assert unresolved(an) == ["ffa76000 jmp word ptr [bx + 0x60]: jump table / computed dispatch, not followed (DS-relative table and DS is not known to equal CS here)"]
    assert f"unknown:{R}:0021" in g["nodes"]


def test_a_case_at_another_function_start_is_a_tail_edge():
    parts = dict(DISPATCH)
    parts[0x60] = words(0x26, 0x2A, 0x2C, 0x2E, 0x30, 0x50)  # 0x50 is called, so it is a function
    _p, _d, an, g = run(code(0x70, parts))
    edge = next(e for e in g["edges"] if e["instruction_offset"] == f"{R}:0021")
    assert edge["target"] == f"{R}:0050" and edge["returns"] is False


def test_guarded_path_entered_elsewhere_is_left_unresolved():
    # jz 0x30 jumps straight to the shl, bypassing the cmp bx, 3 guard
    parts = {0: call(0, 0x10) + DOS_EXIT, 0x10: b"\x74\x1e\x83\xfb\x03\x77\x29\xd1\xe3\x2e\xff\xa7\x60\x00",
             0x20: b"\xc3", 0x22: b"\xc3", 0x24: b"\xc3", 0x26: b"\xc3", 0x30: b"\xeb\xe5", 0x40: b"\xc3",
             0x60: words(0x20, 0x22, 0x24, 0x26)}
    _p, _d, an, _g = run(code(0x70, parts))
    d = an.descents[f"{R}:0010"]
    assert not d.tables and 0x20 not in d.insns
    assert unresolved(an)[0].endswith("(its index range was read from a path with other entries)")


@pytest.mark.parametrize(
    ("jump", "reason"),
    [
        (b"\x2e\xff\xa7\x60\x00", "index range of bx unknown"),  # no guard at all
        (b"\xff\xe3\x90\x90\x90", "jump through a register"),
        (b"\xff\x26\x60\x00\x90", "addressing mode is not [bx|si|di + disp]"),
        (b"\xff\x66\x02\x90\x90", "addressing mode is not [bx|si|di + disp]"),  # [bp + 2]
        (b"\x26\xff\xa7\x60\x00", "table addressed through ES or SS"),
        (b"\x36\xff\xa7\x60\x00", "table addressed through ES or SS"),
        (b"\x2e\xff\x2f\x90\x90", "far jump through a pointer in memory"),
    ],
)
def test_unresolvable_indirect_jumps_say_why(jump, reason):
    parts = {0: call(0, 0x10) + DOS_EXIT, 0x10: jump, 0x60: words(0x20)}
    _p, _d, an, g = run(code(0x70, parts))
    assert unresolved(an)[0].endswith(f"({reason})")
    assert f"unknown:{R}:0010" in g["nodes"] and f"{R}:0010" not in an.noreturn


def test_a_call_between_guard_and_jump_forgets_the_range():
    parts = dict(DISPATCH)
    parts[0x1a] = b"\x2a\xff\xe8\x31\x00"  # sub bh, bh; call 0x50 (the callee may change bx) ...
    parts[0x1f] = b"\x02\xdb"
    parts[0x1c] = b"\xe8\x31\x00"
    _p, _d, an, _g = run(code(0x70, parts))
    assert unresolved(an)[0].endswith("(index range of bx unknown)")


@pytest.mark.parametrize(
    ("entries", "reason"),
    [
        (words(0x26, 0x2A, 0x2C, 0x2E, 0x30, 0xFFF0), "entry 5 target 0xfff0 is not code in MAIN_EXE"),
        (words(0x26, 0x2A, 0x2C, 0x2E, 0x30, 0x44), "entry 5 target 0x44 does not decode"),
    ],
)
def test_entries_must_be_code_in_the_space(entries, reason):
    parts = dict(DISPATCH)
    parts[0x60] = entries
    parts[0x44] = b"\xff\xff"  # ff /7: no such instruction
    _p, _d, an, _g = run(code(0x70, parts))
    assert unresolved(an)[0].endswith(f"({reason})")


def test_table_running_past_the_space():
    parts = dict(DISPATCH)
    parts[0x21] = b"\x2e\xff\xa7\xfe\xff"  # jmp word ptr cs:[bx - 2]: the table wraps to cs:fffe, past the image
    _p, _d, an, _g = run(code(0x70, parts))
    assert unresolved(an)[0].endswith("(table entry 0 at 0xfffe is outside MAIN_EXE)")


def test_entry_into_the_overlay_stub_table():
    b = build(code(0x70, DISPATCH), [Module(RETF, [0])])
    stub_seg = b.stub_segments[0] * 16
    parts = dict(DISPATCH)
    parts[0x60] = words(0x26, 0x2A, 0x2C, 0x2E, 0x30, stub_seg + 0x22)
    _p, _d, an, _g = run(code(0x70, parts))
    assert unresolved(an)[0].endswith(f"(entry 5 target {stub_seg + 0x22:#x} is not code in MAIN_EXE)")


def test_odd_and_huge_index_ranges_are_rejected():
    parts = dict(DISPATCH)
    parts[0x1f] = b"\x90\x90"  # no scaling: index 0..5 step 1
    _p, _d, an, _g = run(code(0x70, parts))
    assert unresolved(an)[0].endswith("(index bx is not a multiple of 2 (Range(lo=0, hi=5, stride=1)))")
    # cmp bx, 0x200; jb; shl bx, 1: 512 entries
    big = {0: call(0, 0x10) + DOS_EXIT, 0x10: b"\x81\xfb\x00\x02\x72\x01\xc3\xd1\xe3\x2e\xff\xa7\x60\x00"}
    _p, _d, an, _g = run(code(0x70, big))
    assert unresolved(an)[0].endswith("(512 entries)")


def test_overlay_cs_table_uses_module_offsets():
    # a module whose entry dispatches through a cs-relative table inside the module
    mod = code(0x40, {0: b"\x83\xfb\x01\x77\x07\xd1\xe3\x2e\xff\xa7\x30\x00", 0x0C: b"\xc3",
                      0x10: b"\xcb", 0x12: b"\xcb", 0x30: words(0x10, 0x12)})
    b = build(call(0, 0x10) + DOS_EXIT + b"\x90" * 7 + b"\xc3", [Module(mod, [0])])
    prog = Program(b.exe, b.ovr)
    an = analyze(prog, Decoder(prog), stop_on_fallthrough=True)
    d = an.descents[f"{b.module_id(0)}:0000"]
    assert d.tables[0x07].targets == [0x10, 0x12]
    assert 0x12 in d.insns


# ---------------------------------------------------------------- the index interpreter on its own


def trail(raw: bytes) -> tuple[Decoder, list]:
    """Decode `raw` as one straight path (the last instruction is the jump)."""
    prog = Program(build(raw + b"\x90" * 16, [Module(RETF, [0])]).exe, build(RETF, [Module(RETF, [0])]).ovr)
    dec = Decoder(prog)
    out, a = [], 0
    while a < len(raw):
        ins = dec(R, a)
        out.append(ins)
        a = ins.end
    return dec, out


JUMP = b"\x2e\xff\xa7\x60\x00"


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        (b"\x80\xfb\x07\x74\x00\x90" + JUMP, None),  # je to the next instruction: no direction
        (b"\x80\xfb\x07\x74\x01\x90" + JUMP, None),  # je skipping one byte: the fallthrough (bl != 7) bounds nothing
        (b"\x80\xfb\x07\x75\x01\x90" + JUMP, None),  # jne falls through: bl == 7, but bh is unknown
        (b"\x80\xfb\x07\x7c\x01\x90" + JUMP, None),  # jl: signed, not used
        (b"\xb3\x05\xb7\x00" + JUMP, Range(5, 5)),  # mov bl, 5; mov bh, 0
        (b"\x3c\x04\x73\x01\x90\x88\xc3\x30\xff" + JUMP, Range(0, 3)),  # cmp al, 4; jae (falls through); mov bl, al; xor bh, bh
        (b"\x3d\x04\x00\x77\x01\x90\x93" + JUMP, Range(0, 4)),  # cmp ax, 4; ja; xchg ax, bx
        (b"\x3d\x04\x00\x77\x01\x90\x87\xc3" + JUMP, Range(0, 4)),  # xchg bx, ax
        (b"\x80\xfb\x05\x77\x01\x90\xb7\x00\x43\x4b\x4b" + JUMP, None),  # bl in 0..5; inc; dec; dec underflows → unknown
        (b"\x80\xfb\x05\x77\x01\x90\xb7\x00\x43\x4b" + JUMP, Range(0, 5)),  # inc then dec
        (b"\x80\xfb\x05\x77\x01\x90\xb7\x00\x83\xc3\x02" + JUMP, Range(2, 7)),  # add bx, 2
        (b"\x80\xfb\x05\x77\x01\x90\xb7\x00\x80\xeb\x01" + JUMP, None),  # sub bl, 1 could wrap
        (b"\x80\xfb\x80\x72\x01\x90\xb7\x00\xd0\xe3" + JUMP, None),  # jb falls through: bl >= 0x80, shl bl, 1 overflows a byte
        (b"\x80\xfb\x05\x77\x01\x90\x8a\x3c" + JUMP, None),  # mov bh, [si]: bh unknown
        (b"\x80\xfb\x05\x77\x01\x90\xb7\x00\x8b\x1c" + JUMP, None),  # mov bx, [si]: forgotten
        (b"\x80\xfb\x05\x8a\x1c\x77\x01\x90\xb7\x00" + JUMP, None),  # bl rewritten between cmp and jcc
        (b"\x80\xfb\x05\x73\x01\x90\x80\xfb\x07\x72\x01\x90\xb7\x00" + JUMP, None),  # bl < 5 and bl >= 7: empty
        (b"\x80\xfb\x05\x77\x01\x90\x80\xfb\x02\x76\x01\x90\xb7\x00" + JUMP, Range(3, 5)),  # bl <= 5, then bl > 2
        (b"\x80\xfb\x05\x76\x01\x90\xb7\x00\x88\xd8\x8a\xc8" + JUMP, Range(6, 255)),  # jbe falls through: bl > 5; copies keep bl
        (b"\x81\xe3\xff\x00\x81\xe3\x0f\x00" + JUMP, Range(0, 15)),  # and twice narrows
        (b"\x80\xfb\x05\x77\x01\x90\xb7\x00\xcd\x10" + JUMP, None),  # int 10h may change bx
        (b"\x8a\xd8\x88\xe7" + JUMP, None),  # copies from untracked registers
        (b"\x80\xfb\x05\x77\x01\x90\xb7\x00\x88\xc0\x8b\xc8" + JUMP, Range(0, 5)),  # unrelated register moves
        (b"\x80\xfb\x05\x77\x01\x90\xb7\x00\x8b\xd9" + JUMP, None),  # mov bx, cx: untracked source
        (b"\x80\xfb\x05\x77\x01\x90\xb7\x00\x88\xc3" + JUMP, None),  # mov bl, al: untracked source
        (b"\x80\xfb\x05\x77\x01\x90\xb7\x00\x86\xc3" + JUMP, None),  # xchg bl, al: untracked source
        (b"\x80\xfb\x05\x77\x01\x90\xb7\x00\x89\xcb\x89\xc3" + JUMP, None),  # mov bx, cx (8B/89 forms)
        (b"\x80\xfb\x05\x77\x01\x90\x83\xeb\x01" + JUMP, None),  # sub bx when only bl is known
        (b"\x80\xfb\x05\x77\x01\x90\xb7\x00\x81\xc3\xff\xff" + JUMP, None),  # add bx, 0ffffh overflows
        (b"\x83\xfb\x05\x77\x01\x90\x30\xff" + JUMP, Range(0, 5)),  # word guard, then xor bh, bh
        (b"\x83\xfb\x05\x77\x01\x90\x88\xe7" + JUMP, None),  # word guard, then bh from ah (unknown)
        (b"\x83\xfb\x05\x77\x01\x90\x80\xc3\x01" + JUMP, Range(1, 6)),  # word guard, byte add on bl (bh stays 0)
        (b"\x80\xff\x00\x75\x01\x90\x80\xfb\x05\x77\x01\x90" + JUMP, Range(0, 5)),  # cmp bh, 0; jne falls through
        (b"\x80\xfb\x05\x75\x01\x90" + JUMP, None),  # jne falls through: bl == 5, bh unknown
        (b"\x80\xfb\x05\x77\x01\x90\xb7\x00\x88\xfd\x88\xef" + JUMP, Range(0, 5)),  # mov ch, bh; mov bh, ch: bh = 0 survives the round trip
        (b"\x80\xfb\x05\x77\x01\x90\xb1\x03\x88\xef" + JUMP, None),  # mov cl, 3; mov bh, ch: ch unknown
        (b"\x80\xfb\x05\x77\x01\x90\xb7\x00\x8e\xc0" + JUMP, Range(0, 5)),  # mov es, ax writes no tracked register
    ],
)
def test_index_range(raw, expected):
    dec, insns = trail(raw)
    found = index_range(dec, insns, "bx")
    assert (found[0] if found else None) == expected


def test_range_clamp():
    r = Range(1, 11, 2)  # 1 3 5 7 9 11
    assert r.clamp(4, 8) == Range(5, 7, 2)
    assert r.clamp(0, 100) == r
    assert r.clamp(12, 20) is None
    assert r.clamp(4, 4) is None  # no progression value in [4, 4]
    assert r.clamp(-5, 1) == Range(1, 1, 2)


# ---------------------------------------------------------------- a counted search loop before the jump

STRIDE1 = "index bx is not a multiple of 2 (Range(lo=97, hi=97, stride=1))"
UNKNOWN = "index range of bx unknown"
SHARED = "its index range was read from a path with other entries"
CASES = [0x40, 0x42, 0x44]


def switch(setup=b"\xb9\x03\x00\xbb\x61\x00", read=b"\x2e\x8b\x07", test=b"\x3b\x46\xf6", step=b"\x83\xc3\x02",
           jump=b"\x2e\xff\x67\x06", loop_to: int | None = None, default: bytes = b"\xc3") -> tuple[dict, int, int]:
    """The search of a value table and the jump through the table behind it, at 10h:
    `mov cx, 3; mov bx, 61h; L: mov ax, cs:[bx]; cmp ax, [bp - 0Ah]; je J; add bx, 2; loop L; jmp 50h; J: jmp cs:[bx + 6]`
    with the values 8, 43h, 58h at 61h and their cases 40h, 42h, 44h at 67h. Returns (parts, L, J)."""
    head = 0x10 + len(setup)
    je = head + len(read) + len(test)
    loop = je + 2 + len(step)
    site = loop + 4
    back = (head if loop_to is None else loop_to) - (loop + 2)
    body = setup + read + test + bytes([0x74, site - (je + 2)]) + step + bytes([0xE2, back & 0xFF, 0xEB, 0x50 - site]) + jump
    return ({0: call(0, 0x10) + DOS_EXIT, 0x10: body, 0x40: b"\xc3", 0x42: b"\xc3", 0x44: b"\xc3", 0x50: default,
             0x61: words(8, 0x43, 0x58), 0x67: words(*CASES)}, head, site)


def test_search_loop_over_a_value_table_is_followed():
    parts, _head, site = switch()
    p, _d, an, _g = run(code(0x70, parts))
    d = an.descents[f"{R}:0010"]
    t = d.tables[site]
    assert t.targets == CASES and t.index == Range(0x61, 0x65, 2) and not unresolved(an) and set(CASES) <= set(d.insns)
    assert t.lines() == ["jump table cs:0006, index 0x61..0x65 step 2 (3 entries): 0040 0042 0044",
                         "value read at 0016 (word ptr cs:[bx]) -> entry: 0008 -> 0040, 0043 -> 0042, 0058 -> 0044"]
    assert f"; {t.lines()[0]}\n; {t.lines()[1]}\n" in render_listing(f"{R}:0010", d)
    assert diagnostics(p, an)["jump_tables"] == {f"{R}:{site:04x}": "; ".join(t.lines())}


@pytest.mark.parametrize(("pieces", "expected"), [
    ({"step": b"\x43\x43\x90"}, CASES),  # inc bx; inc bx
    ({"setup": b"\xb9\x03\x00\xbb\x65\x00", "step": b"\x83\xeb\x02"}, CASES),  # from the last value down: sub bx, 2
    ({"setup": b"\xb9\x01\x00\xbb\x61\x00"}, CASES[:1]),  # one pass
    ({"setup": b"\xb9\x00\x00\xbb\x61\x00"}, UNKNOWN),  # CX = 0 is 65536 passes
    ({"setup": b"\x90\x90\x90\xbb\x61\x00"}, UNKNOWN),  # CX is not known
    ({"test": b"\x41\x90\x90"}, UNKNOWN),  # inc cx inside the loop
    ({"step": b"\x8b\x5e\x02"}, UNKNOWN),  # mov bx, [bp + 2]
    ({"step": b"\x8b\x5e\x02\x43"}, UNKNOWN),  # ... then inc bx
    ({"step": b"\x80\xc3\x02"}, UNKNOWN),  # add bl, 2: a byte step may wrap
    ({"step": b"\x03\xd8\x90"}, UNKNOWN),  # add bx, ax
    ({"read": call(0x16, 0x50)}, UNKNOWN),  # a call inside the loop
    ({"setup": b"\xb9\x03\x00\xbb\xff\xff"}, UNKNOWN),  # runs past FFFFh
    ({"setup": b"\xb9\x03\x00\xbb\x01\x00", "step": b"\x83\xeb\x02"}, UNKNOWN),  # runs below 0
    ({"setup": b"\xb9\x03\x00\x83\xe3\x06"}, UNKNOWN),  # and bx, 6: not one value when the loop starts
    ({"step": b"\x43\x4b\x90"}, STRIDE1),  # inc bx; dec bx: it does not move
    ({"step": b"\x90\x90\x90"}, STRIDE1),
    ({"loop_to": 0x13}, STRIDE1),  # the loop starts at `mov bx, 61h`: one value on every pass
    ({"loop_to": 0x50}, STRIDE1),  # the `loop` goes elsewhere: no loop around this path
    ({"step": call(0x1E, 0x50)}, STRIDE1),  # a call between the branch and the `loop`: not one straight run
    ({"test": b"\xeb\x01\x90"}, STRIDE1),  # a jump inside the loop, before the branch
])
def test_search_loop_shapes(pieces, expected):
    parts, _head, site = switch(**pieces)
    _p, _d, an, _g = run(code(0x70, parts))
    if isinstance(expected, str):
        assert unresolved(an)[0].endswith(f"({expected})")
    else:
        assert an.descents[f"{R}:0010"].tables[site].targets == expected


@pytest.mark.parametrize(("limit", "followed"), [(1, False), (2, True)])
def test_the_loop_instruction_is_looked_for_only_so_far(monkeypatch, limit, followed):
    monkeypatch.setattr("dosgraph.tables.LOOP_TAIL", limit)
    parts, _head, site = switch()
    _p, _d, an, _g = run(code(0x70, parts))
    assert (site in an.descents[f"{R}:0010"].tables) is followed


@pytest.mark.parametrize("into", [0, 3, 8, 11])  # the loop's first instruction, its cmp, the add behind the branch, the `loop`
def test_search_loop_entered_elsewhere_is_left_unresolved(into):
    _parts, head, _site = switch()
    parts, _head, _site = switch(default=jmp(0x50, head + into))
    _p, _d, an, _g = run(code(0x70, parts))
    assert unresolved(an)[0].endswith(f"({SHARED})")


def test_a_range_read_inside_the_loop_does_not_depend_on_it():
    # L: and bx, 2; shl bx, 1; cmp; je J; ...; loop L; J: jmp cs:[bx + 67h], and a jump from elsewhere into the loop's end
    pieces = {"read": b"\x83\xe3\x02\xd1\xe3", "step": b"\x90\x90\x90", "jump": b"\x2e\xff\xa7\x67\x00"}
    _parts, head, _site = switch(**pieces)
    parts, _head, site = switch(**pieces, default=jmp(0x50, head + 10))
    _p, _d, an, _g = run(code(0x70, parts))
    t = an.descents[f"{R}:0010"].tables[site]
    assert t.targets == CASES and t.index == Range(0, 4, 2) and t.loops and t.lines() == [t.describe()]


@pytest.mark.parametrize(("pieces", "read"), [
    ({"read": b"\x2e\x8a\x07", "test": b"\x3a\x46\xf6"}, "0016 (byte ptr cs:[bx]) -> entry: 08 -> 0040, 43 -> 0042, 58 -> 0044"),
    ({"setup": b"\xb9\x03\x00\xbb\x63\x00", "read": b"", "test": b"\x2e\x3b\x47\xfe", "jump": b"\x2e\xff\x67\x04"},
     "0016 (word ptr cs:[bx - 2]) -> entry: 0008 -> 0040, 0043 -> 0042, 0058 -> 0044"),
    ({"setup": b"\xb9\x03\x00\xbb\x5f\x00", "read": b"", "test": b"\x2e\x3b\x47\x02", "jump": b"\x2e\xff\x67\x08"},
     "0016 (word ptr cs:[bx + 2]) -> entry: 0008 -> 0040, 0043 -> 0042, 0058 -> 0044"),
    ({"read": b"\x2e\x89\x07"}, None),  # mov cs:[bx], ax: a store
    ({"read": b"\x2e\x03\x07"}, None),  # add ax, cs:[bx]: not a value compared
    ({"read": b"\x2e\x8b\x87\x00\x7f"}, None),  # mov ax, cs:[bx + 7F00h]: outside the program
    ({"setup": b"\xb9\x03\x00\xbb\x61\x00\x2e\x8b\x07", "read": b"\x90\x90\x90"}, None),  # read before the loop: once, not per pass
])
def test_values_read_through_the_index_register(pieces, read):
    parts, _head, site = switch(**pieces)
    _p, _d, an, _g = run(code(0x70, parts))
    t = an.descents[f"{R}:0010"].tables[site]
    assert t.targets == CASES and t.lines()[1:] == ([f"value read at {read}"] if read else [])


def test_no_value_is_read_on_a_path_that_never_writes_the_register():
    dec, insns = trail(b"\x90" + JUMP)
    assert _keys(dec, b"", 0, insns, "bx", Range(0, 2, 2), 2, []) == ([], "")


@pytest.mark.parametrize(("raw", "expected"), [
    (b"\xb9\x05\x00\xe3\x00" + JUMP, Range(5, 5)),  # jcxz leaves CX alone
    (b"\xb9\x05\x00\xe2\x00" + JUMP, None),  # loop counts it down
    (b"\xb9\x05\x00\xe1\x00" + JUMP, None),  # loope
    (b"\xb9\x05\x00\xe0\x00" + JUMP, None),  # loopne
])
def test_loop_instructions_on_the_path_count_cx_down(raw, expected):
    dec, insns = trail(raw)
    found = index_range(dec, insns, "cx")
    assert (found[0] if found else None) == expected


def test_a_branch_whose_other_way_leaves_the_space_is_no_loop():
    # 0: the jump; 5: mov cx, 3; mov bx, 20h; je 0, the last bytes of the image
    prog = Program(mz(JUMP + b"\xb9\x03\x00\xbb\x20\x00\x74\xf3"), None, "MAIN.EXE")
    dec = Decoder(prog)
    found = index_range(dec, [dec(R, 5), dec(R, 8), dec(R, 0xB), dec(R, 0)], "bx")
    assert found == (Range(0x20, 0x20), 1, [])


# ---------------------------------------------------------------- more shapes


def test_an_index_that_starts_odd_is_followed():
    # cmp bx, 3; ja default; shl bx, 1; inc bx; jmp cs:[bx + 5Fh]
    parts = {0: call(0, 0x10) + DOS_EXIT, 0x10: b"\x83\xfb\x03\x77\x2b\xd1\xe3\x43\x2e\xff\xa7\x5f\x00",
             0x20: b"\xc3", 0x22: b"\xc3", 0x24: b"\xc3", 0x26: b"\xc3", 0x40: b"\xc3", 0x60: words(0x20, 0x22, 0x24, 0x26)}
    _p, _d, an, _g = run(code(0x70, parts))
    t = an.descents[f"{R}:0010"].tables[0x18]
    assert t.index == Range(1, 7, 2) and t.targets == [0x20, 0x22, 0x24, 0x26]


@pytest.mark.parametrize(("load", "known"), [
    (b"\x8c\xc8\x8e\xd8", True),  # mov ax, cs; mov ds, ax
    (b"\x8c\xcf\x8e\xdf", True),  # mov di, cs; mov ds, di
    (b"\x8c\xc8\x8e\xd9", False),  # mov ax, cs; mov ds, cx
    (b"\x8c\xc7\x8e\xd7", False),  # mov di, es; mov ss, di
    (b"\x8c\xd0\x8e\xe0", False),  # mov ax, ss; mov fs, ax
    (b"\x8c\xc8\x8d\xd8", False),  # not `mov ds`
])
def test_ds_relative_table_where_the_segment_loads_ds_from_cs(load, known):
    parts = dict(DISPATCH)
    parts[0x21] = b"\xff\xa7\x60\x00\x90"  # jmp word ptr [bx + 0x60]
    parts[0x6C] = load  # the bytes anywhere in the segment
    _p, _d, an, _g = run(code(0x70, parts))
    assert (0x21 in an.descents[f"{R}:0010"].tables) is known
    if not known:
        assert unresolved(an)[0].endswith("(DS-relative table and DS is not known to equal CS here)")


def test_ds_loaded_from_cs_in_another_segment_says_nothing_here():
    # the relocated word at 7Ch names segment 0007h, which holds the `mov ax, cs; mov ds, ax`
    parts = dict(DISPATCH)
    parts[0x21] = b"\xff\xa7\x60\x00\x90"
    parts[0x74] = b"\x8c\xc8\x8e\xd8"
    parts[0x7C] = b"\x07\x00"
    _p, _d, an, _g = run(code(0x80, parts), relocs=(0x7C,))
    assert unresolved(an)[0].endswith("(DS-relative table and DS is not known to equal CS here)")


def test_cases_past_a_segment_base_a_relocation_names_are_followed():
    # the relocated word at 6Ch names 0003h, a base inside this code: segments are only known from such words, so a
    # case behind one is no evidence against the table
    parts = dict(DISPATCH)
    parts[0x6C] = b"\x03\x00"
    _p, _d, an, _g = run(code(0x70, parts), relocs=(0x6C,))
    assert an.descents[f"{R}:0010"].tables[0x21].targets == [0x26, 0x2A, 0x2C, 0x2E, 0x30, 0x32]


def test_a_case_reached_by_falling_into_it_from_a_loop_below():
    # the last case is 46h; 44h: call ax; 46h: dec di; jnz 44h; ret. Only the table leads to 44h..48h.
    parts = dict(DISPATCH)
    parts[0x44] = b"\xff\xd0\x4f\x75\xfb\xc3"
    parts[0x60] = words(0x26, 0x2A, 0x2C, 0x2E, 0x30, 0x46)
    _p, _d, an, g = run(code(0x70, parts))
    edge = next(e for e in g["edges"] if e["instruction_offset"] == f"{R}:0044")
    assert edge["target"] == f"unknown:{R}:0044"
    # the call runs when the loop goes round (jnz at 47h): its innermost decision
    assert [(c["offset"], c["direction"]) for c in edge["conditions"]] == [(f"{R}:0047", "taken")]
    # every case depends on what the table jump depends on
    case = next(e for e in g["edges"] if e["instruction_offset"] == f"{R}:0026")
    assert [(c["offset"], c["direction"]) for c in case["conditions"]] == [(f"{R}:0015", "taken")]
