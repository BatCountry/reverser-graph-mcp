import struct

import pytest
from conftest import Section, mz, rtlink

from dosgraph.binary import Program, parse_mz
from dosgraph.errors import FormatError
from dosgraph.flow import analyze
from dosgraph.x86 import Decoder

RETF = b"\xcb"
# section 0 at 100h; 1 and 2 share 120h (siblings, children of 0); 3 is the data segment
SECTIONS = [
    Section(0x100, RETF * 0x40, paragraphs=0x20),
    # its fixup at 30h holds 0100h: section 0's segment (a far reference to its parent), not one of its own
    Section(0x120, b"\x55" + RETF * 0x2F + b"\x00\x01" + RETF * 0x10, parent=0, fixups=[(0x120, 0x30)]),
    Section(0x120, RETF * 0x20, parent=0),
    Section(0x200, b"\x00" * 0x20, data=True),
]
STUBS = [(0, 0x100, 0x5), (1, 0x121, 0x0), (2, 0x120, 0x10)]


def program(**kw) -> Program:
    return Program(rtlink(RETF * 0x10, kw.pop("sections", SECTIONS), kw.pop("stubs", STUBS), **kw), None, "TOOL.EXE")


def test_sections_stubs_and_spaces():
    p = program()
    assert [s.name for s in p.section_list] == ["TOOL_EXE-0000", "TOOL_EXE-0001", "TOOL_EXE-0002", "TOOL_EXE-0003"]
    assert set(p.sections) == {"TOOL_EXE-0000", "TOOL_EXE-0001", "TOOL_EXE-0002"}  # the data section is no code space
    assert set(p.spaces) == {"TOOL_EXE", "TOOL_EXE-0000", "TOOL_EXE-0001", "TOOL_EXE-0002"}
    assert p.section_list[1].parent == 0 and p.section_list[0].parent is None and p.section_list[3].data
    assert p.spaces["TOOL_EXE-0001"].relocated_words == {0x30}
    # stub (section, seg, off): offsets count from the section's load segment
    assert p.overlay_entry_ids() == ["TOOL_EXE-0000:0005", "TOOL_EXE-0001:0010", "TOOL_EXE-0002:0010"]
    assert p.aliases() == {"TOOL_EXE:0200": "TOOL_EXE-0000:0005", "TOOL_EXE:020a": "TOOL_EXE-0001:0010", "TOOL_EXE:0214": "TOOL_EXE-0002:0010"}
    assert p.resolve_root_linear(0x20A)[0] == "TOOL_EXE-0001:0010"
    assert p.stub_table_of(0x205) == "TOOL_EXE RTLink stub table" and p.stub_table_of(0x21E) is None
    assert p.spaces["TOOL_EXE-0000"].file_base == p.section_list[0].file_offset


def test_the_tree_readme_names_the_sections():
    from dosgraph.emit import files_table

    assert files_table([program()], {"TOOL.EXE": "h"}) == "| TOOL.EXE | MZ; RTLink/Plus overlays appended (3 code sections, 1 data) | `h` |"


def test_far_calls_resolve_through_the_calling_section_and_its_ancestors():
    p = program()
    assert p.resolve_far(0x121, 0x2, "TOOL_EXE-0001") == ("TOOL_EXE-0001:0012", "in TOOL_EXE-0001")  # its own section
    assert p.resolve_far(0x100, 0x7, "TOOL_EXE-0001")[0] == "TOOL_EXE-0000:0007"  # its parent, loaded with it
    assert p.resolve_far(0x0, 0x3, "TOOL_EXE-0001")[0] == "TOOL_EXE:0003"  # the resident image
    assert p.resolve_far(0x100, 0x7)[0] == "TOOL_EXE-0000:0007"  # no caller: the only section holding it
    assert p.resolve_far(0x120, 0x1) == (None, "far target 0x1201 is in the load area of 2 overlay sections")
    assert p.resolve_far(0x120, 0x1, "TOOL_EXE-0000")[1] == "far target 0x1201 is in the load area of 2 overlay sections"
    assert p.resolve_far(0x100, 0x1F0, "TOOL_EXE-0000") == (None, "far target 0x11f0 is past the code of TOOL_EXE-0000")
    assert p.resolve_far(0x300, 0x0)[1] == "far target 0x3000 outside load image"


