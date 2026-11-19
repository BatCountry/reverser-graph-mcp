import { writeFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, test } from "vitest";
import { TtlCache } from "../src/cache.js";
import { CallGraph } from "../src/graph/model.js";
import { lookupModule, type Context } from "../src/graph/tools.js";
import { getWorkPlan } from "../src/graph/workplan-cache.js";
import { ProgressStore } from "../src/progress/store.js";
import { nextWork, renderNextWorkText, renderWorkPlan, renderWorkUnit } from "../src/tools/next_work.js";
import { graphJson, IDS, makeFixture, type Fixture } from "./fixture.js";

// Fixture work units (see test/fixture.ts): R owns A owns B; C (3 callers) owns ADDR; D (2 callers); the X<->Y cycle;
// R2; Z. Ready first: D (unblocks C and the cycle) then Z; C waits on D.
const W = {
  R: `work:${IDS.R}`, R2: `work:${IDS.R2}`, C: `work:${IDS.C}`, D: `work:${IDS.D}`, X: `work:${IDS.X}`, Z: `work:${IDS.Z}`,
} as const;
const FUNCTIONS = [IDS.R, IDS.R2, IDS.A, IDS.B, IDS.C, IDS.D, IDS.X, IDS.Y, IDS.Z];

let fx: Fixture;
let ctx: Context;
beforeEach(() => {
  fx = makeFixture();
  ctx = { graph: CallGraph.load(fx.disassembly), disassemblyRoot: fx.disassembly, progress: new ProgressStore(fx.progressFile), cache: new TtlCache() };
});

const ok = (args: Parameters<typeof nextWork>[1]) => {
  const r = nextWork(ctx, args);
  if (!r.ok) throw new Error(r.error);
  return r.output;
};
const fails = (args: Parameters<typeof nextWork>[1]) => {
  const r = nextWork(ctx, args);
  if (r.ok) throw new Error(`expected an error, got ${r.output.work_unit}`);
  return r.error;
};
const record = (modules: string[]) => ctx.progress.addImplementations(modules.map((module) => ({ module, file: "src/x.cpp", function: "x" })));

describe("calls through addresses computed at run time", () => {
  // Z (isolated) gains a transfer the graph cannot resolve; `reason` as the generator writes it, absent in older trees
  const withDispatcher = (reason?: string, instruction = "lcall [di + 0x6786]"): Context => {
    const g = graphJson();
    const unknown = "unknown:module-0005:0003";
    return {
      ...ctx,
      graph: new CallGraph({
        ...g,
        nodes: { ...g.nodes, [unknown]: { id: unknown, kind: "unknown-target", space: null, address: null, file_offset: null, source_file: null, listing: null, entrypoint: false, ...(reason ? { reason } : {}) } },
        edges: [...g.edges, { source: IDS.Z, target: unknown, instruction, instruction_offset: "module-0005:0003", returns: true, conditions: [], through: "ds:[index+6786]" }],
      }),
    };
  };
  test("next_work says so, with the call site, why, and how to translate it, and does not call the unit dependency-free", () => {
    ctx = withDispatcher("ds:[index+6786] is also written through an index (at module-0002:0010)");
    const o = ok({ module: IDS.Z });
    expect(o.summary).toContain("Ready: it calls nothing else outside itself");
    expect(o.summary).toContain("It also makes 1 transfer the graph cannot resolve to a function. module-0005:0003 `lcall [di + 0x6786]` (ds:[index+6786] is also written through an index (at module-0002:0010)): implement each such call as a lookup in a table of function pointers keyed by the far address");
    expect(o.members).toContain("unknown:module-0005:0003 — 0 lines — unresolved transfer, no listing: ds:[index+6786] is also written through an index");
  });
  test("chaining to the previous interrupt handler gets its own advice", () => {
    ctx = withDispatcher("the previous INT 08h handler, which DOS returned (INT 21h/35h) at MAIN-root:4949", "ljmp cs:[0x214b]");
    const o = ok({ module: IDS.Z });
    expect(o.summary).toContain("it hands INT 08h on to the handler that was installed before the program's own");
    expect(o.summary).not.toContain("table of function pointers");
    const m = lookupModule(ctx, { module: IDS.Z });
    if (!m.ok) throw new Error(m.error);
    expect(m.output.tool_hint).toContain("- `ljmp cs:[0x214b]` at module-0005:0003 through ds:[index+6786] goes somewhere the graph cannot name (the previous INT 08h handler");
    expect(m.output.tool_hint).toContain("pass the interrupt on to the original or platform handler");
  });
  test("module gives the same advice and does not count the unresolved target as a callee to do first", () => {
    ctx = withDispatcher();
    const m = lookupModule(ctx, { module: IDS.Z });
    if (!m.ok) throw new Error(m.error);
    expect(m.output.tool_hint).toContain("goes somewhere the graph cannot name (the call site could not be traced to a function): implement each such call as a lookup");
    expect(m.output.tool_hint).not.toContain("Understand what it depends on first");
    expect(m.output.tool_hint).not.toContain("Callees reached `through`");
    const u = lookupModule(ctx, { module: "unknown:module-0005:0003" });
    if (!u.ok) throw new Error(u.error);
    expect(u.output.summary).toBe("unknown:module-0005:0003 is an unresolved transfer target: the call site could not be traced to a function.");
  });
  test("module names what a call went through, provisional functions and their evidence", () => {
    const g = graphJson();
    ctx = {
      ...ctx,
      graph: new CallGraph({
        ...g,
        nodes: { ...g.nodes, [IDS.Z]: { ...g.nodes[IDS.Z]!, provisional: true, evidence: ["far pointer 0000h:0030 built at A, stored into field +10h of a record at B"] } },
        edges: [...g.edges, { source: IDS.D, target: IDS.Z, instruction: "lcall es:[di + 0x10]", instruction_offset: "module-0004:0003", returns: true, conditions: [], through: "field +10h of a record", provisional: true }],
      }),
    };
    const z = lookupModule(ctx, { module: IDS.Z });
    if (!z.ok) throw new Error(z.error);
    expect(z.output.summary).toContain("Provisional: no call or jump to it is proven");
    expect(z.output.summary).toContain("\nEvidence:\n- far pointer 0000h:0030 built at A, stored into field +10h of a record at B");
    expect(z.output.callers).toContain("`lcall es:[di + 0x10]` at module-0004:0003 through field +10h of a record (possible target: only the record field offset matches)");
    const d = lookupModule(ctx, { module: IDS.D });
    if (!d.ok) throw new Error(d.error);
    expect(d.output.tool_hint).toContain("Callees reached `through` a variable or table are the procedures the program stores there");
  });
});

