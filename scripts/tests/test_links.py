"""Links between the programs of one game and the batch files that run them (links.py), on synthetic programs
modelled on a sound-driver suite: drivers that stay resident and install INT 66h (DRVA.EXE through a hook record),
MENU.EXE running LOAD.EXE through `Dos.Exec`, LOAD.EXE (Turbo C) opening EGA.DRV, and MAIN.BAT."""

import hashlib
import json

import pytest
from conftest import DOS_EXIT, call, mz
from test_flow import code
from test_pointers import store_cs, store_imm, w16

from dosgraph import game, links
from dosgraph.binary import Program
from dosgraph.emit import build_graph, combine, files_table, write_tree
from dosgraph.errors import FormatError
from dosgraph.flow import analyze
from dosgraph.links import NAME_MAX, Part, Script
from dosgraph.x86 import Decoder

SET_DS_CS = b"\x8c\xc8\x8e\xd8"  # mov ax, cs; mov ds, ax: a driver keeping its data in its code segment
KEEP = b"\xcd\x27\xc3"  # int 27h (terminate and stay resident); ret ends the descent
IRET = b"\xcf"


def com(parts: dict[int, bytes], size: int = 0x40) -> bytes:
    """A .COM file; `parts` keyed by address (the file starts at 100h)."""
    return code(size, {a - 0x100: b for a, b in parts.items()})


def install(vector: int, handler: int) -> bytes:  # mov dx, handler; mov ax, 25xxh; int 21h
    return b"\xba" + w16(handler) + b"\xb8" + bytes([vector, 0x25]) + b"\xcd\x21"


def hook_record(at: int, vector: int, handler: int) -> bytes:
    """[at] = vector, [at+2] = cs:handler: the record a driver hands to their installing routine."""
    return store_imm(at, vector) + store_imm(at + 2, handler) + store_cs(at + 4)


def driver(body: bytes, handler: int = 0x120) -> bytes:
    return com({0x100: SET_DS_CS + body, handler: IRET})


def analysed(data: bytes, name: str) -> Part:
    prog = Program(data, None, name, None)
    dec = Decoder(prog)
    return Part(prog, dec, analyze(prog, dec, stop_on_fallthrough=True))


def graph_of(parts: list[Part]) -> dict:
    return combine([build_graph(p.prog, p.dec, p.an) for p in parts], {}, [], {})


def link_edges(graph: dict, kind: str | None = None) -> list[dict]:
    return [e for e in graph["edges"] if "link" in e and (kind is None or e["link"] == kind)]


def write(tmp_path, files: dict[str, bytes]):
    for name, data in files.items():
        (tmp_path / name).write_bytes(data)
    return tmp_path


# ------------------------------------------------------------------ the SUITE model

PLAY_EXE = mz(code(0x20, {0: b"\xb4\x01\xcd\x66" + DOS_EXIT}))  # mov ah, 1; int 66h
# DRVB: INT 21h/25h for 66h from DS:DX = CS:0120, then chains to the old handler with its own int 66h
DRVB = driver(install(0x66, 0x120) + b"\xcd\x66" + b"\xba\x30\x01" + KEEP)
# DRVA: a hook record [0200] = 66h, [0202] = CS:0120, then stays resident
DRVA = driver(hook_record(0x200, 0x66, 0x120) + b"\xba\x30\x01" + KEEP)
# MENU (Turbo Pascal): Exec(far pointer to the Pascal string 'load.exe' in CS) -> mov ax, 4B00h; int 21h
MENU = mz(code(0x50, {0: b"\x0e\xb8\x40\x00\x50" + call(5, 0x20) + DOS_EXIT,
                         0x20: b"\xb8\x00\x4b\xcd\x21\xc2\x04\x00", 0x40: b"\x08load.exe"}))
# LOAD (Turbo C, DGROUP = 0003h): mov ax, 10h; push ax (the C string EGA.DRV at DGROUP:0010) -> mov ah, 3Dh; int 21h
LOAD = mz(code(0x50, {0: b"\xb8\x03\x00\x8e\xd8\xb8\x10\x00\x50" + call(9, 0x20) + DOS_EXIT,
                      0x20: b"\xb4\x3d\xcd\x21\xc2\x02\x00", 0x40: b"EGA.DRV\x00"}), relocs=[1])
SETUP = mz(code(0x20, {0: DOS_EXIT, 0x10: b"fx.exe\x00"}))  # copies the chosen driver to FX.EXE
MAIN_BAT = b"setup\r\nif exist fx.exe fx\r\nmenu %1 %2 %3 %4\r\nif exist fx.exe fx U\r\n\x1a"
SUITE = {"DRVA.COM": DRVA, "DRVB.COM": DRVB, "PLAY.EXE": PLAY_EXE, "MENU.EXE": MENU, "LOAD.EXE": LOAD,
       "EGA.DRV": b"\xcb", "SETUP.EXE": SETUP, "MAIN.BAT": MAIN_BAT}


@pytest.fixture
def suite(tmp_path):
    return game.build(write(tmp_path, SUITE))


