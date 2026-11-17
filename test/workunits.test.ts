import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { CallGraph, type GraphNode } from "../src/graph/model.js";
import { buildWorkPlan, compareWorkUnits, DEFAULT_WORK_UNIT_OPTIONS, listingSize, parseWorkUnitId, workUnitId, type WorkPlan, type WorkUnit } from "../src/graph/workunits.js";
import { IDS, makeFixture } from "./fixture.js";

// Hand-built graphs: node names are bare letters, sizes given per node (default 10), budget 100 / trivial 10.
const OPTS = { budgetLines: 100, trivialLines: 10 };

function graphOf(edges: Array<[string, string]>, extra: string[] = [], kinds: Record<string, string> = {}): CallGraph {
  const ids = new Set([...edges.flat(), ...extra]);
  const node = (id: string): GraphNode => ({ id, kind: kinds[id] ?? "function", space: "m", address: 0, file_offset: 0, source_file: null, listing: null, entrypoint: false });
  return new CallGraph({
    aliases: {},
    nodes: Object.fromEntries([...ids].map((id) => [id, node(id)])),
    edges: edges.map(([source, target]) => ({ source, target, instruction: "call", instruction_offset: source, returns: true, conditions: [] })),
  });
}

function plan(edges: Array<[string, string]>, sizes: Record<string, number> = {}, opts: { extra?: string[]; kinds?: Record<string, string>; implemented?: string[] } = {}): WorkPlan {
  return buildWorkPlan(graphOf(edges, opts.extra, opts.kinds), new Set(opts.implemented ?? []), (id) => sizes[id] ?? 10, OPTS);
}

/** unit id -> members, for compact partition assertions */
const partition = (p: WorkPlan) => Object.fromEntries([...p.units.values()].map((u) => [u.id, u.members]));
const unit = (p: WorkPlan, root: string): WorkUnit => p.units.get(`work:${root}`)!;

