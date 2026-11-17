import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { TtlCache } from "../src/cache.js";
import { listingFor } from "../src/graph/files.js";
import { CallGraph, programTable } from "../src/graph/model.js";
import { entrypointTraces, findPaths } from "../src/graph/paths.js";
import { lookupModule, lookupTrace, type Context } from "../src/graph/tools.js";
import { ProgressStore } from "../src/progress/store.js";
import { IDS, makeFixture, type Fixture } from "./fixture.js";

let fx: Fixture;
let graph: CallGraph;
let ctx: Context;
beforeAll(() => {
  fx = makeFixture();
  graph = CallGraph.load(fx.disassembly);
  ctx = { graph, disassemblyRoot: fx.disassembly, progress: new ProgressStore(fx.progressFile), cache: new TtlCache() };
});

describe("programs", () => {
  const fn = (id: string, file: string | null) => ({ id, kind: "function", space: id.split(":")[0], address: 0, file_offset: 0, source_file: file, listing: null, entrypoint: false });
  const graph = (programs?: unknown) =>
    new CallGraph({ nodes: { "MAIN_EXE:0000": fn("MAIN_EXE:0000", "MAIN.EXE"), "MAIN_OVR-0020:0000": fn("MAIN_OVR-0020:0000", "MAIN.OVR"), "TOOL_EXE:0000": fn("TOOL_EXE:0000", "TOOL.EXE"), "X:0000": fn("X:0000", null) } as never, edges: [], aliases: {}, programs });
  test.each([
    [undefined, {}], [null, {}], ["MAIN.EXE", {}], [["MAIN.EXE"], {}], [42, {}],
    [{ "MAIN.EXE": "MAIN.EXE" }, {}],
    [{ "MAIN.EXE": ["MAIN.EXE", 7, null, "MAIN.OVR"] }, { "MAIN.EXE": "MAIN.EXE", "MAIN.OVR": "MAIN.EXE" }],
    [{ "A.EXE": ["SHARED.OVR"], "B.EXE": ["SHARED.OVR", "B.EXE"] }, { "SHARED.OVR": "A.EXE", "B.EXE": "B.EXE" }],
  ])("programTable(%j) keeps only well-formed entries, first claim wins", (raw, expected) => {
    expect(Object.fromEntries(programTable(raw))).toEqual(expected);
  });
  test("overlay code belongs to the program it overlays; unknown targets to their space's program", () => {
    const g = graph({ "MAIN.EXE": ["MAIN.EXE", "MAIN.OVR"], "TOOL.EXE": ["TOOL.EXE"] });
    expect(["MAIN_EXE:0000", "MAIN_OVR-0020:0000", "TOOL_EXE:0000", "unknown:MAIN_OVR-0020:0010", "unknown:NOPE:0010", "X:0000", "missing:0000"].map((id) => g.programOf(id)))
      .toEqual(["MAIN.EXE", "MAIN.EXE", "TOOL.EXE", "MAIN.EXE", undefined, undefined, undefined]);
  });
  test("a file no program claims is in none; a tree without the table is one program", () => {
    expect(graph({ "MAIN.EXE": ["MAIN.EXE"] }).programOf("TOOL_EXE:0000")).toBeUndefined();
    expect(graph().programOf("TOOL_EXE:0000")).toBe("");
    expect(graph().programOf("X:0000")).toBeUndefined();
  });
});