describe("calls through stored pointers", () => {
  const SITE = "module-0005:0003";
  const stored = (source: string, target: string, site = SITE, more: object = {}) => ({ source, target, instruction: "lcall [di + 0x1200]", instruction_offset: site, returns: true, conditions: [], through: "ds:[index+1200]", ...more });
  const direct = (source: string, target: string, site: string) => ({ source, target, instruction: "lcall 0x2000, 0x1", instruction_offset: site, returns: true, conditions: [] });
  /** The fixture graph plus `edges`, and nodes `added` (id -> kind) shaped like Z. */
  const withEdges = (edges: object[], added: Record<string, string> = {}): Context => {
    const g = graphJson();
    const nodes = Object.fromEntries(Object.entries(added).map(([id, kind]) => [id, { ...g.nodes[IDS.Z]!, id, kind, listing: null }]));
    return { ...ctx, graph: new CallGraph({ ...g, nodes: { ...g.nodes, ...nodes }, edges: [...g.edges, ...edges] as typeof g.edges }) };
  };
  const module = (id: string) => {
    const m = lookupModule(ctx, { module: id });
    if (!m.ok) throw new Error(m.error);
    return m.output;
  };
  const NAMED = "Called through stored pointers";
  const HINT = "It is called through a stored pointer";

  test("next_work waits on a target that can be written first and names one that cannot", () => {
    // Z (called by R2 and C) dispatches to D, a leaf, and to C, whose work unit waits on Z
    ctx = withEdges([direct(IDS.R2, IDS.Z, "MAIN-root:0108"), direct(IDS.C, IDS.Z, "module-0002:0036"), stored(IDS.Z, IDS.C), stored(IDS.Z, IDS.D)]);
    const back = "It also calls 1 procedure through stored pointers that cannot be written first: their work units depend on this one";
    const o = ok({ module: IDS.Z });
    expect(o.summary).toContain("Waiting on 1 of 1 work unit it calls (readiness 0%)");
    expect(o.summary).toContain(`${back} (1 not implemented yet: ${IDS.C}). Call them through the pointer, never by name; one that is missing must fail visibly.`);
    expect(o.dependencies).toContain(`- ${W.D} (incomplete) — calls ${IDS.D} — `);
    expect(o.dependencies).not.toContain(W.C);
    record([IDS.D]);
    expect(ok({ module: IDS.Z }).summary).toContain("Ready: all 1 work unit it calls are complete.");
    record([IDS.C]);
    expect(ok({ module: IDS.Z }).summary).toContain(`${back} (all implemented).`);
  });
  test("a unit with only such targets is ready but not called dependency-free; three are named, a fourth is behind module", () => {
    const targets = ["module-0006:0001", "module-0006:0002", "module-0006:0003", "module-0006:0004"];
    const around = (ids: string[]) => withEdges(ids.flatMap((t, i) => [direct(t, IDS.Z, `module-0006:010${i}`), stored(IDS.Z, t)]), Object.fromEntries(ids.map((t) => [t, "function"])));
    ctx = around(targets.slice(0, 3));
    const three = ok({ module: IDS.Z }).summary;
    expect(three).toContain("Ready: it calls nothing else outside itself");
    expect(three).toContain(`It also calls 3 procedures through stored pointers that cannot be written first: their work units depend on this one (3 not implemented yet: ${targets.slice(0, 3).join(", ")}).`);
    ctx = around(targets);
    expect(ok({ module: IDS.Z }).summary).toContain(`(4 not implemented yet: ${targets.slice(0, 3).join(", ")}, … (\`module\` marks every callee)).`);
  });
  test("a function called through a stored pointer is told to register itself, by next_work and by module", () => {
    expect(ok({ module: IDS.D }).next_steps).not.toContain(NAMED);
    expect(module(IDS.D).tool_hint).not.toContain(HINT);
    ctx = withEdges([stored(IDS.Z, IDS.D)]);
    expect(ok({ module: IDS.D }).next_steps).toContain(
      `\n   ${NAMED}: ${IDS.D}. For each: no call names it, so register it in your table of function pointers under every address the program stores for it (the Evidence lines of \`module\` name each store); a missing entry fails only when that path runs, so test a path that goes through the pointer.\n3. `,
    );
    expect(module(IDS.D).tool_hint).toContain(`- ${HINT} (\`lcall [di + 0x1200]\` at ${SITE} through ds:[index+1200]): no call names it, so register it in your table of function pointers`);
    ctx = withEdges([stored(IDS.Z, IDS.D), stored(IDS.R2, IDS.D, "MAIN-root:0108")]);
    expect(module(IDS.D).tool_hint).toContain(`at ${SITE} through ds:[index+1200], and 1 more): no call names it`);
  });
  test("not for a link from another program, nor for a member that is no function", () => {
    ctx = withEdges([stored(IDS.Z, IDS.D, SITE, { link: "interrupt" })]);
    expect(ok({ module: IDS.D }).next_steps).not.toContain(NAMED);
    expect(module(IDS.D).tool_hint).not.toContain(HINT);
    const address = "module-0005:0099";
    ctx = withEdges([stored(IDS.Z, address)], { [address]: "address" });
    expect(ok({ module: IDS.Z }).members).toContain(`- ${address} — `);
    expect(ok({ module: IDS.Z }).next_steps).not.toContain(NAMED);
    expect(module(address).tool_hint).not.toContain(HINT);
  });
});