def test_int_66h_goes_to_every_resident_driver_installing_it(suite):
    [hook, direct] = link_edges(suite.graph, "interrupt")
    choice = "; 2 resident programs install it (DRVA.COM, DRVB.COM): the one the player runs"
    assert hook == {
        "conditions": [], "instruction": "int 0x66", "instruction_offset": "PLAY_EXE:0002", "returns": True,
        "source": "PLAY_EXE:0000", "target": "DRVA_COM:0120", "link": "interrupt", "provisional": True,
        "through": "INT 66h, handled by DRVA.COM once it is resident (hook record [0200]: vector 66h stored at "
                   "DRVA_COM:0104, the handler's far pointer at DRVA_COM:0110; stays resident at DRVA_COM:0117)" + choice,
    }
    assert direct["target"] == "DRVB_COM:0120" and "provisional" not in direct
    assert direct["through"] == ("INT 66h, handled by DRVB.COM once it is resident (installed with INT 21h/25h at "
                                 "DRVB_COM:010a; stays resident at DRVB_COM:0111)" + choice)
    # DRVB's own int 66h chains to whatever was installed before it: never linked to DRVA's handler
    assert not [e for e in link_edges(suite.graph) if e["source"].startswith(("DRVB", "DRVA"))]


def test_programs_naming_programs_run_or_load_them(suite):
    [runs] = [e for e in link_edges(suite.graph, "runs") if e["source"] == "MENU_EXE:0000"]
    assert runs == {
        "conditions": [], "instruction": "mov ax, 0x40", "instruction_offset": "MENU_EXE:0001", "returns": True,
        "source": "MENU_EXE:0000", "target": "LOAD_EXE:0000", "link": "runs",
        "through": "the string load.exe built at MENU_EXE:0001; MENU_EXE:0000 reaches DOS exec (INT 21h/4Bh)",
    }
    [loads] = link_edges(suite.graph, "loads")
    assert (loads["source"], loads["instruction_offset"], loads["target"]) == ("LOAD_EXE:0000", "LOAD_EXE:0005", "EGA_DRV:0000")
    assert loads["through"] == ("the string ega.drv built at LOAD_EXE:0005; LOAD_EXE:0000 reaches DOS open (INT 21h/3Dh), "
                                "not exec: the program reads the file")


def test_main_bat_runs_setup_and_control_and_names_the_fx_copy(suite):
    edges = [e for e in link_edges(suite.graph) if e["source"] == "MAIN_BAT:0000"]
    assert [(e["instruction_offset"], e["target"], e["returns"]) for e in edges] == [
        ("MAIN_BAT:0001", "SETUP_EXE:0000", True), ("MAIN_BAT:0002", "unknown:MAIN_BAT:0002", True),
        ("MAIN_BAT:0003", "MENU_EXE:0000", True), ("MAIN_BAT:0004", "unknown:MAIN_BAT:0004", True)]
    assert edges[1]["conditions"] == [{"direction": "taken", "expression": "if exist fx.exe", "offset": "MAIN_BAT:0002"}]
    assert edges[3]["instruction"] == "if exist fx.exe fx U" and edges[2]["conditions"] == []
    for line in (2, 4):
        assert suite.graph["nodes"][f"unknown:MAIN_BAT:{line:04x}"]["reason"] == (
            "no FX.COM / FX.EXE / FX.BAT in the game directory: SETUP.EXE names it (made at run time)")
    assert suite.graph["nodes"]["MAIN_BAT:0000"] == {
        "id": "MAIN_BAT:0000", "kind": "function", "space": "MAIN_BAT", "address": 0, "file_offset": 0,
        "source_file": "MAIN.BAT", "listing": "units/main_bat/functions/MAIN_BAT_0000.asm", "entrypoint": True,
        "provisional": False, "evidence": ["batch file: COMMAND.COM runs it line by line"]}


def test_link_counts_and_the_programs_table(suite):
    c = suite.graph["counts"]
    assert (c["runs_edges"], c["loads_edges"], c["interrupt_edges"], c["batch_files"]) == (5, 1, 2, 1)  # 4 lines + MENU
    assert c["nodes"] == len(suite.graph["nodes"]) and c["edges"] == len(suite.graph["edges"])
    assert c["unknown_targets"] == sum(1 for n in suite.graph["nodes"].values() if n["kind"] == "unknown-target") >= 2
    assert c["entrypoints"] == sum(1 for n in suite.graph["nodes"].values() if n["entrypoint"])
    edges = suite.graph["edges"]
    assert c["conditional_edges"] == sum(1 for e in edges if e["conditions"]) >= 2  # the two `if exist` lines
    assert c["returning_edges"] == sum(1 for e in edges if e["returns"])
    assert c["nonreturning_edges"] == sum(1 for e in edges if not e["returns"])
    assert c["functions"] == sum(1 for n in suite.graph["nodes"].values() if n["kind"] == "function") - c["batch_files"]
    assert suite.graph["programs"]["MAIN.BAT"] == ["MAIN.BAT"]
    assert suite.graph["provenance"]["files"]["MAIN.BAT"] == hashlib.sha256(MAIN_BAT).hexdigest()
    assert [s.name for s in suite.scripts] == ["MAIN.BAT"]


# ------------------------------------------------------------------ evidence inside one program