describe("resolve", () => {
  test("canonical, mixed-case, padded and marked-offset names", () => {
    expect(graph.resolve(IDS.A)).toEqual({ ok: true, node: graph.nodes.get(IDS.A) });
    expect(graph.resolve("  MODULE-0001:0010 ")).toMatchObject({ ok: true, node: { id: IDS.A } });
    expect(graph.resolve("main-root:0006")).toMatchObject({ ok: true, node: { id: IDS.R } });
    expect(graph.resolve("module-0001:0x10")).toEqual({ ok: true, node: graph.nodes.get(IDS.A), note: undefined });
    expect(graph.resolve("module-0001:10h")).toMatchObject({ ok: true, node: { id: IDS.A } });
  });
  test.each(["0016:0020", "16:20", "0x16:0x20", "callf 0x16:0x20", "lcall 0x16, 0x20", "call word 0x16:word 0x20"])("far-call alias %s", (input) => {
    expect(graph.resolve(input)).toMatchObject({ ok: true, node: { id: IDS.A }, note: expect.stringContaining("far-call alias") });
  });
  test("overlay addresses map through the segment frame learned from the edges", () => {
    expect(graph.resolve("2000:0030")).toMatchObject({ ok: true, node: { id: IDS.C }, note: expect.stringContaining("read as module-0002:0030") });
    expect(graph.resolve("lcall 0x2000, 0x30")).toMatchObject({ ok: true, node: { id: IDS.C } });
    expect(graph.resolve("CALL 0x2000:0030")).toMatchObject({ ok: true, node: { id: IDS.C } });
  });
  test("a call or branch site resolves to the function containing it", () => {
    expect(graph.resolve("2000:0012")).toMatchObject({ ok: true, node: { id: IDS.A }, note: expect.stringContaining("is inside it") });
    expect(graph.resolve("module-0001:0011")).toMatchObject({ ok: true, node: { id: IDS.A } });
    expect(graph.resolve("MAIN-root:0010")).toMatchObject({ ok: true, node: { id: IDS.R } });
  });
  test.each([
    [undefined, "Pass a module"],
    ["", "Pass a module"],
    ["  ", "Pass a module"],
    ["nonsense", "Known spaces"],
    ["work:module-0001:0010", "not a node name or an address"],
    ["module-9999:0001", "Known spaces"],
    ["module-0001:0099", "Nearest functions in module-0001"],
    ["module-0001:zz", "Nearest functions in module-0001"],
    ["21", "no 0x or h marker"],
    ["12345", "no 0x or h marker"],
    ["zz:0001", "Known spaces"],
    ["10000:0001", "not a node name or an address"],
    // below the overlay frame's base, and past the highest known overlay address: no reading at all
    ["0001:0001", "does not match how any listing"],
    ["2fff:0000", "does not match how any listing"],
    // no flat frame was learned from the fixture's edges
    ["0x30", "does not match how any listing"],
    ["2000:0055", "nearest function starts below it are: module-0002:0040 (+0x15)"],
  ])("rejects %j", (input, fragment) => {
    const r = graph.resolve(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(fragment);
  });
});

describe("entrypoint traces", () => {
  test("every root that reaches the target, nearest first, shortest chain each", () => {
    const { traces } = entrypointTraces(graph, IDS.C);
    expect(traces.map((t) => t.nodes)).toEqual([[IDS.R2, IDS.C], [IDS.R, IDS.A, IDS.C]]);
  });
  test("a deeper target is reached from both roots; chains follow real edges", () => {
    const { traces } = entrypointTraces(graph, IDS.D);
    expect(traces.map((t) => t.nodes.length)).toEqual([3, 4]);
    for (const t of traces) for (const h of t.hops) expect(h.edges.length).toBeGreaterThan(0);
  });
  test("a root is its own entrypoint; a cycle nobody enters has none; isolated has none", () => {
    expect(entrypointTraces(graph, IDS.R)).toMatchObject({ traces: [], targetIsRoot: true });
    expect(entrypointTraces(graph, IDS.X)).toMatchObject({ traces: [], targetIsRoot: false });
    expect(entrypointTraces(graph, IDS.Z)).toMatchObject({ traces: [], targetIsRoot: false });
  });
  test("roots are nodes nothing calls that call something", () => {
    expect([IDS.R, IDS.R2].every((id) => graph.isRoot(id))).toBe(true);
    expect([IDS.Z, IDS.D, IDS.A, IDS.X].some((id) => graph.isRoot(id))).toBe(false);
  });
});

describe("findPaths", () => {
  const opts = { limit: 10, slack: 2, maxExpansions: 10_000 };
  test("shortest first, then longer alternatives within the slack", () => {
    const r = findPaths(graph, IDS.R, IDS.C, opts);
    expect(r.shortest).toBe(2);
    expect(r.paths.map((p) => p.nodes)).toEqual([[IDS.R, IDS.A, IDS.C], [IDS.R, IDS.A, IDS.B, IDS.C]]);
  });
  test("slack 0 keeps only shortest; limit caps the count", () => {
    expect(findPaths(graph, IDS.R, IDS.C, { ...opts, slack: 0 }).paths).toHaveLength(1);
    expect(findPaths(graph, IDS.R, IDS.D, { ...opts, limit: 1 }).paths).toHaveLength(1);
  });
  test("unreachable, with reverse reachability reported", () => {
    expect(findPaths(graph, IDS.D, IDS.R, opts)).toMatchObject({ shortest: undefined, paths: [], reverseReachable: true });
    expect(findPaths(graph, IDS.Z, IDS.R, opts)).toMatchObject({ shortest: undefined, reverseReachable: false });
  });
  test("cycles do not repeat nodes", () => {
    const r = findPaths(graph, IDS.X, IDS.D, opts);
    expect(r.paths.map((p) => p.nodes)).toEqual([[IDS.X, IDS.Y, IDS.D]]);
  });
  test("work budget truncates instead of hanging", () => {
    expect(findPaths(graph, IDS.R, IDS.D, { limit: 10, slack: 2, maxExpansions: 1 }).truncated).toBe(true);
  });
});

describe("listings", () => {
  test("the file the graph names, resolved from its units/ suffix under a renamed root", () => {
    // fixture listings say "alpha/units/..." while the root directory is reversing/disassembly
    const a = listingFor(fx.disassembly, graph.nodes.get(IDS.A)!);
    expect(a).toEqual({ absPath: path.join(fx.disassembly, "units/play/functions/module-0001_0010.asm"), bytes: expect.any(Number) });
    expect(a!.bytes).toBeGreaterThan(0);
  });
  test("no listing: function with no file on disk, address node, path without units/, path that is a directory", () => {
    expect(listingFor(fx.disassembly, graph.nodes.get(IDS.D)!)).toBeUndefined();
    expect(listingFor(fx.disassembly, graph.nodes.get(IDS.ADDR)!)).toBeUndefined();
    expect(listingFor(fx.disassembly, { ...graph.nodes.get(IDS.A)!, listing: "elsewhere/module-0001_0010.asm" })).toBeUndefined();
    mkdirSync(path.join(fx.disassembly, "units/play/functions/dir.asm"), { recursive: true });
    expect(listingFor(fx.disassembly, { ...graph.nodes.get(IDS.A)!, listing: "units/play/functions/dir.asm" })).toBeUndefined();
    writeFileSync(path.join(fx.disassembly, "units/play/functions/backslash.asm"), "x\n");
    expect(listingFor(fx.disassembly, { ...graph.nodes.get(IDS.A)!, listing: "C:\\gen\\units\\play\\functions\\backslash.asm" })).toMatchObject({ bytes: 2 });
  });
});

describe("lookupModule", () => {
  test("callers, callees, listings and traces for a mid-graph node", () => {
    const r = lookupModule(ctx, { module: IDS.C });
    if (!r.ok) throw new Error(r.error);
    expect(r.output.callers).toContain("3 callers");
    expect(r.output.callees).toContain("2 callees");
    expect(r.output.callers).toContain("disasm://disassembly/module/");
    expect(r.output.entrypoint_traces).toContain("2 entrypoints");
    expect(r.output.entrypoint_traces).toContain(`${IDS.R} → ${IDS.A} → ${IDS.C}`);
    expect(r.output.listing).toContain(`disasm://disassembly/listing/${encodeURIComponent(IDS.C)}`);
    const d = lookupModule(ctx, { module: IDS.D });
    if (!d.ok) throw new Error(d.error);
    expect(d.output.listing).toBe("No listing for this node.");
    expect(d.output.tool_hint).toContain("No listing file was found for this function");
    expect(r.output.callees).toContain(`${IDS.ADDR} (address)`);
  });
  test("full trace detail is cached behind a handle", () => {
    const r = lookupModule(ctx, { module: IDS.D });
    if (!r.ok) throw new Error(r.error);
    const handle = /disasm:\/\/disassembly\/trace\/([\w-]+)/.exec(r.output.entrypoint_traces)![1]!;
    expect(ctx.cache.get(handle)?.text).toContain("Entrypoint traces to");
  });
  test("root, isolated and cycle-only nodes get honest explanations", () => {
    const root = lookupModule(ctx, { module: IDS.R });
    const iso = lookupModule(ctx, { module: IDS.Z });
    const cyc = lookupModule(ctx, { module: IDS.X });
    if (!root.ok || !iso.ok || !cyc.ok) throw new Error("lookup failed");
    expect(root.output.entrypoint_traces).toContain("itself an entrypoint");
    expect(iso.output.entrypoint_traces).toContain("Unreachable");
    expect(cyc.output.entrypoint_traces).toContain("loops back");
  });
  test("addresses, work unit ids and unknown input", () => {
    expect(lookupModule(ctx, { module: "0016:0020" })).toMatchObject({ ok: true, output: { module: IDS.A, summary: expect.stringContaining("far-call alias") } });
    expect(lookupModule(ctx, { module: "work:module-0001:0010" })).toMatchObject({ ok: true, output: { module: IDS.A, summary: expect.stringContaining("is a work unit; this is its root function") } });
    expect(lookupModule(ctx, { module: IDS.A })).toMatchObject({ ok: true, output: { summary: expect.not.stringContaining("read as") } });
    expect(lookupModule(ctx, { module: "nope" }).ok).toBe(false);
  });
  test("more than eight neighbours are summarised with a link to the full list", () => {
    const big = new CallGraph({
      aliases: {},
      nodes: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`module-0009:${(i + 1).toString(16).padStart(4, "0")}`, { ...graph.nodes.get(IDS.A)!, id: `module-0009:${(i + 1).toString(16).padStart(4, "0")}` }])),
      edges: Array.from({ length: 11 }, (_, i) => ({ source: "module-0009:0001", target: `module-0009:${(i + 2).toString(16).padStart(4, "0")}`, instruction: "call", instruction_offset: "x", returns: true, conditions: [] })),
    });
    const r = lookupModule({ ...ctx, graph: big }, { module: "module-0009:0001" });
    if (!r.ok) throw new Error(r.error);
    expect(r.output.callees).toContain("11 callees");
    expect(r.output.callees).toContain("… 3 more: disasm://disassembly/neighbors/");
  });
});

