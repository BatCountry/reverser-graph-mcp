import { describe, expect, test } from "vitest";
import { MIN_FRAME_VOTES, declaredFrames, parseAddress } from "../src/graph/addresses.js";
import { CallGraph, type GraphEdge, type GraphNode } from "../src/graph/model.js";

describe("parseAddress", () => {
  test.each([
    ["lcall 0x5bb, 0x634", { form: "seg", segment: 0x5bb, offset: 0x634, transfer: true }],
    ["lcall 0x41, 0x25", { form: "seg", segment: 0x41, offset: 0x25, transfer: true }],
    ["call word 0x5bb:word 0x634", { form: "seg", segment: 0x5bb, offset: 0x634, transfer: true }],
    ["jmpf far ptr 0x10:0x20", { form: "seg", segment: 0x10, offset: 0x20, transfer: true }],
    ["ljmp 0x10, 0x20", { form: "seg", segment: 0x10, offset: 0x20, transfer: true }],
    ["js 0x1000:0ecd", { form: "seg", segment: 0x1000, offset: 0xecd, transfer: true }],
    ["loopnz 0x10", { form: "flat", offset: 0x10, transfer: true }],
    ["5bb:0634", { form: "seg", segment: 0x5bb, offset: 0x634, transfer: false }],
    ["b800:0010", { form: "seg", segment: 0xb800, offset: 0x10, transfer: false }],
    ["5bbh:0634h", { form: "seg", segment: 0x5bb, offset: 0x634, transfer: false }],
    ["module-0200:186c", { form: "name", space: "module-0200", offset: 0x186c, transfer: false }],
    ["MAIN-root:0x61E4", { form: "name", space: "main-root", offset: 0x61e4, transfer: false }],
    ["call module-0200:186ch", { form: "name", space: "module-0200", offset: 0x186c, transfer: true }],
    ["call 0x186c", { form: "flat", offset: 0x186c, transfer: true }],
    ["186ch", { form: "flat", offset: 0x186c, transfer: false }],
    ["0x0", { form: "flat", offset: 0, transfer: false }],
    ["186c", { form: "flat", offset: 0x186c, transfer: false }],
    ["call 0x0000186c", { form: "flat", offset: 0x186c, transfer: true }],
    ["0xffffffff", { form: "flat", offset: 0xffffffff, transfer: false }],
  ])("%s", (text, expected) => {
    expect(parseAddress(text)).toEqual(expected);
  });
  test.each([
    ["", false],
    ["   ", false],
    ["call ", false],
    ["21", true],
    ["123", true],
    ["12345", true],
    ["123456789", true],
    // only the 4-digit width listing lines print is an unmarked address; Ghidra labels are not addresses
    ["0000186C", true],
    ["FUN_15bb_0634", false],
    ["thunk_FUN_15bb_0634__15bb_0634", false],
    ["0x123456789", false],
    ["10000:0001", false],
    ["1:2:3", false],
    ["-0x10", false],
    ["NaN", false],
    ["Infinity", false],
    ["work:module-0200:32df", false],
  ])("rejects %j (bare hex: %s)", (text, bareHex) => {
    expect(parseAddress(text)).toMatchObject({ form: "invalid", bareHex });
  });
});

// Two files, two overlay modules sharing one address range, a resident image with an overlay stub.
const fn = (id: string, file: string, kind = "function"): GraphNode => {
  const [space, off] = id.split(":");
  return { id, kind, space: space!, address: parseInt(off!, 16), file_offset: 0, source_file: file, listing: null, entrypoint: false };
};
const call = (source: string, target: string, instruction: string, site: string): GraphEdge => ({ source, target, instruction, instruction_offset: site, returns: true, conditions: [] });