def test_ah_at_each_int_site_per_path():
    # test al, al; jz L; mov ah, 4Bh; jmp J; L: mov ah, 3Dh; J: int 21h; mov ah, [0010h]; int 21h; int 66h (AH 4Bh)
    body = {0: b"\x84\xc0\x74\x04\xb4\x4b\xeb\x02\xb4\x3d\xcd\x21\x8a\x26\x10\x00\xcd\x21\xb4\x4b\xcd\x66" + DOS_EXIT}
    an = analysed(mz(code(0x30, body)), "A.EXE").an
    sites = links.int_sites(an)
    assert sites["A_EXE:000a"] == (0x21, {0x4B, 0x3D})
    assert sites["A_EXE:0010"] == (0x21, {None})  # AH read from memory: not a constant
    assert links.dos_sites(an, 0x4B) == {"A_EXE:000a"}  # the INT 66h with AH 4Bh is no DOS call
    assert links.dos_sites(an, 0x3D) == {"A_EXE:000a"} and links.dos_sites(an, 0x3E) == set()


@pytest.mark.parametrize("body,site", [
    (b"\xcd\x27", "A_COM:0100"),  # int 27h
    (b"\xb4\x31\xcd\x21", "A_COM:0102"),  # DOS keep process
    (b"\xb8\x00\x31\xcd\x21", "A_COM:0103"),
    (b"\xb4\x30\xcd\x21\xb4\x32\xcd\x21\xb4\x4c\xcd\x21", None),  # 30h, 32h, 4Ch: not resident
    (b"\x8a\x26\x10\x00\xcd\x21", None),  # AH unknown
    (b"\xb4\x31\xcd\x66", None),  # AH 31h on another interrupt
    (b"\x74\x02\xcd\x27\xb4\x31\xcd\x21", "A_COM:0102"),  # the first of two sites
])
def test_resident(body, site):
    assert links.resident(analysed(com({0x100: body + b"\xc3"}), "A.COM").an) == site


def test_installs_through_int_21h_25h_once_per_handler():
    an = analysed(driver(install(0x66, 0x120) + install(0x66, 0x120) + install(0x67, 0x120) + b"\xc3"), "A.COM").an
    assert links.installs(an) == {0x66: [("A_COM:0120", "installed with INT 21h/25h at A_COM:010a", False)],
                                  0x67: [("A_COM:0120", "installed with INT 21h/25h at A_COM:011a", False)]}


def test_a_handler_outside_the_programs_code_is_not_installed():
    # DS:DX = CS:0080 is in a .COM's PSP: no code there
    an = analysed(driver(install(0x66, 0x80) + b"\xc3"), "A.COM").an
    assert an.facts.vectors == [("A_COM:0080", 0x66, "A_COM:010a")] and links.installs(an) == {}


def test_a_handler_installed_for_a_vector_that_is_not_a_constant():
    # mov al, [0200h]; mov dx, 0120h; mov ah, 25h; int 21h: a handler, for a vector only the run knows
    an = analysed(driver(b"\xa0\x00\x02\xba\x20\x01\xb4\x25\xcd\x21\xc3"), "A.COM").an
    assert an.facts.vectors == [("A_COM:0120", None, "A_COM:010c")] and links.installs(an) == {}
    assert "interrupt-vector" in an.root_kinds["A_COM:0120"]
    assert an.proof["A_COM:0120"] == ["installed as an interrupt handler (the vector number is not a constant there) at A_COM:010c (INT 21h/25h)"]


@pytest.mark.parametrize("vector,found", [(0, True), (0x66, True), (0xFF, True), (0x100, False), (0xFFFF, False)])
def test_hook_record_vector_range(vector, found):
    an = analysed(driver(hook_record(0x200, vector, 0x120) + b"\xc3"), "A.COM").an
    expect = {vector: [("A_COM:0120", f"hook record [0200]: vector {vector:02X}h stored at A_COM:0104, the handler's "
                                      "far pointer at A_COM:0110", True)]}
    assert links.installs(an) == (expect if found else {})


def test_hook_record_wraps_at_the_segment_start():
    # [0000] = CS:0120 with the vector in the word before it, [FFFE]
    an = analysed(driver(store_imm(0xFFFE, 0x66) + store_imm(0, 0x120) + store_cs(2) + b"\xc3"), "A.COM").an
    [(handler, evidence, provisional)] = links.installs(an)[0x66]
    assert handler == "A_COM:0120" and evidence.startswith("hook record [fffe]: vector 66h") and provisional


ARGUMENT = store_imm(0x200, 0x66) + b"\x0e\xb8\x20\x01\x50"  # [0200] = 66h; push cs; mov ax, 0120h; push ax


@pytest.mark.parametrize("body,at_130", [
    (store_imm(0x1FC, 0x66) + store_imm(0x202, 0x120) + store_cs(0x204), b""),  # not the word before the pointer
    (b"\xa3\x00\x02" + store_imm(0x202, 0x120) + store_cs(0x204), b""),  # mov [0200], ax: a run-time vector number
    (hook_record(0x200, 0x66, 0x130), bytes(8)),  # the pointer leads to no decoded function (zero bytes)
    (ARGUMENT + call(0x104 + len(ARGUMENT), 0x130), b"\xc2\x04\x00"),  # the pointer is an argument, not stored
])
def test_no_hook_record(body, at_130):
    data = com({0x100: SET_DS_CS + body + b"\xc3", 0x120: IRET, 0x130: at_130})
    assert links.installs(analysed(data, "A.COM").an) == {}


def test_a_handler_installed_both_ways_is_one_proven_handler():
    an = analysed(driver(install(0x66, 0x120) + hook_record(0x200, 0x66, 0x120) + b"\xc3"), "A.COM").an
    assert links.installs(an) == {0x66: [("A_COM:0120", "installed with INT 21h/25h at A_COM:010a", False)]}