describe("partition", () => {
  test("single-caller chains roll up into their root", () => {
    const p = plan([["R", "A"], ["A", "B"]]);
    expect(partition(p)).toEqual({ "work:R": ["R", "A", "B"] });
    expect(unit(p, "R")).toMatchObject({ lines: 30, oversized: false, dependsOn: [], externalCallees: [] });
    expect([...p.unitOf]).toEqual([["R", "work:R"], ["A", "work:R"], ["B", "work:R"]]);
  });
  test("a node with two callers is its own root; a node nobody calls is a root", () => {
    const p = plan([["R", "A"], ["R", "B"], ["A", "C"], ["B", "C"]], {}, { extra: ["Z"] });
    expect(partition(p)).toEqual({ "work:R": ["R", "A", "B"], "work:C": ["C"], "work:Z": ["Z"] });
    expect(unit(p, "R")).toMatchObject({ dependsOn: ["work:C"], externalCallees: ["C"] });
  });
  test("two calls from the same caller still count as one caller", () => {
    const g = graphOf([["R", "A"], ["R", "A"]]);
    expect(partition(buildWorkPlan(g, new Set(), () => 10, OPTS))).toEqual({ "work:R": ["R", "A"] });
  });
  test("self-calls and edges to unknown nodes are ignored", () => {
    const g = new CallGraph({
      aliases: {},
      nodes: Object.fromEntries(["R", "A"].map((id) => [id, { id, kind: "function", space: "m", address: 0, file_offset: 0, source_file: null, listing: null, entrypoint: false }])),
      edges: [["R", "R"], ["R", "A"], ["A", "A"], ["A", "GHOST"]].map(([source, target]) => ({ source: source!, target: target!, instruction: "call", instruction_offset: "x", returns: true, conditions: [] })),
    });
    const p = buildWorkPlan(g, new Set(), () => 10, OPTS);
    expect(partition(p)).toEqual({ "work:R": ["R", "A"] });
    expect(unit(p, "R").externalCallees).toEqual([]);
  });
  test("calls through stored pointers neither own nor order units: a dispatcher and its handlers stay apart", () => {
    // R calls dispatcher D, which reaches H through a table; H calls back into D (an interpreter); K is D's own callee
    const g = graphOf([["R", "D"], ["D", "K"], ["H", "D"]]);
    const blank = { space: "m", address: 0, file_offset: 0, source_file: null, listing: null, entrypoint: false };
    const withPointer = new CallGraph({
      aliases: {},
      nodes: { ...Object.fromEntries(g.nodes), U: { id: "U", kind: "unknown-target", ...blank } },
      edges: [
        ...g.edges,
        { source: "D", target: "H", instruction: "lcall [di + 0x6786]", instruction_offset: "D", returns: true, conditions: [], through: "ds:[index+6786]" },
        // the unresolved part of the same site stays listed with D, as any unresolved call
        { source: "D", target: "U", instruction: "lcall [di + 0x6786]", instruction_offset: "D", returns: true, conditions: [], through: "ds:[index+6786]" },
      ],
    });
    const p = buildWorkPlan(withPointer, new Set(), () => 10, OPTS);
    expect(partition(p)).toEqual({ "work:R": ["R"], "work:H": ["H"], "work:D": ["D", "K", "U"] });
    expect(unit(p, "D")).toMatchObject({ dependsOn: [], externalCallees: [] });
    expect(unit(p, "H")).toMatchObject({ dependsOn: ["work:D"], externalCallees: ["D"] });
  });
  test("mutual recursion stays in one unit: owned by its single caller", () => {
    const p = plan([["R", "X"], ["X", "Y"], ["Y", "X"], ["Y", "Z"]]);
    expect(partition(p)).toEqual({ "work:R": ["R", "X", "Y", "Z"] });
  });
  test("a recursive group with two callers is a root named by its entered member", () => {
    const p = plan([["R1", "Y"], ["R2", "Y"], ["X", "Y"], ["Y", "X"]]);
    expect(partition(p)).toMatchObject({ "work:Y": ["Y", "X"] });
    expect(p.unitOf.get("X")).toBe("work:Y");
    // two members entered from outside: the lowest id names it
    const q = plan([["R1", "Y"], ["R2", "X"], ["X", "Y"], ["Y", "X"]]);
    expect(partition(q)).toMatchObject({ "work:X": ["X", "Y"] });
  });
  test("a recursive group nobody calls is named by its lowest id", () => {
    expect(partition(plan([["Q", "P"], ["P", "Q"]]))).toEqual({ "work:P": ["P", "Q"] });
  });
  test("a three-member cycle with one caller is owned by that caller", () => {
    const p = plan([["R", "A"], ["A", "B"], ["B", "C"], ["C", "A"]]);
    expect(partition(p)).toEqual({ "work:R": ["R", "A", "B", "C"] });
  });
  test("deep chains (beyond any recursion limit) are handled iteratively", () => {
    const edges: Array<[string, string]> = Array.from({ length: 20_000 }, (_, i) => [`n${i}`, `n${i + 1}`]);
    edges.push([`n20000`, "n0"]);
    const p = buildWorkPlan(graphOf(edges), new Set(), () => 1, OPTS);
    expect(p.units.size).toBe(1);
    expect([...p.units.values()][0]!.members).toHaveLength(20_001);
  });
  test("non-function nodes take part with their size", () => {
    const p = plan([["R", "ADDR"]], { ADDR: 5 }, { kinds: { ADDR: "address" } });
    expect(unit(p, "R")).toMatchObject({ members: ["R", "ADDR"], lines: 15 });
  });
  test("empty graph: empty plan", () => {
    const p = plan([]);
    expect(p.units.size).toBe(0);
    expect(p.unitOf.size).toBe(0);
    expect(p.ranked).toEqual([]);
  });
});

