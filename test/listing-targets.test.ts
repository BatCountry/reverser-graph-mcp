import { beforeAll, describe, expect, test } from "vitest";
import { CALL_TARGET_HEADER, MAX_LINE_TARGETS, annotateCallTargets, annotateListing, parseCodeLine, stubCallText } from "../src/graph/listing-targets.js";
import { CallGraph, type GraphNode } from "../src/graph/model.js";
import { IDS, LISTING_A, makeFixture } from "./fixture.js";

let graph: CallGraph;
const node = (id: string): GraphNode => graph.nodes.get(id)!;
beforeAll(() => {
  graph = CallGraph.load(makeFixture().disassembly);
});

describe("annotateCallTargets", () => {
  test("a call line gets the target node; other lines are untouched", () => {
    const lines = LISTING_A.split("\n");
    expect(annotateCallTargets(graph, node(IDS.A), LISTING_A)).toBe(
      [`; ${stubCallText(node(IDS.A), ["lcall 0x16, 0x20"])}`, CALL_TARGET_HEADER, ...lines.slice(0, 3), `${lines[3]}\t; → ${IDS.B}`, `${lines[4]}\t; → ${IDS.C}`, lines[5]].join("\n"),
    );
  });
  test("a function reached through a stub table says how, even with no arrows; the stub offset is not passed off as an address", () => {
    const text = "0012  90          nop";
    expect(annotateCallTargets(graph, node(IDS.A), text)).toBe(
      `; Other code reaches it through a stub table as \`lcall 0x16, 0x20\`: the first number names the overlay (module-0001), the second picks a stub-table entry that jumps to 0x10; it is not an address inside the overlay.\n${text}`,
    );
    expect(graph.stubCallsTo(IDS.C)).toEqual([]);
  });
  test("a call site whose line is not a transfer (listing disagrees with the graph) gets no arrow", () => {
    const text = "0032  90          nop"; // C calls D at 0032
    expect(annotateCallTargets(graph, node(IDS.C), text)).toBe(text);
  });
  test("calls to address nodes inside a function are not annotated", () => {
    const text = "0034  e86200      call 0x99";
    expect(annotateCallTargets(graph, node(IDS.C), text)).toBe(text);
  });
  test("a site in another space at the same offset is not this listing's", () => {
    // module-0001:0012 is A's call; the same offset in C's listing names nothing
    const text = "0012  e80b00      call 0x20";
    expect(annotateCallTargets(graph, node(IDS.C), text)).toBe(text);
  });
  test.each([
    ["8-digit address column", "00000012  E80B00  call 0x20"],
    ["segment:offset address column", "2000:0012\tE80B00\tCALL 0x2000:0020"],
    ["no address column", "call 0x20"],
    ["empty listing", ""],
  ])("%s: unchanged, no header", (_label, text) => {
    expect(annotateCallTargets(graph, node(IDS.C), text)).toBe(text);
  });
  test("unresolved indirect targets are named as such; nodes without a space are left alone", () => {
    const g = new CallGraph({
      aliases: {},
      nodes: {
        "m-1:0010": { id: "m-1:0010", kind: "function", space: "m-1", address: 0x10, file_offset: 0, source_file: "X.OVR", listing: null, entrypoint: false },
        "m-1:0030": { id: "m-1:0030", kind: "function", space: "m-1", address: 0x30, file_offset: 0, source_file: "X.OVR", listing: null, entrypoint: false },
        "m-1:0040": { id: "m-1:0040", kind: "function", space: "m-1", address: 0x40, file_offset: 0, source_file: "X.OVR", listing: null, entrypoint: false },
        "unknown:m-1:0020": { id: "unknown:m-1:0020", kind: "unknown-target", space: null, address: null, file_offset: null, source_file: null, listing: null, entrypoint: false },
      },
      edges: [
        { source: "m-1:0010", target: "m-1:0030", instruction: "call 0x30", instruction_offset: "m-1:0012", returns: true, conditions: [] },
        { source: "m-1:0010", target: "m-1:0040", instruction: "call 0x40", instruction_offset: "m-1:0015", returns: true, conditions: [] },
        { source: "m-1:0030", target: "m-1:0010", instruction: "call 0x10", instruction_offset: "m-1:0032", returns: true, conditions: [] },
        { source: "m-1:0010", target: "unknown:m-1:0020", instruction: "call word [bx]", instruction_offset: "m-1:0020", returns: true, conditions: [] },
      ],
    });
    expect(annotateCallTargets(g, g.nodes.get("m-1:0010")!, "0020  ff17  call word [bx]")).toBe(`${CALL_TARGET_HEADER}\n0020  ff17  call word [bx]\t; → unresolved (indirect)`);
    expect(annotateCallTargets(g, g.nodes.get("unknown:m-1:0020")!, "0020  ff17  call word [bx]")).toBe("0020  ff17  call word [bx]");
    expect(annotateCallTargets(g, g.nodes.get("m-1:0010")!, "; m-1:0010\n0012  e81b00  call 0x30\n0015  e82800  call 0x40")).toBe(
      `${CALL_TARGET_HEADER}\n; m-1:0010\n0012  e81b00  call 0x30\t; → m-1:0030\n0015  e82800  call 0x40\t; → m-1:0040`,
    );
    // 4 hex digits followed by a single space or a tab are not a line address
    expect(annotateCallTargets(g, g.nodes.get("m-1:0010")!, "0012 e81b00 call 0x30")).toBe("0012 e81b00 call 0x30");
    expect(annotateCallTargets(g, g.nodes.get("m-1:0010")!, "0012\te81b00\tcall 0x30")).toBe("0012\te81b00\tcall 0x30");
  });
  test.each([
    [MAX_LINE_TARGETS, ""],
    [MAX_LINE_TARGETS + 1, ", … (+1 more: the module tool lists them as callees)"],
    [MAX_LINE_TARGETS + 7, ", … (+7 more: the module tool lists them as callees)"],
  ])("a call through a table with %i stored targets names at most four of them", (count, rest) => {
    const fn = (i: number) => `m-1:${(0x100 + i).toString(16).padStart(4, "0")}`;
    const blank = { space: "m-1", file_offset: 0, source_file: "X.OVR", listing: null, entrypoint: false };
    const nodes: Record<string, GraphNode> = { "m-1:0010": { id: "m-1:0010", kind: "function", address: 0x10, ...blank } };
    for (let i = 0; i < count; i++) nodes[fn(i)] = { id: fn(i), kind: "function", address: 0x100 + i, ...blank };
    const edges = Array.from({ length: count }, (_, i) => ({
      source: "m-1:0010", target: fn(i), instruction: "lcall [di + 0x6786]", instruction_offset: "m-1:0020", returns: true, conditions: [], through: "ds:[index+6786]",
    }));
    const g = new CallGraph({ aliases: {}, nodes, edges });
    const shown = Array.from({ length: Math.min(count, MAX_LINE_TARGETS) }, (_, i) => fn(i)).join(", ");
    expect(annotateCallTargets(g, g.nodes.get("m-1:0010")!, "0020  ff9d8667  lcall [di + 0x6786]")).toBe(
      `${CALL_TARGET_HEADER}\n0020  ff9d8667  lcall [di + 0x6786]\t; → ${shown}${rest}`,
    );
  });
  test("retf dispatch to an unknown target and fall-through into the next function are marked; an ordinary line at a call site is not", () => {
    const fn = (id: string, address: number): GraphNode => ({ id, kind: "function", space: "s", address, file_offset: 0, source_file: "Y.EXE", listing: null, entrypoint: false });
    const unknown: GraphNode = { id: "unknown:s:0016", kind: "unknown-target", space: null, address: null, file_offset: null, source_file: null, listing: null, entrypoint: false };
    const g = new CallGraph({
      aliases: {},
      nodes: Object.fromEntries([fn("s:0010", 0x10), fn("s:0030", 0x30), fn("s:0040", 0x40), fn("s:0050", 0x50), unknown].map((n) => [n.id, n])),
      edges: [
        { source: "s:0010", target: "s:0030", instruction: "call 0x30", instruction_offset: "s:0011", returns: true, conditions: [] },
        { source: "s:0010", target: "s:0040", instruction: "call 0x40", instruction_offset: "s:0013", returns: true, conditions: [] },
        { source: "s:0010", target: "s:0050", instruction: "call 0x50", instruction_offset: "s:0014", returns: true, conditions: [] },
        { source: "s:0010", target: unknown.id, instruction: "retf", instruction_offset: "s:0016", returns: true, conditions: [] },
        { source: "s:0040", target: "s:0050", instruction: "mov ax, 0xff", instruction_offset: "s:004d", returns: false, conditions: [] },
      ],
    });
    expect(annotateCallTargets(g, g.nodes.get("s:0010")!, "0016  cb  retf")).toBe(`${CALL_TARGET_HEADER}\n0016  cb  retf\t; → unresolved (indirect)`);
    expect(annotateCallTargets(g, g.nodes.get("s:0040")!, "004d  b8ff00  mov ax, 0xff")).toBe(`${CALL_TARGET_HEADER}\n004d  b8ff00  mov ax, 0xff\t; ↓ falls through into s:0050`);
    // a returning call edge never matches a non-transfer line, and a fall-through edge never matches a call line
    expect(annotateCallTargets(g, g.nodes.get("s:0010")!, "0011  90  nop")).toBe("0011  90  nop");
    expect(annotateCallTargets(g, g.nodes.get("s:0040")!, "004d  e80000  call 0x50")).toBe("004d  e80000  call 0x50");
  });
});

