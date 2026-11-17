import { chmodSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, test } from "vitest";
import { TtlCache } from "../src/cache.js";
import { dashboardVersion, MODULE_PAGE_TRACES, moduleDetail, moduleRows, summary, unitRows } from "../src/dashboard/api.js";
import { CallGraph } from "../src/graph/model.js";
import type { Context } from "../src/graph/tools.js";
import { ProgressStore } from "../src/progress/store.js";
import { graphJson, IDS, makeFixture, type Fixture } from "./fixture.js";

// Fixture work units (test/fixture.ts): work:R = {R, A, B}, work:C = {C, ADDR}, work:D, work:X = {X, Y}, work:R2,
// work:Z. Ready with nothing done: D and Z. Listings exist for A (6 non-blank lines) and C (2).

let fx: Fixture;
let ctx: Context;
beforeEach(() => {
  fx = makeFixture();
  ctx = { graph: CallGraph.load(fx.disassembly), disassemblyRoot: fx.disassembly, progress: new ProgressStore(fx.progressFile), cache: new TtlCache() };
});

const record = (module: string, at: string, file = "src/x.cpp") => ctx.progress.addImplementation({ module, file, function: "x" }, new Date(at));
const detail = (raw: string) => {
  const r = moduleDetail(ctx, raw);
  if (!r.ok) throw new Error(r.error);
  return r.detail;
};

describe("summary", () => {
  test("nothing recorded: totals, empty history, the next_work queue head", () => {
    const s = summary(ctx);
    expect(s.functions).toEqual({ total: 9, implemented: 0, bySameCode: 0, lines: 8, implementedLines: 0 });
    expect(s.units).toEqual({ total: 6, complete: 0, ready: 2, waiting: 4, partial: 0, oversized: 0, indirect: 0 });
    expect(s.annotations).toBe(0);
    expect(s.timeline).toEqual([]);
    expect(s.recent).toEqual([]);
    expect(s.next.map((u) => [u.id, u.rank, u.state])).toEqual([
      [`work:${IDS.D}`, 1, "ready"],
      [`work:${IDS.Z}`, 2, "ready"],
      ...s.next.slice(2).map((u, i) => [u.id, i + 3, "waiting"]),
    ]);
    expect(s.spaces.map((x) => [x.space, x.functions, x.lines])).toEqual([
      ["MAIN-root", 2, 0],
      ["module-0001", 2, 6],
      ["module-0002", 2, 2],
      ["module-0004", 2, 0],
      ["module-0005", 1, 0],
    ]);
    expect(s.progressFile).toBe(fx.progressFile);
  });

  test("progress: per-space lines, partial units, first-record timeline, newest-first activity", () => {
    record(IDS.D, "2026-01-01T10:00:00Z");
    record(IDS.D, "2026-01-03T10:00:00Z", "src/later.cpp"); // a second record keeps the first day
    record(IDS.C, "2026-01-02T23:59:59Z");
    record(IDS.A, "2026-01-02T00:00:00Z");
    record("module-9999:0000", "2025-12-31T00:00:00Z"); // stale id: not in the graph, never counted
    ctx.progress.addAnnotation({ module: IDS.B, annotation_type: "behavioral", description: "draws <b>a</b> frame", references: [] }, new Date("2026-01-04T00:00:00Z"));

    const s = summary(ctx);
    expect(s.functions).toEqual({ total: 9, implemented: 3, bySameCode: 0, lines: 8, implementedLines: 8 });
    // C, D complete; work:R has A of {R, A, B}: partial; C completes so X's and R2's dependency on D/C resolves
    expect(s.units.complete).toBe(2);
    expect(s.units.partial).toBe(1);
    expect(s.timeline).toEqual([
      { date: "2026-01-01", implemented: 1 },
      { date: "2026-01-02", implemented: 3 },
    ]);
    expect(s.recent.map((a) => [a.kind, a.module])).toEqual([
      ["annotation", IDS.B],
      ["implementation", IDS.D],
      ["implementation", IDS.C],
      ["implementation", IDS.A],
      ["implementation", IDS.D],
      ["implementation", "module-9999:0000"],
    ]);
    expect(s.recent[0]!.detail).toBe("[behavioral] draws <b>a</b> frame");
    expect(s.annotations).toBe(1);
    expect(s.spaces.find((x) => x.space === "module-0002")).toMatchObject({ implemented: 2, implementedLines: 2 });
  });

  test("everything implemented: an empty queue", () => {
    for (const id of [IDS.R, IDS.R2, IDS.A, IDS.B, IDS.C, IDS.D, IDS.X, IDS.Y, IDS.Z]) record(id, "2026-02-01T00:00:00Z");
    const s = summary(ctx);
    expect(s.next).toEqual([]);
    expect(s.units).toMatchObject({ complete: 6, ready: 0, waiting: 0 });
    expect(unitRows(ctx).every((u) => u.rank === null && u.state === "complete")).toBe(true);
  });
});