def test_closure_follows_calls_but_not_links():
    graph = {"edges": [{"source": "a", "target": "b"}, {"source": "b", "target": "c"}, {"source": "c", "target": "a"},
                       {"source": "c", "target": "x", "link": "interrupt"}, {"source": "d", "target": "a"}]}
    adj = links.adjacency(graph)
    assert adj == {"a": {"b"}, "b": {"c"}, "c": {"a"}, "d": {"a"}}
    assert links.closure(adj, "a") == {"a", "b", "c"} and links.closure(adj, "d") == {"a", "b", "c", "d"}
    assert links.closure(adj, "x") == {"x"}


# ------------------------------------------------------------------ string constants


P127 = bytes([0x7F]) + b"a" * 127
C127 = b"!" * 127 + b"\x00"  # a first byte of 21h also reads as a Pascal string of 33 bytes


@pytest.mark.parametrize("data,off,texts", [
    (b"\x08load.exe", 0, ["load.exe"]),
    (b"\x08load.exe\x00", 0, ["load.exe"]),  # the length byte is not printable: no C string
    (b"EGA.DRV\x00", 0, ["EGA.DRV"]),
    (b"xEGA.DRV\x00", 1, ["EGA.DRV"]),
    (b"\x01a", 0, ["a"]),
    (b"!" + b"x" * 0x21 + b"\x00", 0, ["x" * 0x21, "!" + "x" * 0x21]),  # both readings
    (P127, 0, ["a" * 127]),  # NAME_MAX
    (bytes([0x80]) + b"a" * 128, 0, []),  # one longer
    (C127, 0, ["!" * 33, "!" * 127]),
    (b"!" * 128 + b"\x00", 0, ["!" * 33]),  # no NUL within NAME_MAX + 1 bytes
    (b"\x00abc", 0, []),  # empty Pascal string, empty C string
    (b"\x05ab", 0, []),  # truncated, and no NUL
    (b"abc", 0, []),  # a C string running off the end
    (b"\x03a b\x00", 0, []),  # space: not a file name byte
    (b"\x03a\x7fb", 0, []), (b"\x03a\x1fb", 0, []), (b"\x03!~!", 0, ["!~!"]),
    (b"a\x00", 1, []), (b"ab\x00", 1, ["b"]),
    (b"a\x00", 2, []), (b"a\x00", -1, []), (b"", 0, []),
])
def test_string_at(data, off, texts):
    assert NAME_MAX == 127 and links.string_at(data, off) == texts


@pytest.mark.parametrize("text,name", [
    ("C:\\GAME\\load.exe", "LOAD.EXE"), ("a:fx.exe", "FX.EXE"), ("suite/ega.drv", "EGA.DRV"), ("Load.Exe", "LOAD.EXE"),
    ("C:\\GAME\\", ""), ("", ""),
])
def test_file_name(text, name):
    assert links.file_name(text) == name


# ------------------------------------------------------------------ name references


def namer(load: bytes, string_at: int, string: bytes, relocs=(), service: bytes = b"\xb4\x3d\xcd\x21") -> bytes:
    """`load` (pushes the string's address) then a call to 0030: `service`; ret 4 (callee pops its arguments)."""
    parts = {0: load + call(len(load), 0x30) + DOS_EXIT, 0x30: service + b"\xc2\x04\x00", string_at: string}
    return mz(code(0x60, parts), relocs=relocs)


DS_3 = b"\xb8\x03\x00\x8e\xd8"  # mov ax, 0003h (relocated); mov ds, ax: DGROUP:0020 is offset 50h
PASCAL, C = b"\x08load.exe", b"C:\\SUITE\\LOAD.EXE\x00"


@pytest.mark.parametrize("load,relocs,string,refs", [
    (b"\x0e\xb8\x50\x00\x50", (), PASCAL, [("A_EXE:0000", "A_EXE:0001", "LOAD.EXE")]),  # push cs; mov ax, 50h; push ax
    (DS_3 + b"\xb8\x20\x00\x50\x50", [1], C, [("A_EXE:0000", "A_EXE:0005", "LOAD.EXE")]),  # mov ax, 20h; push ax
    (DS_3 + b"\x68\x20\x00\x50", [1], C, [("A_EXE:0000", "A_EXE:0005", "LOAD.EXE")]),  # push 20h
    (DS_3 + b"\x1e\xb8\x20\x00\x50", [1], C, [("A_EXE:0000", "A_EXE:0006", "LOAD.EXE")]),  # push ds too: far and near, once
    (DS_3 + b"\xb0\x20\x50\x50", [1], C, []),  # mov al, 20h: no offset
    (DS_3 + b"\xc7\x06\x00\x01\x20\x00\x50", [1], C, []),  # mov [0100h], 20h: a store, not a reference
    (b"\xb8\x50\x00\x50\x50", (), C, []),  # no DGROUP: a near offset into nothing known
    (DS_3 + b"\xb8\xf0\xff\x50\x50", [1], C, []),  # past the image
    (DS_3 + b"\xb8\x20\x00\x50\x50", [1], b"\x08load\x01exe", []),  # not a printable name
])
def test_name_references(load, relocs, string, refs):
    assert links.name_references(analysed(namer(load, 0x50, string, relocs), "A.EXE")) == refs


# ------------------------------------------------------------------ runs / loads