describe("next_work picks the top-ranked unit", () => {
  test("ready unit that unblocks the most comes first, with its whole story", () => {
    const o = ok({});
    expect(o.work_unit).toBe(W.D);
    expect(o.summary).toContain("Next in the queue (#1 of 6)");
    expect(o.summary).toContain("Ready: it calls nothing outside itself");
    expect(o.summary).toContain("unblocks 2 other incomplete work units");
    expect(o.summary).not.toContain("oversized");
    expect(o.members).toContain(`${IDS.D} (entry) — 0 lines — to do — disasm://disassembly/module/${encodeURIComponent(IDS.D)}`);
    expect(o.dependencies).toBe("None: it calls nothing outside itself.");
    expect(o.next_steps).toContain(`/* Implements: ${W.D} */`);
    expect(o.next_steps).toContain(`add_implementation with tree "disassembly", module "${W.D}"`);
    expect(o.next_steps).not.toContain("stub");
    expect(o.queue).toBe("6 incomplete work units of 6 remain. Ranked queue with sizes and readiness: disasm://disassembly/work-plan");
    expect(renderNextWorkText(o)).toContain(`# ${W.D}`);
  });
  test("skip passes over units by id, case-insensitively, or by any member node", () => {
    expect(ok({ skip: [W.D] }).work_unit).toBe(W.Z);
    const two = ok({ skip: [" WORK:module-0002:0040 ", W.Z] });
    expect(two.work_unit).toBe(W.C);
    expect(two.queue).toContain("(2 skipped this call)");
    expect(ok({ skip: [IDS.D] }).work_unit).toBe(W.Z);
    expect(ok({ skip: [W.D, W.D] }).queue).toContain("(1 skipped");
    expect(ok({ skip: [] }).work_unit).toBe(W.D);
  });
  test("a waiting unit lists the incomplete units it calls and says to stub them", () => {
    const o = ok({ skip: [W.D, W.Z] });
    expect(o.summary).toContain("Waiting on 1 of 1 work unit it calls (readiness 0%)");
    expect(o.dependencies).toContain(`- ${W.D} (incomplete) — calls ${IDS.D} — disasm://disassembly/work-unit/${encodeURIComponent(W.D)}`);
    expect(o.next_steps).toContain("stub");
    // the address-only node is a member, described as part of its caller
    expect(o.members).toContain(`${IDS.ADDR} — 0 lines — address node`);
  });
  test("every unit skipped", () => {
    const o = ok({ skip: Object.values(W) });
    expect(o.work_unit).toBe("none");
    expect(o.summary).toBe("All 6 incomplete work units are in `skip`.");
    expect(o.next_steps).toContain("fewer ids");
  });
});

