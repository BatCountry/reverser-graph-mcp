import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, test } from "vitest";
import { TtlCache } from "../src/cache.js";
import { CallGraph } from "../src/graph/model.js";
import { findSameCode } from "../src/graph/samecode.js";
import { lookupModule, type Context } from "../src/graph/tools.js";
import { getSameCode, getWorkPlan } from "../src/graph/workplan-cache.js";
import { ProgressStore } from "../src/progress/store.js";
import { addImplementation, type ProgressContext } from "../src/progress/tools.js";
import { nextWork } from "../src/tools/next_work.js";
import { moduleDetail, moduleRows, summary, unitRows } from "../src/dashboard/api.js";
import { fnId, tempRoot, writeTree, type Fn } from "./trees.js";

// Three programs of one game, each linking its own copy of some runtime routines.
const S = (at: number, code: string[]): Fn => ({ at, code, space: "MAIN_EXE", file: "MAIN.EXE" });
const C = (at: number, code: string[]): Fn => ({ at, code, space: "TRANSFER_EXE", file: "TRANSFER.EXE" });
const T = (at: number, code: string[]): Fn => ({ at, code, space: "TOOL_EXE", file: "TOOL.EXE" });
const PROGRAMS = { "MAIN.EXE": ["MAIN.EXE"], "TRANSFER.EXE": ["TRANSFER.EXE"], "TOOL.EXE": ["TOOL.EXE"] };

const FNS: Record<string, Fn> = {
  // runtime routine and its helper, copied into MAIN and TRANSFER; each copy keeps its variable at its own address
  S_R: S(0x100, ["push bp", "call {S_H}", "mov ax, [0x10]", "pop bp", "ret"]),
  S_H: S(0x120, ["mov cx, 7", "ret"]),
  C_R: C(0x300, ["push bp", "call {C_H}", "mov ax, [0x24]", "pop bp", "ret"]),
  C_H: C(0x320, ["mov cx, 7", "ret"]),
  C_MAIN: C(0x10, ["mov si, 9", "call {C_R}", "ret"]),
  // equal-looking wrappers around different callees
  S_W: S(0x140, ["push bp", "call {S_H}", "pop bp", "retf"]),
  C_W: C(0x340, ["push bp", "call {C_X}", "pop bp", "retf"]),
  C_X: C(0x360, ["mov cx, 8", "ret"]),
  // three programs
  S_Z: S(0x160, ["mov dx, 3", "shl dx, 1", "ret"]),
  C_Z: C(0x380, ["mov dx, 3", "shl dx, 1", "ret"]),
  T_Z: T(0x500, ["mov dx, 3", "shl dx, 1", "ret"]),
  // two copies inside one program, same variable
  S_G1: S(0x180, ["mov bx, [0x30]", "inc bx", "ret"]),
  S_G2: S(0x1a0, ["mov bx, [0x30]", "inc bx", "ret"]),
  // one program, two variables: different functions; a third copy elsewhere cannot tell which it is
  S_D1: S(0x1c0, ["mov bx, [0x40]", "dec bx", "ret"]),
  S_D2: S(0x1e0, ["mov bx, [0x50]", "dec bx", "ret"]),
  C_D: C(0x3a0, ["mov bx, [0x60]", "dec bx", "ret"]),
  // mutually recursive copies
  S_A: S(0x200, ["call {S_B}", "add ax, 1", "ret"]),
  S_B: S(0x220, ["call {S_A}", "add ax, 2", "ret"]),
  C_A: C(0x3c0, ["call {C_B}", "add ax, 1", "ret"]),
  C_B: C(0x3e0, ["call {C_A}", "add ax, 2", "ret"]),
};
const id = (name: string) => fnId(FNS[name]!.at, FNS[name]!.space);
const ids = (...names: string[]) => names.map(id).sort();

let root: string;
let ctx: Context;
const load = () => {
  const graph = CallGraph.load(root);
  ctx = { graph, disassemblyRoot: root, progress: new ProgressStore(path.join(root, "progress.json")), cache: new TtlCache() };
};
beforeEach(() => {
  root = writeTree(tempRoot("rpg-same-"), FNS, {}, PROGRAMS);
  load();
});
const groups = () => findSameCode(root, ctx.graph).groups;