def target(name: str) -> Part:
    return analysed(mz(code(0x10, {0: DOS_EXIT})), name)


def program_links(*parts: Part) -> list[tuple[str, str, str, str]]:
    return [(e["link"], e["source"], e["instruction_offset"], e["target"])
            for e in links.program_edges(list(parts), graph_of(list(parts)))]


EXEC, OPEN = b"\xb8\x00\x4b\xcd\x21", b"\xb4\x3d\xcd\x21"  # mov ax, 4B00h; int 21h / mov ah, 3Dh; int 21h
FAR_LOAD = b"\x0e\xb8\x50\x00\x50"  # push cs; mov ax, 50h; push ax: the far pointer to 'load.exe'


@pytest.mark.parametrize("service,link", [
    (EXEC, "runs"), (OPEN, "loads"), (OPEN + EXEC, "runs"), (EXEC + OPEN, "runs"),
    (b"\xb4\x09\xcd\x21", None),  # print string: neither
    (b"\xb4\x4b\xcd\x66", None),  # AH 4Bh on another interrupt
    (b"\x8a\x26\x10\x00\xcd\x21", None),  # AH unknown
    (b"", None),
])
def test_the_dos_service_the_function_reaches_decides_the_link(service, link):
    a = analysed(namer(FAR_LOAD, 0x50, PASCAL, service=service), "A.EXE")
    assert program_links(a, target("LOAD.EXE")) == ([(link, "A_EXE:0000", "A_EXE:0001", "LOAD_EXE:0000")] if link else [])


@pytest.mark.parametrize("at_40,link", [
    (b"\xc2\x04\x00", None),  # its caller reaches exec through a sibling call: not the naming function
    (call(0x40, 0x30) + b"\xc2\x04\x00", "runs"),  # through a call chain
])
def test_only_what_the_naming_function_reaches_counts(at_40, link):
    # main: call 10h; call 30h. 10h: names load.exe, calls 40h. 30h: exec. 40h: `at_40`.
    root = code(0x60, {0: call(0, 0x10) + call(3, 0x30) + DOS_EXIT, 0x10: FAR_LOAD + call(0x15, 0x40) + b"\xc3",
                       0x30: EXEC + b"\xc3", 0x40: at_40, 0x50: PASCAL})
    a = analysed(mz(root), "A.EXE")
    assert program_links(a, target("LOAD.EXE")) == ([(link, "A_EXE:0010", "A_EXE:0011", "LOAD_EXE:0000")] if link else [])


@pytest.mark.parametrize("name", ["A.EXE", "README.TXT", "LOAD.COM", "LOAD"])
def test_names_of_itself_or_of_no_program_are_not_links(name):
    a = analysed(namer(FAR_LOAD, 0x50, bytes([len(name)]) + name.lower().encode(), service=EXEC), "A.EXE")
    assert program_links(a, target("LOAD.EXE")) == []


def test_a_com_target_is_its_entry_at_100h():
    a = analysed(namer(FAR_LOAD, 0x50, b"\x09sound.com", service=OPEN), "A.EXE")
    sound = analysed(com({0x100: b"\xc3"}), "SOUND.COM")
    assert program_links(a, sound) == [("loads", "A_EXE:0000", "A_EXE:0001", "SOUND_COM:0100")]


def test_a_driver_with_its_data_in_cs_names_files_by_near_offsets():
    # mov ax, cs; mov ds, ax; mov dx, 0130h; mov ax, 3D00h; int 21h: DGROUP is the code segment
    loader = com({0x100: SET_DS_CS + b"\xba\x30\x01\xb8\x00\x3d\xcd\x21\xc3", 0x130: b"SOUND.COM\x00"})
    a = analysed(loader, "LOAD.COM")
    assert a.an.dgroup == 0
    assert program_links(a, analysed(com({0x100: b"\xc3"}), "SOUND.COM")) == [("loads", "LOAD_COM:0100", "LOAD_COM:0104", "SOUND_COM:0100")]


# ------------------------------------------------------------------ interrupt links


def interrupt_links(files: dict[str, bytes]) -> list[tuple[str, str, str, bool]]:
    parts = [analysed(data, name) for name, data in files.items()]
    return [(e["source"], e["target"], e["through"], e.get("provisional", False)) for e in links.interrupt_edges(parts)]


def test_one_resident_supplier_is_no_choice():
    [(source, handler, through, provisional)] = interrupt_links({"PLAY.EXE": PLAY_EXE, "DRVB.COM": DRVB})
    assert (source, handler, provisional) == ("PLAY_EXE:0000", "DRVB_COM:0120", False)
    assert through.endswith("stays resident at DRVB_COM:0111)")


def test_dos_keep_process_is_resident_too():
    keep = driver(install(0x66, 0x120) + b"\xb8\x00\x31\xcd\x21\xc3")
    [(_s, handler, through, _p)] = interrupt_links({"PLAY.EXE": PLAY_EXE, "KEEP.COM": keep})
    assert handler == "KEEP_COM:0120" and "stays resident at KEEP_COM:010f" in through


def test_a_program_that_does_not_stay_resident_supplies_nothing():
    gone = driver(install(0x66, 0x120) + DOS_EXIT + b"\xc3")
    assert interrupt_links({"PLAY.EXE": PLAY_EXE, "GONE.COM": gone}) == []