describe("parseCodeLine", () => {
  test.each([
    ["0012  e81b00  call 0x30", { addr: 0x12, bytes: "e81b00", code: "call 0x30" }],
    ["0012  e81b00      call 0x30   ", { addr: 0x12, bytes: "e81b00", code: "call 0x30" }],
    // a batch-file line: no bytes, its text past the bytes column
    ["0003                if exist snd.exe snd", { addr: 3, bytes: "", code: "if exist snd.exe snd" }],
    ["0A1F  CD21  int 0x21", { addr: 0xa1f, bytes: "CD21", code: "int 0x21" }],
    ["00012345  90  nop", { addr: 0x12345, bytes: "90", code: "nop" }],
    ["ffff  c3  ret", { addr: 0xffff, bytes: "c3", code: "ret" }],
  ])("%j is a line of code", (line, parsed) => {
    expect(parseCodeLine(line)).toEqual(parsed);
  });
  test.each([
    "",
    "; MAIN_EXE:0010",
    "012  90  nop", // 3 address digits
    "000012345  90  nop", // 9
    "0012 90 nop", // one space after the address
    "0012\t90\tnop",
    " 0012  90  nop", // indented
    "0012   ", // an address and nothing else
    "0012  zz  nop", // bytes that are not hex
    "g012  90  nop",
  ])("%j is not", (line) => {
    expect(parseCodeLine(line)).toBeUndefined();
  });
});