describe("same-code groups", () => {
  test("copies in different programs group with their same-code callees; wrappers around different callees do not", () => {
    expect(groups()).toEqual([
      ids("C_A", "S_A"),
      ids("C_B", "S_B"),
      ids("C_H", "S_H"),
      ids("C_R", "S_R"),
      ids("C_Z", "S_Z", "T_Z"),
      ids("S_G1", "S_G2"),
    ].sort((a, b) => (a[0]! < b[0]! ? -1 : 1)));
    const sc = findSameCode(root, ctx.graph);
    expect(sc.peers(id("S_W"))).toEqual([]);
    expect(sc.peers(id("C_W"))).toEqual([]);
    expect(sc.peers(id("C_Z"))).toEqual(ids("S_Z", "T_Z"));
    expect(sc.peers("no-such-node")).toEqual([]);
  });
  test("inside one program different variables keep functions apart, and a copy elsewhere joins neither", () => {
    const sc = findSameCode(root, ctx.graph);
    for (const n of ["S_D1", "S_D2", "C_D"]) expect(sc.peers(id(n))).toEqual([]);
  });
  test("a callee split apart splits its callers in turn", () => {
    // S_H gains a different body: its copies part, so do the routines calling them
    writeTree(root, { ...FNS, S_H: S(0x120, ["mov cx, 9", "ret"]) }, {}, PROGRAMS);
    load();
    const sc = findSameCode(root, ctx.graph);
    expect(sc.peers(id("S_R"))).toEqual([]);
    expect(sc.peers(id("S_H"))).toEqual([]);
  });
  test("a link to another program is no callee", () => {
    const file = path.join(root, "navigation", "callgraph.json");
    const json = JSON.parse(readFileSync(file, "utf8"));
    json.edges.push({ source: id("S_Z"), target: id("C_X"), instruction: "shl dx, 1", instruction_offset: fnId(0x162, "MAIN_EXE"), returns: true, conditions: [], link: "runs" });
    writeFileSync(file, JSON.stringify(json));
    load();
    expect(findSameCode(root, ctx.graph).peers(id("S_Z"))).toEqual(ids("C_Z", "T_Z"));
  });
  test("a member without a readable listing is left out; the rest still group", () => {
    rmSync(path.join(root, "units", "main", "functions", `${id("C_Z").replace(":", "_")}.asm`));
    rmSync(path.join(root, "units", "main", "functions", `${id("T_Z").replace(":", "_")}.asm`));
    mkdirSync(path.join(root, "units", "main", "functions", `${id("T_Z").replace(":", "_")}.asm`));
    rmSync(path.join(root, "units", "main", "functions", `${id("S_G2").replace(":", "_")}.asm`));
    writeFileSync(path.join(root, "units", "main", "functions", `${id("S_G2").replace(":", "_")}.asm`), "; no instructions\n");
    load();
    const sc = findSameCode(root, ctx.graph);
    expect(sc.peers(id("S_Z"))).toEqual([]);
    expect(sc.peers(id("S_G1"))).toEqual([]);
    expect(sc.peers(id("S_R"))).toEqual([id("C_R")]);
  });
  test("nodes with no listing named and non-function nodes are never members", () => {
    const g = new CallGraph({
      aliases: {},
      nodes: {
        "A:0000": { id: "A:0000", kind: "function", space: "A", address: 0, file_offset: 0, source_file: "A.EXE", listing: null, entrypoint: false },
        "B:0000": { id: "B:0000", kind: "function", space: "B", address: 0, file_offset: 0, source_file: "B.EXE", listing: null, entrypoint: false },
        "unknown:A:0002": { id: "unknown:A:0002", kind: "unknown-target", space: null, address: null, file_offset: null, source_file: null, listing: null, entrypoint: false },
      },
      edges: [],
    });
    expect(findSameCode(root, g).groups).toEqual([]);
  });
});