def test_a_program_installing_the_vector_itself_is_not_linked_for_it():
    # SETUP installs its own 66h handler (not resident) and calls int 66h: its own handler, not DRVB's
    setup = driver(install(0x66, 0x120) + b"\xb4\x01\xcd\x66" + DOS_EXIT + b"\xc3")
    assert [s for s, *_ in interrupt_links({"SETUP.COM": setup, "DRVB.COM": DRVB, "PLAY.EXE": PLAY_EXE})] == ["PLAY_EXE:0000"]


def test_several_handlers_of_one_program_are_no_choice():
    two = com({0x100: SET_DS_CS + install(0x66, 0x130) + hook_record(0x200, 0x66, 0x138) + KEEP, 0x130: IRET, 0x138: IRET})
    found = interrupt_links({"PLAY.EXE": PLAY_EXE, "TWO.COM": two})
    assert [(h, p) for _s, h, _t, p in found] == [("TWO_COM:0130", False), ("TWO_COM:0138", True)]
    assert not any("resident programs install it" in t for _s, _h, t, _p in found)


def test_an_interrupt_site_keeps_its_conditions():
    play_exe = mz(code(0x20, {0: b"\x84\xc0\x74\x02\xcd\x66" + DOS_EXIT}))  # test al, al; je 6; int 66h
    [edge] = links.interrupt_edges([analysed(play_exe, "PLAY.EXE"), analysed(DRVB, "DRVB.COM")])
    assert edge["conditions"] == [{"direction": "fallthrough", "expression": "je 6 after test al, al", "offset": "PLAY_EXE:0002"}]
    assert (edge["instruction"], edge["instruction_offset"]) == ("int 0x66", "PLAY_EXE:0004")


def test_other_vectors_are_not_linked():
    play_exe = mz(code(0x20, {0: b"\xcd\x67\xcd\x21" + DOS_EXIT}))
    assert interrupt_links({"PLAY.EXE": play_exe, "DRVB.COM": DRVB}) == []


# ------------------------------------------------------------------ batch files


def test_script_lines_stop_at_ctrl_z_and_decode_cp437():
    s = Script("Main.BAT", b"echo off\r\ncaf\x82\nlast\x1afx\r\nmore")
    assert s.lines == ["echo off", "caf\u00e9", "last"]
    assert (s.space, s.node_id, s.listing) == ("MAIN_BAT", "MAIN_BAT:0000", "units/main_bat/functions/MAIN_BAT_0000.asm")
    assert s.render() == ("; MAIN_BAT:0000 (batch file; addresses are line numbers)\n"
                          f"0001  {'':12}  echo off\n0002  {'':12}  caf\u00e9\n0003  {'':12}  last\n")
    assert Script("E.BAT", b"").lines == [] and Script("E.BAT", b"\x1a").render() == "; E_BAT:0000 (batch file; addresses are line numbers)\n"


def commands(*lines: str):
    return links.batch_commands(Script("T.BAT", "\r\n".join(lines).encode()))


@pytest.mark.parametrize("line", [
    "", "   ", "@echo off", "echo.", "echo+", "cd..", "cd\\save", "CD\\SAVE", "chdir/x", "path=c:\\suite", "rem fx", "cls",
    "a:", "C:", "%1:", ":end", ":", "if exist fx.exe", "if", "if not", "if errorlevel", "call", "goto", "goto end",
    "> log", ">", ">>log", "|", "echo off>nul", "echo off > nul",
    "call echo hi", "CALL cls", "call cd..", "if exist x call echo.",  # CALL of an internal command runs no program
    "if a == b", "if a==", "if a ==", "if a== ", "if not a == b",
])
def test_lines_running_no_program(line):
    assert commands(line) == []


@pytest.mark.parametrize("line,command,conds,called", [
    ("fx", "fx", [], False),
    ("@FX U", "FX", [], False),
    ("fx > nul", "fx", [], False), ("fx >nul", "fx", [], False), (">log fx", "fx", [], False),
    ("fx < keys", "fx", [], False), ("fx>nul", "fx", [], False), ("fx>>log", "fx", [], False),
    ("> nul fx", "fx", [], False), (">>log<keys fx", "fx", [], False), ("fx > ", "fx", [], False),
    ("C:\\SUITE\\menu %1", "C:\\SUITE\\menu", [], False),
    ("cdrom", "cdrom", [], False),  # a name merely starting like an internal command
    ("echoes", "echoes", [], False),
    ("if exist fx.exe fx", "fx", ["if exist fx.exe"], False),
    ("IF NOT EXIST fx.exe start1", "start1", ["IF NOT EXIST fx.exe"], False),
    ("if errorlevel 2 fx", "fx", ["if errorlevel 2"], False),
    ("if not errorlevel 2 fx", "fx", ["if not errorlevel 2"], False),
    ("if %1==U fx", "fx", ["if %1==U"], False),
    ("if not %1==U fx", "fx", ["if not %1==U"], False),
    ("if a== b fx", "fx", ["if a== b"], False),
    ("if a ==b fx", "fx", ["if a ==b"], False),
    ('if "%1" == "x" fx U', "fx", ['if "%1" == "x"'], False),
    ("if not a== b fx", "fx", ["if not a== b"], False),
    ("if not a ==b fx", "fx", ["if not a ==b"], False),
    ('IF NOT "%1" == "x" fx', "fx", ['IF NOT "%1" == "x"'], False),
    ("if a == b if c==d fx", "fx", ["if a == b", "if c==d"], False),
    ("if a b", "b", ["if a"], False),  # no comparison: one word
    ("if exist a if not exist b fx", "fx", ["if exist a", "if not exist b"], False),
    ("call other", "other", [], True),
    ("CALL other.bat x", "other.bat", [], True),
    ("if exist x.bat call x", "x", ["if exist x.bat"], True),
])
def test_line_running_a_command(line, command, conds, called):
    assert commands(line) == [(1, command, conds, called)]