def test_code_base_follows_the_section_segments_its_fixups_name():
    assert program().code_base("TOOL_EXE-0001", 0x35) == 0  # the relocated word names another section's segment
    sec = [Section(0x100, b"\x02\x01" + RETF * 0x2E, fixups=[(0x100, 0x0)])]  # the word at 0 holds 0102h: 2 paragraphs in
    q = program(sections=sec, stubs=[(0, 0x100, 0x2)])
    assert [q.code_base("TOOL_EXE-0000", a) for a in (0x1F, 0x20, 0x2F)] == [0, 0x20, 0x20]
    assert q.code_base("NOPE", 5) == 0


def test_analysis_reaches_section_code_through_stubs():
    root = b"\x9a" + struct.pack("<HH", 0x200, 0x0) + b"\xb4\x4c\xcd\x21"  # lcall 0000:0200 (a stub); exit
    sec = [Section(0x100, b"\x90" * 5 + b"\x55\xcb" + RETF * 9)]
    p = Program(rtlink(root, sec, [(0, 0x100, 0x5)], header_relocs=[3]), None, "TOOL.EXE")
    an = analyze(p, Decoder(p), stop_on_fallthrough=True)
    assert "TOOL_EXE-0000:0005" in an.descents and "overlay-entry" in an.root_kinds["TOOL_EXE-0000:0005"]


def test_a_last_section_cut_short_within_its_final_paragraph():
    assert len(program(truncate=15).section_list[-1].code) == 0x20 - 15
    with pytest.raises(FormatError, match="0 RTLink/Plus section tables"):
        program(truncate=16)


def real_rows() -> list[list[int]]:
    m = parse_mz(rtlink(RETF * 0x10, SECTIONS, STUBS))
    return [list(struct.unpack_from("<9H", m.image, 0x100 + 18 * k)) for k in range(len(SECTIONS))]


@pytest.mark.parametrize("word,row,value", [
    (2, 1, +1),  # a gap between sections
    (3, 0, 0x0200),  # neither code nor data
    (8, 0, 0x21),  # more paragraphs in the file than in memory
    (6, 1, 1),  # its own parent
    (6, 0, 3),  # a parent that comes later
    (0, 1, 0x50),  # its fixup now lands past its code
])
def test_tables_that_do_not_tile_are_not_tables(word, row, value):
    rows = real_rows()
    rows[row][word] = rows[row][word] + value if word == 2 else value
    with pytest.raises(FormatError, match="0 RTLink/Plus section tables tile the appended data"):
        program(entries=rows)


def test_an_empty_table_and_nothing_appended():
    with pytest.raises(FormatError, match="0 RTLink/Plus section tables"):
        program(entries=[])  # a count of 0 describes nothing
    with pytest.raises(FormatError, match="without overlay sections appended"):
        Program(mz(RETF * 16 + b".RTLink"), None, "TOOL.EXE")


@pytest.mark.parametrize("stubs", [
    [],
    [(9, 0x100, 0)],  # no such section
    [(3, 0x200, 0)],  # the data section
    [(0, 0x120, 0)],  # outside the section's load area
    [(0, 0x100, 0x1F0)],  # inside the area, past its code
])
def test_stubs_must_name_code_in_their_section(stubs):
    with pytest.raises(FormatError, match="expected one run of RTLink/Plus stubs, found 0"):
        program(stubs=stubs)


def test_two_runs_of_stubs_are_ambiguous_and_a_stray_one_is_not():
    two = [(0, 0x100, 5), (0, 0x100, 6), (9, 0, 0), (0, 0x100, 7), (0, 0x100, 8)]  # (9, ...) breaks the run
    with pytest.raises(FormatError, match=r"lengths \[2, 2\]"):
        program(stubs=two)
    stray = program(stubs=[(0, 0x100, 5), (0, 0x100, 6), (9, 0, 0), (0, 0x100, 7)])
    assert sorted(stray.rt_stubs) == [0x200, 0x20A]