describe("custody", () => {
  const record = (modules: string[]) => ctx.progress.addImplementations(modules.map((module) => ({ module, file: "src/rtl.cpp", function: "rtl" })));
  const module = (name: string) => {
    const r = lookupModule(ctx, { module: id(name) });
    if (!r.ok) throw new Error(r.error);
    return r.output;
  };

  test("before anything is implemented, module lists the same-code peers so the routine is written once", () => {
    expect(module("C_Z").implementation_status).toContain(`Not yet implemented. Same code as ${id("S_Z")}, ${id("T_Z")} (identical instructions, calling the same code): write it once`);
    expect(module("S_W").implementation_status).toContain("Not yet implemented (nothing registered with add_implementation).");
  });

  test("implementing the MAIN copy covers the TRANSFER copy in module, neighbour marks and the work plan", () => {
    expect(getWorkPlan(ctx).unitOf.get(id("C_R"))).toBe(`work:${id("C_MAIN")}`);
    record([id("S_R"), id("S_H")]);
    const o = module("C_R");
    expect(o.implementation_status).toContain(`Same code as ${id("S_R")}; implemented there as rtl in src/rtl.cpp: nothing to write here, call that implementation.`);
    expect(o.tool_hint).not.toContain("record it with add_implementation");
    expect(o.callees).toContain(`- ${id("C_H")} (implemented: same code as ${id("S_H")}) — `);
    expect(module("C_MAIN").callees).toContain(`- ${id("C_R")} (implemented: same code as ${id("S_R")}) — `);
    expect(module("S_R").implementation_status).toContain(`Implemented: rtl in src/rtl.cpp. Same code as ${id("C_R")}: they count as implemented through this record.`);

    const unit = getWorkPlan(ctx).units.get(`work:${id("C_MAIN")}`)!;
    expect(unit.implemented.sort()).toEqual(ids("C_H", "C_R"));
    expect(unit.complete).toBe(false);
    // derived, never written
    expect(ctx.progress.implementedModules()).toEqual(new Set(ids("S_H", "S_R")));
  });

  test("next_work shows covered members as implemented elsewhere and skips units they complete", () => {
    record([id("S_R"), id("S_H")]);
    const out = nextWork(ctx, { module: id("C_MAIN") });
    if (!out.ok) throw new Error(out.error);
    expect(out.output.members).toContain(`- ${id("C_R")} — 6 lines — implemented: same code as ${id("S_R")}, call that implementation — `);
    expect(out.output.members).toContain(`- ${id("C_MAIN")} (entry) — 4 lines — to do — `);
    expect(out.output.next_steps).toContain(`${id("C_R")}, ${id("C_H")}: same code as a function already implemented; call that implementation`);

    // C_Z's unit is complete once S_Z is implemented, and leaves the queue
    record([id("S_Z")]);
    const plan = getWorkPlan(ctx);
    expect(plan.units.get(`work:${id("C_Z")}`)!.complete).toBe(true);
    expect(plan.units.get(`work:${id("T_Z")}`)!.complete).toBe(true);
    expect(plan.ranked.map((u) => u.id)).not.toContain(`work:${id("C_Z")}`);
    const z = nextWork(ctx, { module: id("T_Z") });
    if (!z.ok) throw new Error(z.error);
    expect(z.output.summary).toContain("Already complete");
  });

  test("an unimplemented member with peers is marked in next_work", () => {
    const out = nextWork(ctx, { module: id("C_Z") });
    if (!out.ok) throw new Error(out.error);
    expect(out.output.members).toContain(`to do (same code as ${id("S_Z")}, ${id("T_Z")}: write it once for all of them)`);
  });

  test("a cycle of copies: implementing one side's pair covers the other's", () => {
    record([id("S_A"), id("S_B")]);
    const plan = getWorkPlan(ctx);
    const unit = plan.units.get(plan.unitOf.get(id("C_A"))!)!;
    expect(unit.members.sort()).toEqual(ids("C_A", "C_B"));
    expect(unit.complete).toBe(true);
  });

  test("add_implementation names the same-code peers its record now covers", () => {
    const impl = tempRoot("rpg-same-impl-");
    writeFileSync(path.join(impl, "rtl.cpp"), `/* Implements: ${id("S_Z")} work:${id("S_R")} ${id("S_W")} */\nvoid rtl() {}\n`);
    const pctx: ProgressContext = { tree: "t", graph: ctx.graph, progress: ctx.progress, implementationRoot: impl, workPlan: () => getWorkPlan(ctx), sameCode: () => getSameCode(ctx) };
    const add = (module: string) => addImplementation(pctx, { tree: "t", module, implementation_filename: "rtl.cpp", function_name: "rtl" });
    expect(add(id("S_Z"))).toEqual({ ok: true, message: `Recorded rtl in rtl.cpp as an implementation of ${id("S_Z")} (1 implementation registered for this module). Same code as ${id("T_Z")}, ${id("C_Z")}: implemented through this record too, nothing to write there.` });
    expect(add(`work:${id("S_R")}`)).toEqual({ ok: true, message: `Recorded rtl in rtl.cpp as the implementation of work:${id("S_R")}: 1 function member (1 new, 0 refreshed): ${id("S_R")}. Same code as ${id("C_R")}: implemented through this record too, nothing to write there. Call next_work for what to do next.` });
    expect(add(id("S_W"))).toEqual({ ok: true, message: `Recorded rtl in rtl.cpp as an implementation of ${id("S_W")} (1 implementation registered for this module).` });
  });
});