function makeGraph(extraEdges: GraphEdge[] = []) {
  const nodes = [
    fn("EXE-root:0100", "A.EXE"),
    fn("EXE-root:0200", "A.EXE"),
    fn("EXE-root:0300", "A.EXE"),
    fn("EXE-root:0400", "A.EXE"),
    fn("EXE-root:0480", "A.EXE", "address"),
    fn("EXE-root:0500", "A.EXE"),
    fn("ovl-1:0010", "B.OVR"),
    fn("ovl-1:0040", "B.OVR"),
    fn("ovl-2:0010", "B.OVR"),
    fn("ovl-2:0030", "B.OVR"),
  ];
  const edges = [
    // resident: seg:off relative to load segment 1000 (base 0x10000), three distinct targets
    call("EXE-root:0100", "EXE-root:0200", "callf 0x1000:0200", "EXE-root:0105"),
    call("EXE-root:0100", "EXE-root:0300", "callf 0x1000:0300", "EXE-root:010a"),
    call("EXE-root:0100", "EXE-root:0400", "callf 0x1000:0400", "EXE-root:010f"),
    // overlay: module-relative flat offsets (base 0), three distinct targets
    call("ovl-1:0010", "ovl-1:0040", "call 0x40", "ovl-1:0012"),
    call("ovl-2:0010", "ovl-2:0030", "call 0x30", "ovl-2:0040"),
    call("ovl-2:0030", "ovl-2:0010", "call 0x10", "ovl-2:0032"),
    // resident calls an overlay entry through its stub at EXE-root:0050: a single stub vote for base 0 (below threshold)
    call("EXE-root:0200", "ovl-1:0010", "call word 0x5:word 0x0", "EXE-root:0210"),
    // an unaligned stray operand: never a frame
    call("EXE-root:0300", "EXE-root:0400", "callf 0x1000:0401", "EXE-root:0310"),
    ...extraEdges,
  ];
  return new CallGraph({ nodes: Object.fromEntries(nodes.map((n) => [n.id, n])), edges, aliases: { "EXE-root:0050": "ovl-1:0010", "0005:0000": "ovl-1:0010" } });
}

describe("frame learning", () => {
  test(`a frame needs ${MIN_FRAME_VOTES} distinct agreeing targets, a paragraph-aligned base and a non-negative one`, () => {
    const g = makeGraph();
    expect(g.addresses.frames.map(({ form, file, base }) => ({ form, file, base }))).toEqual(
      expect.arrayContaining([
        { form: "seg", file: "A.EXE", base: 0x10000 },
        { form: "flat", file: "B.OVR", base: 0 },
      ]),
    );
    expect(g.addresses.frames).toHaveLength(2);
  });
  test("votes repeated against one target count once", () => {
    const g = makeGraph([0, 1, 2, 3].map((i) => call("EXE-root:0100", "EXE-root:0200", "jmp 0x9200", `EXE-root:01${i}0`)));
    expect(g.addresses.frames.some((f) => f.form === "flat" && f.file === "A.EXE")).toBe(false);
  });
  test("stub votes count toward the resident image's frame", () => {
    const g = makeGraph([
      call("EXE-root:0300", "ovl-1:0010", "callf 0x1000:0050", "EXE-root:0320"),
    ]);
    expect(g.addresses.frames.find((f) => f.form === "seg" && f.file === "A.EXE" && f.base === 0x10000)?.votes).toBe(4);
  });
});