describe("graph shapes the generated tree rarely has", () => {
  // a function with no space (listed first, as "(no space)"), a call to an id the graph never defines,
  // a call through a run-time address, and a budget so small that work:R is oversized
  const LOOSE = "loose";
  const UNRESOLVED = "unknown:module-0005:0003";
  const odd = (): Context => {
    const g = graphJson();
    const blank = { space: null, address: null, file_offset: null, source_file: null, listing: null, entrypoint: false };
    return {
      ...ctx,
      workOptions: { budgetLines: 3, trivialLines: 1 },
      graph: new CallGraph({
        ...g,
        nodes: { ...g.nodes, [LOOSE]: { id: LOOSE, kind: "function", ...blank }, [UNRESOLVED]: { id: UNRESOLVED, kind: "unknown-target", ...blank } },
        edges: [
          ...g.edges,
          { source: LOOSE, target: "never-defined", instruction: "call 0x1", instruction_offset: "x", returns: true, conditions: [] },
          { source: LOOSE, target: "never-defined", instruction: "call 0x1", instruction_offset: "y", returns: true, conditions: [] },
          { source: IDS.Z, target: UNRESOLVED, instruction: "lcall [di + 0x6786]", instruction_offset: "module-0005:0003", returns: true, conditions: [] },
          // a second caller: the run-time target then belongs to no work unit
          { source: IDS.R2, target: UNRESOLVED, instruction: "lcall [bx]", instruction_offset: "MAIN-root:0106", returns: true, conditions: [] },
        ],
      }),
    };
  };

  test("summary groups a space-less function, counts oversized and indirect units, and nothing starts out complete", () => {
    ctx = odd();
    const s = summary(ctx);
    expect(s.spaces.map((x) => x.space)).toEqual(["(no space)", "MAIN-root", "module-0001", "module-0002", "module-0004", "module-0005"]);
    expect(s.spaces[0]).toMatchObject({ sourceFile: null, functions: 1, lines: 0 });
    expect(s.units.oversized).toBeGreaterThan(0);
    expect(s.units.indirect).toBe(2);
    expect(s.units.complete).toBe(0);
    expect(moduleRows(ctx)[0]!.id).toBe(LOOSE);
  });

  test("neighbours outside the graph and run-time targets are named, without a status", () => {
    ctx = odd();
    const plain = (at: string) => ({ instruction: "call 0x1", at, conditions: [], through: null, possible: false, link: null });
    expect(detail(LOOSE).callees).toEqual([{ id: "never-defined", kind: "unknown", status: null, sameCodeAs: null, sites: [plain("x"), plain("y")], reason: null }]);
    const z = detail(IDS.Z);
    // an older tree's unknown target carries no reason: the default explanation stands in
    expect(z.callees[0]).toMatchObject({ id: UNRESOLVED, kind: "unknown-target", status: null, reason: "the call site could not be traced to a function" });
    expect(z.unit!.indirectCalls).toEqual(["module-0005:0003  lcall [di + 0x6786] — the call site could not be traced to a function"]);
    expect(z.unit!.indirect).toBe(1);
    expect(detail(LOOSE)).toMatchObject({ space: null, listing: null, callers: [], provisional: false, evidence: [], reason: null });
    expect(detail(UNRESOLVED)).toMatchObject({ kind: "unknown-target", status: null, unit: null, callers: [{ id: IDS.Z }, { id: IDS.R2 }] });
  });

  test("pointer provenance: provisional functions, evidence, reasons and what a call went through", () => {
    const g = graphJson();
    const unknown = "unknown:MAIN-root:0200";
    ctx = {
      ...ctx,
      graph: new CallGraph({
        ...g,
        nodes: {
          ...g.nodes,
          [IDS.B]: { ...g.nodes[IDS.B]!, provisional: true, evidence: ["far pointer built at X", 7 as unknown as string] },
          [unknown]: { id: unknown, kind: "unknown-target", space: null, address: null, file_offset: null, source_file: null, listing: null, entrypoint: false, reason: "nothing stores a constant pointer into ds:[0100]" },
        },
        edges: [
          ...g.edges,
          { source: IDS.R, target: IDS.B, instruction: "lcall [0x6a78]", instruction_offset: "MAIN-root:0200", returns: true, conditions: [], through: "ds:[6a78]", provisional: true },
          { source: IDS.R, target: unknown, instruction: "lcall [0x6a78]", instruction_offset: "MAIN-root:0200", returns: true, conditions: [], through: "ds:[6a78]" },
        ],
      }),
    };
    const b = detail(IDS.B);
    expect(b).toMatchObject({ provisional: true, evidence: ["far pointer built at X"], reason: null });
    const site = b.callers.find((n) => n.id === IDS.R)!.sites.find((s) => s.at === "MAIN-root:0200");
    expect(site).toEqual({ instruction: "lcall [0x6a78]", at: "MAIN-root:0200", conditions: [], through: "ds:[6a78]", possible: true, link: null });
    expect(detail(IDS.R).callees.find((n) => n.id === unknown)!.reason).toBe("nothing stores a constant pointer into ds:[0100]");
    expect(detail(unknown)).toMatchObject({ reason: "nothing stores a constant pointer into ds:[0100]", evidence: [], provisional: false });
  });

  test("the timeline is in date order whatever order records were written", () => {
    record(IDS.C, "2026-03-02T00:00:00Z");
    record(IDS.D, "2026-03-01T00:00:00Z");
    record(IDS.A, "2026-03-03T00:00:00Z");
    record(IDS.B, "2026-02-28T00:00:00Z");
    expect(summary(ctx).timeline.map((p) => p.date)).toEqual(["2026-02-28", "2026-03-01", "2026-03-02", "2026-03-03"]);
  });
});