def test_pipes_run_each_side():
    assert commands("type x | more", "fx | sort") == [(1, "more", [], False), (2, "fx", [], False), (2, "sort", [], False)]


def test_a_forward_if_goto_skips_the_lines_up_to_its_label():
    got = commands("echo off", "if errorlevel 1 goto END", "go", "  :end  here", "after", ":end2")
    assert got == [(3, "go", ["skipped when if errorlevel 1 goto END (line 2)"], False), (5, "after", [], False)]


def test_nested_skips_and_the_line_own_if():
    got = commands("if exist a goto out", "if not exist b goto mid", "if exist c fx", ":mid", "two", ":out", "three")
    assert got == [
        (3, "fx", ["if exist c", "skipped when if exist a goto out (line 1)", "skipped when if not exist b goto mid (line 2)"], False),
        (5, "two", ["skipped when if exist a goto out (line 1)"], False),
        (7, "three", [], False)]


@pytest.mark.parametrize("lines", [
    (":top", "go", "if errorlevel 1 goto top", "after"),  # backward
    ("goto end", "go", ":end"),  # unconditional: not a condition of the lines after it
    ("if errorlevel 1 goto nowhere", "go", ":end"),  # no such label
    ("if errorlevel 1 goto", "go"),  # no label at all
])
def test_gotos_that_skip_nothing(lines):
    assert [c for c in commands(*lines) if c[1] == "go"] == [(2, "go", [], False)]


def script_edges(text: str, files: set[str], entries=None, images=None) -> tuple[dict, list[dict]]:
    sp = links.script_part(Script("T.BAT", text.encode()), files | {"T.BAT"}, entries or {}, images or {})
    return sp["nodes"], sp["edges"]


@pytest.mark.parametrize("files,target", [
    ({"X.COM", "X.EXE", "X.BAT"}, "X_COM:0100"), ({"X.EXE", "X.BAT"}, "X_EXE:0000"), ({"X.BAT"}, "X_BAT:0000"),
])
def test_command_search_order(files, target):
    entries = {"X.COM": "X_COM:0100", "X.EXE": "X_EXE:0000"}
    _nodes, [edge] = script_edges("x", files, {k: v for k, v in entries.items() if k in files})
    assert edge["target"] == target and edge["returns"] == (target != "X_BAT:0000")


@pytest.mark.parametrize("line,target", [("x.bat", "X_BAT:0000"), ("X.Exe", "X_EXE:0000"), ("a:\\suite\\x.com", "X_COM:0100")])
def test_an_explicit_extension_picks_that_file(line, target):
    _nodes, [edge] = script_edges(line, {"X.COM", "X.EXE", "X.BAT"}, {"X.COM": "X_COM:0100", "X.EXE": "X_EXE:0000"})
    assert edge["target"] == target


def test_a_batch_file_runs_another_and_returns_only_with_call():
    _nodes, [goto, called] = script_edges("next\r\ncall next", {"NEXT.BAT"})
    assert (goto["target"], goto["returns"], goto["through"]) == ("NEXT_BAT:0000", False, "batch file line")
    assert (called["target"], called["returns"], called["through"]) == ("NEXT_BAT:0000", True,
                                                                         "batch file line (CALL: returns to the batch file)")
    assert called["instruction"] == "call next" and called["instruction_offset"] == "T_BAT:0002"


@pytest.mark.parametrize("line,images,reason", [
    ("fx", {"SETUP.EXE": b"..Fx.Exe..", "OTHER.EXE": b"fx", "A.EXE": b"FX.BAT"},
     "no FX.COM / FX.EXE / FX.BAT in the game directory: A.EXE, SETUP.EXE names it (made at run time)"),
    ("fx", {"SETUP.EXE": b"FXxEXE"}, "no FX.COM / FX.EXE / FX.BAT in the game directory: a DOS command or a program installed elsewhere"),
    ("mem.exe /c", {}, "no MEM.EXE in the game directory: a DOS command or a program installed elsewhere"),
    ("readme.txt", {"A.EXE": b"readme.txt"}, "no README.TXT in the game directory: A.EXE names it (made at run time)"),
])
def test_unknown_commands_say_who_names_them(line, images, reason):
    nodes, [edge] = script_edges(line, set(), {}, images)
    assert (edge["target"], edge["returns"]) == ("unknown:T_BAT:0001", True)
    assert nodes["unknown:T_BAT:0001"] == {"id": "unknown:T_BAT:0001", "kind": "unknown-target", "space": None,
                                           "address": None, "file_offset": None, "source_file": None, "listing": None,
                                           "entrypoint": False, "reason": reason}


