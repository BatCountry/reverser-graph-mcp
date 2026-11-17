import struct

import pytest
from conftest import DOS_EXIT, Module, RETF, build, call, jmp

from dosgraph.binary import Program
from dosgraph.emit import build_graph, diagnostics, render_listing
from dosgraph.flow import analyze
from dosgraph.tables import Range, index_range
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