describe("walk-back split", () => {
  test("exactly at budget stays whole; one line over splits", () => {
    expect(partition(plan([["R", "A"]], { R: 50, A: 50 }))).toEqual({ "work:R": ["R", "A"] });
    const over = plan([["R", "A"]], { R: 50, A: 51 });
    expect(partition(over)).toEqual({ "work:R": ["R"], "work:A": ["A"] });
    expect([...over.units.values()].some((u) => u.oversized)).toBe(false);
  });
  test("trivial leaves fold into the parent; size == trivialLines splits; trivial-but-calls splits", () => {
    const p = plan(
      [["R", "T"], ["R", "N"], ["R", "K"], ["K", "L"]],
      { R: 85, T: 9, N: 10, K: 1, L: 1 },
    );
    expect(partition(p)).toEqual({ "work:R": ["R", "T"], "work:N": ["N"], "work:K": ["K", "L"] });
    expect(unit(p, "R")).toMatchObject({ lines: 94, externalCallees: ["K", "N"], dependsOn: ["work:K", "work:N"] });
  });
  test("a split-off child over budget splits again", () => {
    const p = plan([["R", "A"], ["A", "B"]], { R: 10, A: 60, B: 60 });
    expect(partition(p)).toEqual({ "work:R": ["R"], "work:A": ["A"], "work:B": ["B"] });
  });
  test("a split-off child within budget keeps its subtree", () => {
    const p = plan([["R", "A"], ["A", "B"], ["R", "C"]], { R: 60, A: 20, B: 20, C: 30 });
    expect(partition(p)).toEqual({ "work:R": ["R"], "work:A": ["A", "B"], "work:C": ["C"] });
  });
  test("a monolith over budget is flagged oversized; folded trivial leaves can tip a unit over", () => {
    expect(unit(plan([], { M: 150 }, { extra: ["M"] }), "M")).toMatchObject({ lines: 150, oversized: true });
    expect(unit(plan([], { M: 100 }, { extra: ["M"] }), "M").oversized).toBe(false);
    const tipped = plan([["R", "T"]], { R: 95, T: 9 });
    expect(partition(tipped)).toEqual({ "work:R": ["R", "T"] });
    expect(unit(tipped, "R")).toMatchObject({ lines: 104, oversized: true });
  });
  test("a split never breaks a multi-caller node's own unit", () => {
    const p = plan([["R", "A"], ["R", "S"], ["A", "S"]], { R: 90, A: 20, S: 50 });
    expect(partition(p)).toEqual({ "work:R": ["R"], "work:A": ["A"], "work:S": ["S"] });
  });
});

describe("progress", () => {
  // P1, P2 both call S and Q; Q also calls an address-only node only it reaches; SHARED is a run-time target two units call
  const edges: Array<[string, string]> = [["P1", "S"], ["P2", "S"], ["P1", "Q"], ["P2", "Q"], ["Q", "ADDR"], ["P1", "SHARED"], ["P2", "SHARED"]];
  const kinds = { ADDR: "address", SHARED: "unknown-target" };

  test("dependencies, readiness, unblocks and completion", () => {
    const p = plan(edges, {}, { kinds, implemented: ["S"] });
    expect(partition(p)).toEqual({ "work:P1": ["P1"], "work:P2": ["P2"], "work:S": ["S"], "work:Q": ["Q", "ADDR"] });
    expect(unit(p, "S")).toMatchObject({ complete: true, implemented: ["S"], readiness: 1, unblocks: 2 });
    expect(unit(p, "Q")).toMatchObject({ complete: false, implemented: [], readiness: 1, unblocks: 2, externalCallees: [] });
    // the shared run-time target is no dependency, only an indirect call
    expect(unit(p, "P1")).toMatchObject({ dependsOn: ["work:Q", "work:S"], externalCallees: ["Q", "S"], readiness: 1 / 2, unblocks: 0, indirectCalls: [{ site: "P1", instruction: "call", reason: "the call site could not be traced to a function" }] });
    expect(p.ranked.map((u) => u.id)).toEqual(["work:Q", "work:P1", "work:P2"]);
  });
  test("nodes with nothing to write never form a work unit, so nothing starts out complete", () => {
    // SHARED: run-time target with two callers; LOOSE: address nobody calls; ORPHAN: run-time target nobody calls;
    // GATE: address nobody calls whose only callee F then roots its own unit
    const p = plan([...edges, ["GATE", "F"]], {}, { kinds: { ...kinds, LOOSE: "address", ORPHAN: "unknown-target", GATE: "address" }, extra: ["LOOSE", "ORPHAN"] });
    expect(Object.keys(partition(p)).sort()).toEqual(["work:F", "work:P1", "work:P2", "work:Q", "work:S"]);
    expect([...p.units.values()].filter((u) => u.complete)).toEqual([]);
    for (const id of ["SHARED", "LOOSE", "ORPHAN", "GATE"]) expect(p.unitOf.has(id), id).toBe(false);
    expect(p.unitOf.get("ADDR")).toBe("work:Q"); // a single caller still lists it with that caller
  });
  test("an implemented function alone completes a unit with address members", () => {
    const p = plan(edges, {}, { kinds, implemented: ["S", "Q"] });
    expect(unit(p, "Q").complete).toBe(true);
    expect(unit(p, "P1").readiness).toBe(1);
    expect(unit(p, "Q").unblocks).toBe(2);
  });
  test("complete units unblock nothing and drop out of the ranking", () => {
    const p = plan(edges, {}, { kinds, implemented: ["S", "Q", "P1", "P2"] });
    expect(p.ranked).toEqual([]);
    for (const u of p.units.values()) expect(u.unblocks).toBe(0);
  });
  test("partly implemented units stay incomplete; implemented ids outside the graph are ignored", () => {
    const p = plan([["R", "A"]], {}, { implemented: ["A", "nope"] });
    expect(unit(p, "R")).toMatchObject({ implemented: ["A"], complete: false });
  });
  test("implementation never changes the partition", () => {
    const g = graphOf([["R", "A"], ["A", "B"], ["R", "C"], ["X", "C"], ["C", "D"], ["D", "C"]]);
    const sizes: Record<string, number> = { R: 60, A: 30, B: 30, C: 5 };
    const sizeOf = (id: string) => sizes[id] ?? 10;
    const none = buildWorkPlan(g, new Set(), sizeOf, OPTS);
    const all = buildWorkPlan(g, new Set(g.nodes.keys()), sizeOf, OPTS);
    expect(partition(all)).toEqual(partition(none));
    expect([...all.unitOf]).toEqual([...none.unitOf]);
  });
});