describe("moduleRows / unitRows", () => {
  test("every function once, by space then address, with neighbour counts and status", () => {
    record(IDS.D, "2026-01-01T00:00:00Z");
    ctx.progress.addAnnotation({ module: IDS.C, annotation_type: "functional", description: "n", references: [] });
    const rows = moduleRows(ctx);
    expect(rows.map((r) => r.id)).toEqual([IDS.R, IDS.R2, IDS.A, IDS.B, IDS.C, IDS.D, IDS.X, IDS.Y, IDS.Z]);
    const c = rows.find((r) => r.id === IDS.C)!;
    expect(c).toMatchObject({ callers: 3, callees: 2, lines: 2, unit: `work:${IDS.C}`, annotations: 1, status: "ready" });
    expect(rows.find((r) => r.id === IDS.D)!.status).toBe("implemented");
    expect(rows.find((r) => r.id === IDS.A)!.status).toBe("waiting");
  });

  test("units: the ranked queue, then complete units", () => {
    record(IDS.D, "2026-01-01T00:00:00Z");
    const units = unitRows(ctx);
    expect(units).toHaveLength(6);
    expect(units.at(-1)).toMatchObject({ id: `work:${IDS.D}`, state: "complete", rank: null, members: 1, implemented: 1 });
    expect(units.slice(0, -1).map((u) => u.rank)).toEqual([1, 2, 3, 4, 5]);
    expect(units.find((u) => u.id === `work:${IDS.C}`)).toMatchObject({ members: 1, state: "ready" }); // ADDR is not a function
  });
});