describe("dashboard", () => {
  const rec = (module: string, at: string) => ctx.progress.addImplementation({ module, file: "src/rtl.cpp", function: "rtl" }, new Date(at));
  const detail = (name: string) => {
    const r = moduleDetail(ctx, id(name));
    if (!r.ok) throw new Error(r.error);
    return r.detail;
  };

  test("a function covered by same code is implemented, naming the peer and its record, everywhere the page shows it", () => {
    rec(id("S_R"), "2026-03-01T10:00:00Z");
    rec(id("S_H"), "2026-03-02T10:00:00Z");
    const rows = new Map(moduleRows(ctx).map((r) => [r.id, r]));
    expect([id("S_R"), id("S_H"), id("C_R"), id("C_H"), id("C_MAIN")].map((m) => [rows.get(m)!.status, rows.get(m)!.sameCodeAs])).toEqual([
      ["implemented", null], ["implemented", null], ["implemented", id("S_R")], ["implemented", id("S_H")], ["ready", null],
    ]);

    const s = summary(ctx);
    expect(s.functions).toMatchObject({ implemented: 4, bySameCode: 2, implementedLines: 18 });
    expect(s.spaces.find((x) => x.space === "TRANSFER_EXE")).toMatchObject({ implemented: 2, implementedLines: 9 });
    // a covered function counts from its peer's first record
    expect(s.timeline).toEqual([{ date: "2026-03-01", implemented: 2 }, { date: "2026-03-02", implemented: 4 }]);
    expect(s.units.complete).toBe(unitRows(ctx).filter((u) => u.state === "complete").length);

    const d = detail("C_R");
    expect(d).toMatchObject({ status: "implemented", sameCode: [id("S_R")], implementations: [], coveredBy: { id: id("S_R"), implementations: [{ module: id("S_R"), file: "src/rtl.cpp", function: "rtl" }] } });
    expect(d.callees.map((n) => [n.id, n.status, n.sameCodeAs])).toEqual([[id("C_H"), "implemented", id("S_H")]]);
    expect(d.callers.map((n) => [n.id, n.status, n.sameCodeAs])).toEqual([[id("C_MAIN"), "ready", null]]);
    expect(d.unit).toMatchObject({ id: `work:${id("C_MAIN")}`, implemented: 2, members: 3, state: "ready" });
    expect(d.unit!.memberList.map((m) => [m.id, m.implemented, m.sameCodeAs])).toEqual([[id("C_MAIN"), false, null], [id("C_R"), true, id("S_R")], [id("C_H"), true, id("S_H")]]);
    expect(detail("S_R")).toMatchObject({ status: "implemented", sameCode: [id("C_R")], coveredBy: null });
  });

  test("an unimplemented function lists its same-code peers; one without peers lists none", () => {
    expect(detail("C_Z")).toMatchObject({ status: "ready", sameCode: ids("S_Z", "T_Z"), coveredBy: null });
    expect(detail("S_W")).toMatchObject({ sameCode: [], coveredBy: null });
    expect(summary(ctx).functions).toMatchObject({ implemented: 0, bySameCode: 0 });
  });
});