describe("lookupTrace", () => {
  test("shortest path with call sites and conditions, alternatives, handle", () => {
    const r = lookupTrace(ctx, { from: IDS.R, to: IDS.C });
    if (!r.ok) throw new Error(r.error);
    expect(r.output.result).toContain("2 hops");
    expect(r.output.shortest_path).toContain(`${IDS.R} → ${IDS.A} → ${IDS.C}`);
    expect(r.output.other_paths).toContain(`${IDS.B}`);
    const handle = /disasm:\/\/disassembly\/trace\/([\w-]+)/.exec(r.output.complete_trace)![1]!;
    expect(ctx.cache.get(handle)?.text).toContain("when module-0001:0011 taken: ZF=1");
  });
  test("conditions are shown on the hop that has them", () => {
    const r = lookupTrace(ctx, { from: IDS.A, to: IDS.B });
    if (!r.ok) throw new Error(r.error);
    expect(r.output.shortest_path).toContain("[when module-0001:0011 taken: ZF=1]");
  });
  test("far-call endpoints, same node, unreachable (with reverse hint), disconnected, bad input", () => {
    expect(lookupTrace(ctx, { from: "0016:0020", to: IDS.C })).toMatchObject({ ok: true, output: { from: IDS.A } });
    expect(lookupTrace(ctx, { from: IDS.A, to: IDS.A })).toMatchObject({ ok: true, output: { result: expect.stringContaining("same node") } });
    const rev = lookupTrace(ctx, { from: IDS.D, to: IDS.R });
    expect(rev).toMatchObject({ ok: true, output: { result: expect.stringContaining("No call path") } });
    if (rev.ok) expect(rev.output.tool_hint).toContain("swap from and to");
    const none = lookupTrace(ctx, { from: IDS.Z, to: IDS.R });
    if (none.ok) expect(none.output.tool_hint).toContain("Neither direction");
    const bad = lookupTrace(ctx, { from: "nope", to: IDS.R });
    expect(bad).toMatchObject({ ok: false, error: expect.stringContaining("from:") });
    expect(lookupTrace(ctx, { from: IDS.R, to: "nope" })).toMatchObject({ ok: false, error: expect.stringContaining("to:") });
  });
});