describe("next_work with module", () => {
  test("any member, a far call or the unit id returns that unit; members are callees first", () => {
    for (const module of [IDS.B, "0016:0020", W.R, "module-0001:0010"]) {
      const o = ok({ module });
      expect(o.work_unit).toBe(W.R);
      expect(o.summary).toContain(`The work unit containing ${module}`);
    }
    const o = ok({ module: IDS.R });
    const at = (id: string) => o.members.indexOf(`- ${id}`);
    expect(at(IDS.B)).toBeGreaterThan(0);
    expect(at(IDS.B)).toBeLessThan(at(IDS.A));
    expect(at(IDS.A)).toBeLessThan(at(IDS.R));
    expect(o.members.startsWith("3 members, all implemented together in one source file, callees first:")).toBe(true);
    expect(o.dependencies).toContain(`${W.C} (incomplete) — calls ${IDS.C}`);
  });
  test("module wins over skip", () => {
    expect(ok({ module: IDS.D, skip: [W.D] }).work_unit).toBe(W.D);
  });
  test("a complete unit says so", () => {
    record([IDS.D]);
    const o = ok({ module: IDS.D });
    expect(o.summary).toContain("Already complete");
    expect(o.summary).not.toContain("#");
    expect(o.next_steps).toContain("Nothing to do here");
  });
  test.each([
    [{ module: "nope" }, 'module: "nope" is not a node name or an address'],
    [{ module: "" }, "module: empty"],
    [{ module: "   " }, "module: empty"],
    [{ module: "work:" }, 'module: "work:" is not a node name or an address'],
    [{ module: "work:   " }, 'module: "work:" is not a node name or an address'],
    [{ module: `work:${IDS.A}` }, `there is no work unit work:${IDS.A}; ${IDS.A} is part of ${W.R}`],
    [{ module: "work:module-0009:0001" }, "No graph node"],
    [{ skip: ["work:nope"] }, 'skip[0]: "nope" is not a node name or an address'],
    [{ skip: [W.D, ""] }, "skip[1]: empty"],
    [{ skip: ["0016:9999"] }, 'skip[0]: "0016:9999" does not match how any listing'],
  ])("rejects %j", (args, fragment) => {
    expect(fails(args)).toContain(fragment);
  });
  test("every bad entry is reported at once", () => {
    expect(fails({ module: "nope", skip: ["x", "y"] }).split("\n")).toHaveLength(3);
  });
});