describe("resolving through learned frames", () => {
  const g = makeGraph();
  test("resident seg:off address, capstone far call and stub", () => {
    expect(g.resolve("1000:0300")).toMatchObject({ ok: true, node: { id: "EXE-root:0300" } });
    expect(g.resolve("lcall 0x1020, 0x100")).toMatchObject({ ok: true, node: { id: "EXE-root:0300" } });
    expect(g.resolve("CALLF 0x1000:0050")).toMatchObject({ ok: true, node: { id: "ovl-1:0010" }, note: expect.stringContaining("overlay stub at EXE-root:0050") });
    expect(g.resolve("EXE-root:0050")).toMatchObject({ ok: true, node: { id: "ovl-1:0010" } });
  });
  test("an address node resolves to itself, never as a container", () => {
    expect(g.resolve("1000:0480")).toMatchObject({ ok: true, node: { id: "EXE-root:0480" } });
    const r = g.resolve("1000:0490");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("EXE-root:0400 (+0x90)");
  });
  test("overlay modules share a range: equal starts are ambiguous", () => {
    const r = g.resolve("0x10");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("could mean 2 different functions: ovl-1:0010; ovl-2:0010");
      expect(r.error).toContain("overlay whose listing you are reading");
    }
  });
  test("a bare address that is one module's start and another's call site is ambiguous", () => {
    const r = g.resolve("0040");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("ovl-1:0040; ovl-2:0010 (the call or branch at ovl-2:0040 is inside it)");
  });
  test("a call/jmp operand names a start, so the start wins over a call site", () => {
    expect(g.resolve("call 0x40")).toMatchObject({ ok: true, node: { id: "ovl-1:0040" } });
  });
  test("only a call site there: resolves to its function even as a call operand", () => {
    expect(g.resolve("call 0x32")).toMatchObject({ ok: true, node: { id: "ovl-2:0030" }, note: expect.stringContaining("is inside it") });
  });
  test("mid-function address: nearest function start per module, nearest first", () => {
    const r = g.resolve("0x3f");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/ovl-2:0030 \(\+0xf\), ovl-1:0010 \(\+0x2f\)/);
  });
  test("readings past the end of a file are not offered", () => {
    const r = g.resolve("1000:9000");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("does not match how any listing");
  });
});

describe("declared frames", () => {
  test.each([
    ["not an array", { form: "seg", file: "A.EXE", base: 0 }],
    ["null", null],
    ["a string", "seg"],
  ])("%s: none", (_label, raw) => {
    expect(declaredFrames(raw)).toEqual([]);
  });
  test.each([
    ["null entry", null],
    ["string entry", "seg|A.EXE|0"],
    ["unknown form", { form: "linear", file: "A.EXE", base: 0 }],
    ["missing file", { form: "seg", base: 0 }],
    ["empty file", { form: "seg", file: "", base: 0 }],
    ["base as string", { form: "seg", file: "A.EXE", base: "0x10000" }],
    ["negative base", { form: "seg", file: "A.EXE", base: -16 }],
    ["unaligned base", { form: "seg", file: "A.EXE", base: 0x10001 }],
    ["fractional base", { form: "seg", file: "A.EXE", base: 16.5 }],
    ["NaN base", { form: "seg", file: "A.EXE", base: Number.NaN }],
    ["infinite base", { form: "seg", file: "A.EXE", base: Number.POSITIVE_INFINITY }],
    ["unsafe base", { form: "seg", file: "A.EXE", base: 2 ** 60 }],
  ])("drops %s", (_label, entry) => {
    expect(declaredFrames([entry])).toEqual([]);
  });
  test("keeps valid entries, base 0 and a 16-aligned base; an empty label is omitted", () => {
    expect(declaredFrames([{ form: "flat", file: "B.OVR", base: 0, label: "" }, { form: "seg", file: "B.OVR", base: 0x20000, label: "loaded at 2000:0000" }])).toEqual([
      { form: "flat", file: "B.OVR", base: 0, votes: 0 },
      { form: "seg", file: "B.OVR", base: 0x20000, votes: 0, label: "loaded at 2000:0000" },
    ]);
  });
  test("a declared frame makes its addresses resolvable; one matching a learned frame only labels it", () => {
    const base = makeGraph();
    expect(base.resolve("2000:0030").ok).toBe(false);
    const g = new CallGraph({
      nodes: Object.fromEntries(base.nodes),
      edges: [...base.edges],
      aliases: { "EXE-root:0050": "ovl-1:0010" },
      frames: [
        { form: "seg", file: "B.OVR", base: 0x20000, label: "overlays loaded at 2000:0000" },
        { form: "seg", file: "A.EXE", base: 0x10000, label: "image loaded at 1000:0000" },
        { form: "seg", file: "A.EXE", base: 3 },
      ],
    });
    expect(g.resolve("2000:0030")).toMatchObject({ ok: true, node: { id: "ovl-2:0030" } });
    expect(g.addresses.frames.find((f) => f.file === "A.EXE" && f.base === 0x10000)).toEqual({ form: "seg", file: "A.EXE", base: 0x10000, votes: 3, label: "image loaded at 1000:0000" });
    expect(g.addresses.frames.some((f) => f.base === 3)).toBe(false);
  });
});