describe("ranking", () => {
  const u = (id: string, over: Partial<WorkUnit> = {}): WorkUnit => ({
    id, root: id, members: [id], lines: 100, oversized: false, dependsOn: [], externalCallees: [], implemented: [], complete: false, readiness: 1, unblocks: 0, indirectCalls: [], ...over,
  });
  const order = (...units: WorkUnit[]) => [...units].sort((a, b) => compareWorkUnits(a, b, 100)).map((x) => x.id);

  test("fully ready beats more unblocks", () => {
    expect(order(u("a", { readiness: 0.99, unblocks: 9 }), u("b", { readiness: 1 }))).toEqual(["b", "a"]);
  });
  test("among ready units, calls through run-time addresses go last, whatever they unblock; readiness still wins", () => {
    const ic = (instruction: string) => [{ site: "m:0001", instruction, reason: "r" }];
    expect(order(u("a", { indirectCalls: ic("lcall [di + 0x6786]"), unblocks: 50 }), u("b"))).toEqual(["b", "a"]);
    expect(order(u("a", { indirectCalls: ic("call ax") }), u("b", { readiness: 0.5 }))).toEqual(["a", "b"]);
    expect(order(u("a", { indirectCalls: ic("x"), readiness: 0 }), u("b", { readiness: 0, unblocks: 3 }))).toEqual(["b", "a"]);
  });
  test("a unit's indirect calls are its members' edges into unresolved targets, with site and instruction", () => {
    const p = plan([["D", "U"], ["D", "F"], ["R", "D"], ["Q", "D"]], {}, { kinds: { U: "unknown-target" } });
    expect(unit(p, "D")).toMatchObject({ members: ["D", "F", "U"], indirectCalls: [{ site: "D", instruction: "call", reason: "the call site could not be traced to a function" }], dependsOn: [] });
    expect(unit(p, "R").indirectCalls).toEqual([]);
    // R and Q wait on D; with nothing implemented, D (ready, though a dispatcher) still comes before them
    expect(p.ranked[0]!.id).toBe("work:D");
  });
  test("partial readiness levels are not ranked against each other", () => {
    expect(order(u("b", { readiness: 0.9 }), u("a", { readiness: 0 }))).toEqual(["a", "b"]);
  });
  test("more unblocks beats size and oversize", () => {
    expect(order(u("a", { unblocks: 1 }), u("b", { unblocks: 2, oversized: true, lines: 5000 }))).toEqual(["b", "a"]);
  });
  test("not oversized beats a smaller interface", () => {
    expect(order(u("a", { oversized: true }), u("b", { externalCallees: ["x", "y"] }))).toEqual(["b", "a"]);
  });
  test("smaller interface beats size near budget", () => {
    expect(order(u("a", { externalCallees: ["x"] }), u("b", { lines: 2 }))).toEqual(["b", "a"]);
  });
  test("size closer to budget, from either side, then id", () => {
    expect(order(u("a", { lines: 10 }), u("b", { lines: 95 }), u("c", { lines: 104 }))).toEqual(["c", "b", "a"]);
    expect(order(u("b", { lines: 90 }), u("a", { lines: 110 }))).toEqual(["a", "b"]);
    expect(order(u("b"), u("a"))).toEqual(["a", "b"]);
    expect(compareWorkUnits(u("a"), u("a"), 100)).toBe(0);
  });
  test("end to end: ready leaf that unblocks the most comes first", () => {
    const p = plan([["R", "A"], ["R", "B"], ["A", "C"], ["B", "C"], ["X", "B"]], { R: 10, A: 10, B: 10 });
    // C is ready and unblocks R and B; B unblocks R and X; X has the smaller interface of the rest
    expect(p.ranked.map((x) => x.id)).toEqual(["work:C", "work:B", "work:X", "work:R"]);
  });
});