describe("progress reshuffles the plan immediately", () => {
  test("finishing D makes C (which unblocks two) next; finishing everything ends the queue", () => {
    expect(ok({}).work_unit).toBe(W.D);
    record([IDS.D]);
    const next = ok({});
    expect(next.work_unit).toBe(W.C);
    expect(next.summary).toContain("Ready: all 1 work unit it calls are complete.");
    expect(next.dependencies).toContain(`${W.D} (complete)`);
    record(FUNCTIONS);
    const done = ok({});
    expect(done.work_unit).toBe("none");
    expect(done.summary).toBe("All 6 work units are complete: every function in the call graph is implemented.");
    expect(done.queue).toContain("0 incomplete work units of 6 remain");
    expect(renderWorkPlan(ctx)).toContain("Nothing left: every work unit is complete.");
  });
  test("the plan is memoized until progress changes", () => {
    const a = getWorkPlan(ctx);
    expect(getWorkPlan(ctx)).toBe(a);
    record([IDS.Z]);
    expect(getWorkPlan(ctx)).not.toBe(a);
    expect(getWorkPlan({ ...ctx, workOptions: { budgetLines: 600, trivialLines: 20 } })).toBe(getWorkPlan(ctx));
    expect(getWorkPlan({ ...ctx, workOptions: { budgetLines: 601, trivialLines: 20 } })).not.toBe(getWorkPlan(ctx));
  });
});

describe("oversized units", () => {
  const listing = (lines: number) => writeFileSync(path.join(fx.disassembly, "units", "play", "functions", "module-0002_0040.asm"), "0040  90  nop\n\n".repeat(lines));
  test("over budget warns; exactly at budget does not", () => {
    listing(5);
    ctx.workOptions = { budgetLines: 4, trivialLines: 2 };
    const over = ok({ module: IDS.D });
    expect(over.summary).toContain("Warning: oversized. 5 lines is over the 4-line budget");
    expect(over.members).toContain(`${IDS.D} (entry) — 5 lines`);
    const m = lookupModule(ctx, { module: IDS.D });
    if (!m.ok) throw new Error(m.error);
    expect(m.output.implementation_status).toContain(`Work unit: ${W.D} (1 member, 5 lines, ready, oversized)`);
    ctx.workOptions = { budgetLines: 5, trivialLines: 2 };
    expect(ok({ module: IDS.D }).summary).not.toContain("oversized");
  });
});

describe("module shows the work unit", () => {
  const status = (id: string) => {
    const m = lookupModule(ctx, { module: id });
    if (!m.ok) throw new Error(m.error);
    return m.output.implementation_status;
  };
  test("one line with size, state and link", () => {
    expect(status(IDS.D)).toContain(`\nWork unit: ${W.D} (1 member, 0 lines, ready) — disasm://disassembly/work-unit/${encodeURIComponent(W.D)}`);
    expect(status(IDS.A)).toContain(`Work unit: ${W.R} (3 members, 6 lines, waiting on 1 unit)`); // A's 6-line listing; R and B have none
    expect(status(IDS.ADDR)).toContain(`Work unit: ${W.C} (2 members`);
    record([IDS.D]);
    expect(status(IDS.D)).toContain(`Work unit: ${W.D} (1 member, 0 lines, complete)`);
    expect(status(IDS.C)).toContain(", ready)");
    expect(status(IDS.D).split("\n").filter((l) => l.startsWith("Work unit:"))).toHaveLength(1);
  });
});

describe("work plan resources", () => {
  test("disasm://work-plan ranks the queue", () => {
    const text = renderWorkPlan(ctx);
    expect(text).toContain("6 work units: 0 complete, 6 to do (0 oversized)");
    expect(text).toContain(`| 1 | [${W.D}](disasm://disassembly/work-unit/${encodeURIComponent(W.D)}) | 1 | 0 | 100% | 2 | ready |`);
    expect(text).toContain(`| 2 | [${W.Z}]`);
    expect(text).not.toContain("more incomplete units");
  });
  test("disasm://work-unit shows members, dependencies and callers in full", () => {
    const c = renderWorkUnit(ctx, W.C);
    expect(c).toContain(`# ${W.C}`);
    expect(c).toContain(`- ${W.R} (waiting on 1 unit)`);
    expect(c).toContain(`- ${W.R2} (waiting on 1 unit)`);
    expect(c).toContain(`${W.D} (incomplete) — calls ${IDS.D}`);
    expect(renderWorkUnit(ctx, W.R)).toContain("No other work unit calls into it.");
    expect(renderWorkUnit(ctx, IDS.B)).toContain(`# ${W.R}`);
    expect(() => renderWorkUnit(ctx, "work:nope")).toThrow(/No graph node/);
    expect(() => renderWorkUnit(ctx, "")).toThrow(/empty/);
  });
});