describe("annotateListing", () => {
  const fn = (id: string, address: number): GraphNode => ({ id, kind: "function", space: "m-1", address, file_offset: 0, source_file: "X.OVR", listing: null, entrypoint: false });
  const g = new CallGraph({
    aliases: {},
    nodes: {
      ...Object.fromEntries([fn("m-1:0010", 0x10), fn("m-1:0030", 0x30), fn("m-1:0040", 0x40)].map((n) => [n.id, n])),
      "unknown:m-1:0020": { id: "unknown:m-1:0020", kind: "unknown-target", space: null, address: null, file_offset: null, source_file: null, listing: null, entrypoint: false },
    },
    edges: [
      { source: "m-1:0010", target: "m-1:0030", instruction: "call 0x30", instruction_offset: "m-1:0012", returns: true, conditions: [] },
      { source: "m-1:0010", target: "unknown:m-1:0020", instruction: "call word [bx]", instruction_offset: "m-1:0020", returns: true, conditions: [] },
      { source: "m-1:0010", target: "m-1:0040", instruction: "call word [bx]", instruction_offset: "m-1:0020", returns: true, conditions: [], through: "ds:[0200]" },
    ],
  });
  const text = "; m-1:0010 shared with m-1:0040 and m-9:9999\n; no node here\n0012  e81b00  call 0x30\n0014  90  nop\n0020  ff17  call word [bx]\n";
  const a = annotateListing(g, g.nodes.get("m-1:0010")!, text);

  test("comment lines are split at the graph nodes they name; other ids stay text", () => {
    expect(a.lines[0]).toEqual({ text: "; m-1:0010 shared with m-1:0040 and m-9:9999", notes: [], parts: ["; ", { node: "m-1:0010" }, " shared with ", { node: "m-1:0040" }, " and m-9:9999"] });
    expect(a.lines[1]).toEqual({ text: "; no node here", notes: [] });
  });
  test("code lines carry their transfer family and notes; unknown targets are null, named by the note", () => {
    expect(a.lines[2]).toMatchObject({ code: { addr: 0x12, bytes: "e81b00", code: "call 0x30" }, transfer: "call", notes: [{ label: "→", targets: ["m-1:0030"], unknown: "unresolved (indirect)", more: 0 }] });
    expect(a.lines[3]).toEqual({ text: "0014  90  nop", code: { addr: 0x14, bytes: "90", code: "nop" }, notes: [] });
    expect(a.lines[4]!.notes).toEqual([{ label: "→", targets: [null, "m-1:0040"], unknown: "unresolved (indirect)", more: 0 }]);
    expect(a.header).toEqual([CALL_TARGET_HEADER]);
  });
  test("the text form is the same listing with the notes after tabs, the final newline kept", () => {
    expect(annotateCallTargets(g, g.nodes.get("m-1:0010")!, text)).toBe(
      `${CALL_TARGET_HEADER}\n; m-1:0010 shared with m-1:0040 and m-9:9999\n; no node here\n0012  e81b00  call 0x30\t; → m-1:0030\n0014  90  nop\n0020  ff17  call word [bx]\t; → unresolved (indirect), m-1:0040\n`,
    );
  });
});