describe("options", () => {
  test("defaults", () => {
    expect(DEFAULT_WORK_UNIT_OPTIONS).toEqual({ budgetLines: 600, trivialLines: 20 });
    const p = buildWorkPlan(graphOf([["R", "A"]]), new Set(), () => 300);
    expect(partition(p)).toEqual({ "work:R": ["R", "A"] });
  });
  test("smallest valid options", () => {
    const p = buildWorkPlan(graphOf([["R", "A"]]), new Set(), () => 1, { budgetLines: 1, trivialLines: 1 });
    expect(partition(p)).toEqual({ "work:R": ["R"], "work:A": ["A"] });
  });
  test.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1.5])("rejects %d for either option", (bad) => {
    const g = graphOf([["R", "A"]]);
    expect(() => buildWorkPlan(g, new Set(), () => 1, { budgetLines: bad, trivialLines: 20 })).toThrow(RangeError);
    expect(() => buildWorkPlan(g, new Set(), () => 1, { budgetLines: 600, trivialLines: bad })).toThrow(/trivialLines/);
  });
});

describe("parseWorkUnitId", () => {
  test("round-trips workUnitId", () => expect(parseWorkUnitId(workUnitId("module-0200:32df"))).toBe("module-0200:32df"));
  test.each([
    ["work:module-0200:32df", "module-0200:32df"],
    ["  WORK:Module-0200:32DF \n", "Module-0200:32DF"],
    ["Work:  MAIN-root:6271  ", "MAIN-root:6271"],
    ["work:x", "x"],
  ])("accepts %j", (input, id) => expect(parseWorkUnitId(input)).toBe(id));
  test.each(["", "   ", "work:", "work:   ", "work", "module-0200:32df", "wrk:module-0200:32df", " x work:a", "unit:game-ovr"])("rejects %j", (input) => {
    expect(parseWorkUnitId(input)).toBeUndefined();
  });
});

describe("listingSize", () => {
  test("non-blank lines of the node's listing, memoized; no listing or unknown node is 0", () => {
    const fx = makeFixture();
    const graph = CallGraph.load(fx.disassembly);
    const file = path.join(fx.disassembly, "units/play/functions/module-0001_0010.asm");
    writeFileSync(file, "a\n\n  \t\nb\r\nc");
    const size = listingSize(fx.disassembly, graph);
    expect(size(IDS.A)).toBe(3);
    writeFileSync(file, "only\n");
    expect(size(IDS.A)).toBe(3);
    expect(listingSize(fx.disassembly, graph)(IDS.A)).toBe(1);
    expect(size(IDS.C)).toBe(2);
    expect(size(IDS.D)).toBe(0); // function with no file on disk
    expect(size(IDS.ADDR)).toBe(0);
    expect(size("nope")).toBe(0);
    expect(size("")).toBe(0);
  });
  test("an empty listing is 0 lines", () => {
    const fx = makeFixture();
    writeFileSync(path.join(fx.disassembly, "units/play/functions/module-0002_0030.asm"), "\n\n");
    expect(listingSize(fx.disassembly, CallGraph.load(fx.disassembly))(IDS.C)).toBe(0);
  });
});