def test_numbered_program_named_by_a_batch_file(tmp_path):
    bat = b"echo off\r\nstart1\r\nif errorlevel 1 goto end\r\ngo\r\n:end\r\n"
    g = game.build(write(tmp_path, {"MAIN.BAT": bat, "START1.EXE": mz(code(0x10, {0: DOS_EXIT}))}))
    edges = link_edges(g.graph)
    assert [(e["instruction_offset"], e["target"], e["conditions"]) for e in edges] == [
        ("MAIN_BAT:0002", "START1_EXE:0000", []),
        ("MAIN_BAT:0004", "unknown:MAIN_BAT:0004",
         [{"direction": "taken", "expression": "skipped when if errorlevel 1 goto end (line 3)", "offset": "MAIN_BAT:0004"}])]
    assert g.graph["nodes"]["unknown:MAIN_BAT:0004"]["reason"].startswith("no GO.COM / GO.EXE / GO.BAT in the game directory")
    c = g.graph["counts"]
    assert (c["runs_edges"], c["loads_edges"], c["interrupt_edges"], c["batch_files"], c["unknown_targets"]) == (2, 0, 0, 1, 1)


def test_edge_counts_include_batch_lines(tmp_path):
    # A.BAT: `b` hands over to B.BAT (no return), `if exist x call b` returns, conditionally
    for d in ("game", "plain"):
        (tmp_path / d).mkdir()
    g = game.build(write(tmp_path / "game", {"PLAY.EXE": PLAY_EXE, "A.BAT": b"b\r\nif exist x call b\r\n", "B.BAT": b"game\r\n"}))
    plain = game.build(write(tmp_path / "plain", {"PLAY.EXE": PLAY_EXE}))
    c, p = g.graph["counts"], plain.graph["counts"]
    assert c["edges"] == p["edges"] + 3 and c["functions"] == p["functions"] and c["batch_files"] == 2
    assert (c["nonreturning_edges"], c["returning_edges"]) == (p["nonreturning_edges"] + 1, p["returning_edges"] + 2)
    assert c["conditional_edges"] == p["conditional_edges"] + 1


def test_a_game_without_batch_files_or_links(tmp_path):
    g = game.build(write(tmp_path, {"PLAY.EXE": PLAY_EXE}))
    c = g.graph["counts"]
    assert (c["runs_edges"], c["loads_edges"], c["interrupt_edges"], c["batch_files"]) == (0, 0, 0, 0)
    assert link_edges(g.graph) == [] and g.scripts == []


# ------------------------------------------------------------------ the batch files of a directory, and the tree


def test_scripts_are_the_bat_files(tmp_path):
    d = write(tmp_path, {"main.bat": b"go", "ALT.BAT": b"x", "README.TXT": b"x", "BAT": b"x", "GO.BATX": b"x"})
    (tmp_path / "DIR.BAT").mkdir()
    assert [(s.name, s.data) for s in game.scripts(d)] == [("ALT.BAT", b"x"), ("MAIN.BAT", b"go")]


def test_scripts_differing_only_in_case_are_an_error(tmp_path):
    d = write(tmp_path, {"MAIN.BAT": b"a", "main.bat": b"b"})
    with pytest.raises(FormatError, match="two files are named MAIN.BAT apart from letter case"):
        game.scripts(d)


def test_write_tree_writes_batch_listings_and_removes_stale_ones(tmp_path):
    (tmp_path / "suite").mkdir()
    d = write(tmp_path / "suite", {"PLAY.EXE": PLAY_EXE, "MAIN.BAT": b"game\r\n", "ALT.BAT": b"game\r\n"})
    out = tmp_path / "out"
    g = game.build(d)
    write_tree(out, g.programs, g.graph, g.diagnostics, tuple(g.scripts))
    listing = out / "units/main_bat/functions/MAIN_BAT_0000.asm"
    assert listing.read_text() == g.scripts[1].render() and (out / "units/alt_bat/functions/ALT_BAT_0000.asm").exists()
    readme = (out / "navigation/README.md").read_text()
    assert f"| MAIN.BAT | batch file (links: `runs` per line) | `{hashlib.sha256(b'game' + bytes([13, 10])).hexdigest()}` |" in readme
    assert json.loads((out / "navigation/callgraph.json").read_text())["programs"]["ALT.BAT"] == ["ALT.BAT"]
    (d / "ALT.BAT").unlink()
    g = game.build(d)
    count, size = write_tree(out, g.programs, g.graph, g.diagnostics, tuple(g.scripts))
    assert not (out / "units/alt_bat/functions/ALT_BAT_0000.asm").exists() and listing.exists()
    assert count == len(g.graph["nodes"]) - g.graph["counts"]["unknown_targets"]
    assert size == sum(len(p.read_bytes()) for p in out.glob("units/*/functions/*.asm"))


def test_files_table_lists_batch_files_after_programs():
    p = Program(PLAY_EXE, None, "PLAY.EXE", None)
    assert files_table([p], {"PLAY.EXE": "g", "A.BAT": "a", "B.BAT": "b"}, ("A.BAT", "B.BAT")) == (
        "| PLAY.EXE | MZ | `g` |\n| A.BAT | batch file (links: `runs` per line) | `a` |\n"
        "| B.BAT | batch file (links: `runs` per line) | `b` |")


def test_files_table_says_where_loaded_code_comes_from():
    p = Program(b"\xcb", None, "FX.PAK-0001", None, layout="COM", in_file=False, loaded_from="record 1 of FX.PAK, which A.EXE reads")
    assert files_table([p], {"FX.PAK-0001": "h"}) == "| FX.PAK-0001 | COM; record 1 of FX.PAK, which A.EXE reads | `h` |"