describe("moduleDetail", () => {
  test("a node name: listing with call targets, neighbours with sites and conditions, its work unit", () => {
    const d = detail(IDS.A);
    expect(d).toMatchObject({ id: IDS.A, note: null, kind: "function", space: "module-0001", address: 0x10, lines: 6, status: "waiting" });
    expect(d.listing).toContain(`; → ${IDS.B}`);
    expect(d.callers).toEqual([{ id: IDS.R, kind: "function", status: "waiting", sameCodeAs: null, reason: null, sites: [{ instruction: "lcall 0x2000, 0x0010", at: "MAIN-root:0010", conditions: [], through: null, possible: false, link: null }] }]);
    expect(d.callees.find((n) => n.id === IDS.B)!.sites[0]!.conditions).toEqual(["module-0001:0011 taken: ZF=1"]);
    expect(d.unit).toMatchObject({ id: `work:${IDS.R}`, members: 3, state: "waiting", rank: expect.any(Number) });
    expect(d.unit!.memberList.map((m) => m.id)).toEqual([IDS.R, IDS.A, IDS.B]);
    expect(d.unit!.dependsOnList).toEqual([{ id: `work:${IDS.C}`, state: "waiting" }]);
    expect(d.unit!.dependents).toEqual([]);
  });

  test("addresses and work unit ids resolve the way the module tool does", () => {
    expect(detail("0016:0020")).toMatchObject({ id: IDS.A, note: expect.stringContaining("far-call alias") });
    expect(detail(` work:${IDS.D} `)).toMatchObject({ id: IDS.D, note: `work:${IDS.D} is a work unit; this is its root function.` });
    const d = detail(IDS.D);
    expect(d.unit!.dependents.map((u) => u.id).sort()).toEqual([`work:${IDS.C}`, `work:${IDS.X}`].sort());
  });

  test("traces back to entrypoints: nearest first, with every call site on the way", () => {
    const hop = (to: string, at: string, conditions: string[] = []) => ({ to, at, instruction: `lcall 0x2000, 0x${to.split(":")[1]}`, through: null, possible: false, link: null, conditions, otherSites: 0 });
    expect(detail(IDS.D).traces).toEqual({
      total: 2,
      targetIsRoot: false,
      shown: [
        { entry: IDS.R2, hops: [hop(IDS.C, "MAIN-root:0104"), hop(IDS.D, "module-0002:0032")] },
        { entry: IDS.R, hops: [hop(IDS.A, "MAIN-root:0010"), hop(IDS.C, "module-0001:0014"), hop(IDS.D, "module-0002:0032")] },
      ],
    });
    expect(detail(IDS.B).traces.shown[0]!.hops[1]).toEqual(hop(IDS.B, "module-0001:0012", ["module-0001:0011 taken: ZF=1"]));
    expect(detail(IDS.R).traces).toEqual({ total: 0, targetIsRoot: true, shown: [] });
    // X and Y only call each other: no entrypoint reaches them, though X has a caller
    expect(detail(IDS.X)).toMatchObject({ traces: { total: 0, targetIsRoot: false, shown: [] }, callers: [{ id: IDS.Y }] });
  });

  test("traces past the page's limit are counted, not shown; several sites between two functions are counted too", () => {
    const g = graphJson();
    const entries = Array.from({ length: MODULE_PAGE_TRACES + 2 }, (_, i) => `MAIN-root:${(0x200 + i).toString(16).padStart(4, "0")}`);
    const blank = { kind: "function", space: "MAIN-root", address: 0, file_offset: 0, source_file: "MAIN.EXE", listing: null, entrypoint: false };
    const call = (source: string, at: string, extra = {}) => ({ source, target: IDS.Z, instruction: "lcall [0x100]", instruction_offset: at, returns: true, conditions: [], ...extra });
    ctx = {
      ...ctx,
      graph: new CallGraph({
        ...g,
        nodes: { ...g.nodes, ...Object.fromEntries(entries.map((id) => [id, { id, ...blank }])) },
        edges: [...g.edges, ...entries.map((id) => call(id, id, { through: "ds:[0100]", provisional: true })), call(entries[0]!, "MAIN-root:0300")],
      }),
    };
    const t = detail(IDS.Z).traces;
    expect(t).toMatchObject({ total: MODULE_PAGE_TRACES + 2, targetIsRoot: false });
    expect(t.shown).toHaveLength(MODULE_PAGE_TRACES);
    expect(t.shown[0]).toEqual({ entry: entries[0], hops: [{ to: IDS.Z, at: entries[0], instruction: "lcall [0x100]", through: "ds:[0100]", possible: true, link: null, conditions: [], otherSites: 1 }] });
  });

  test("implementations and annotations of this node only", () => {
    record(IDS.C, "2026-01-01T00:00:00Z");
    ctx.progress.addAnnotation({ module: IDS.C, annotation_type: "functional", description: "c", references: [{ reference_type: "module", reference_content: IDS.D }] });
    ctx.progress.addAnnotation({ module: IDS.D, annotation_type: "functional", description: "d", references: [] });
    const d = detail(IDS.C);
    expect(d.status).toBe("implemented");
    expect(d.implementations.map((r) => r.module)).toEqual([IDS.C]);
    expect(d.annotations.map((r) => r.description)).toEqual(["c"]);
  });

  test("non-function nodes have no status, listing or lines", () => {
    expect(detail(IDS.ADDR)).toMatchObject({ kind: "address", status: null, listing: null, lines: 0 });
  });

  test("a function without a listing on disk", () => {
    expect(detail(IDS.D)).toMatchObject({ status: "ready", listing: null, lines: 0 });
  });

  test.skipIf(process.getuid?.() === 0)("an unreadable listing is reported as none", () => {
    const file = path.join(fx.disassembly, "units", "play", "functions", "module-0002_0030.asm");
    chmodSync(file, 0o000);
    try {
      expect(detail(IDS.C).listing).toBeNull();
    } finally {
      chmodSync(file, 0o644);
    }
  });

  test.each(["", "   ", "nope", "module-0001:9999", "work:", "lcall 0x9999, 0x9999", "\u0000", "x".repeat(10_000)])("unknown input %j is explained, not thrown", (raw) => {
    const r = moduleDetail(ctx, raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.length).toBeGreaterThan(10);
  });
});

test("dashboardVersion changes when progress is written", () => {
  const before = dashboardVersion(ctx);
  expect(before).toBe(dashboardVersion(ctx));
  record(IDS.D, "2026-01-01T00:00:00Z");
  expect(dashboardVersion(ctx)).not.toBe(before);
  expect(dashboardVersion({ ...ctx, disassemblyRoot: path.join(fx.root, "missing") })).toMatch(/\|absent$/);
});
