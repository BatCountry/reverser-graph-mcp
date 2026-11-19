import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { TtlCache } from "../src/cache.js";
import { fingerprintUnit } from "../src/compare/fingerprint.js";
import { moduleDetail } from "../src/dashboard/api.js";
import { siteText } from "../src/graph/indirect.js";
import { annotateCallTargets, CALL_TARGET_HEADER, LINK_TARGET_HEADER } from "../src/graph/listing-targets.js";
import { CallGraph, type GraphEdge, type GraphNode } from "../src/graph/model.js";
import { lookupModule, lookupTrace, type Context } from "../src/graph/tools.js";
import { getWorkPlan } from "../src/graph/workplan-cache.js";
import { buildWorkPlan } from "../src/graph/workunits.js";
import { ProgressStore } from "../src/progress/store.js";
import { tempRoot, writeTree, type Fn } from "./trees.js";

// A multi-program game: RUN.BAT runs LOADER (which copies the FM driver to DRV.EXE), DRV (not in the directory) and
// MENU; MENU's exec helper runs PLAY and VIDEO; its PLAY raises INT 66h, answered by whichever sound driver
// is resident (PCMDRV's handler known only from its hook record).
const FNS: Record<string, Fn> = {
  LOADER: { at: 0x0, space: "LOADER_EXE", file: "LOADER.EXE", code: ["mov dx, 0x10", "int 0x21", "ret"] },
  MENU: { at: 0x0, space: "MENU_EXE", file: "MENU.EXE", code: ["call {EXEC}", "ret"] },
  EXEC: { at: 0x38, space: "MENU_EXE", file: "MENU.EXE", code: ["mov ax, 0x4b00", "int 0x21", "ret"] },
  MAIN: { at: 0x0, space: "PLAY_EXE", file: "PLAY.EXE", code: ["call {PLAY}", "call {HELP}", "ret"] },
  PLAY: { at: 0x1230, space: "PLAY_EXE", file: "PLAY.EXE", code: ["mov ah, 1", "int 0x66", "call {HELP}", "ret"] },
  HELP: { at: 0x1300, space: "PLAY_EXE", file: "PLAY.EXE", code: ["mov ax, 2", "ret"] },
  VIDEO: { at: 0x0, space: "VIDEO_EXE", file: "VIDEO.EXE", code: ["ret"] },
  FMDRV: { at: 0x0, space: "FMDRV_EXE", file: "FMDRV.EXE", code: ["mov ax, 0x2566", "int 0x21", "ret"] },
  FMDRV_INT: { at: 0x47c, space: "FMDRV_EXE", file: "FMDRV.EXE", code: ["push ax", "iret"] },
  SB: { at: 0x0, space: "PCMDRV_EXE", file: "PCMDRV.EXE", code: ["mov ax, 0x2566", "int 0x21", "ret"] },
  SB_INT: { at: 0x300, space: "PCMDRV_EXE", file: "PCMDRV.EXE", code: ["push bx", "iret"] },
};

const BAT = "RUN_BAT:0000";
const DRV = "unknown:RUN_BAT:0002";
const PLAY = "PLAY_EXE:1230";
const HELP = "PLAY_EXE:1300";
const DRV_REASON = "no DRV.COM / DRV.EXE / DRV.BAT in the program directory: LOADER.EXE names it (made at run time)";
const INT66 = "INT 66h, handled by FMDRV.EXE once it is resident (hook record [03c1]; stays resident at FMDRV_EXE:047c); 2 resident programs install it: the one the player runs";
const EXEC_GAME = "the string play.exe built at MENU_EXE:0154; MENU_EXE:0038 reaches DOS exec (INT 21h/4Bh)";
const BATCH_LISTING = ["0001                loader", "0002                if exist drv.exe drv", "0003                menu"].join("\n");

const link = (source: string, target: string, instruction: string, at: string, how: string, through: string, extra: object = {}) =>
  ({ source, target, instruction, instruction_offset: at, returns: true, conditions: [], link: how, through, ...extra });

let root: string;
let graph: CallGraph;
let ctx: Context;
beforeAll(() => {
  root = tempRoot("rpg-links-");
  writeTree(root, FNS, {
    [BAT]: { id: BAT, kind: "function", space: "RUN_BAT", address: 0, file_offset: 0, source_file: "RUN.BAT", listing: "units/main/functions/RUN_BAT_0000.asm", entrypoint: true },
    [DRV]: { id: DRV, kind: "unknown-target", space: null, address: null, file_offset: null, source_file: null, listing: null, entrypoint: false, reason: DRV_REASON },
  }, Object.fromEntries(["RUN.BAT", "LOADER.EXE", "MENU.EXE", "PLAY.EXE", "VIDEO.EXE", "FMDRV.EXE", "PCMDRV.EXE"].map((f) => [f, [f]])));
  writeFileSync(path.join(root, "units", "main", "functions", "RUN_BAT_0000.asm"), `${BATCH_LISTING}\n`);
  const file = path.join(root, "navigation", "callgraph.json");
  const json = JSON.parse(readFileSync(file, "utf8"));
  json.edges.push(
    link(BAT, "LOADER_EXE:0000", "loader", "RUN_BAT:0001", "runs", "batch file line"),
    link(BAT, DRV, "if exist drv.exe drv", "RUN_BAT:0002", "runs", "batch file line", { conditions: [{ direction: "taken", expression: "if exist drv.exe", offset: "RUN_BAT:0002" }] }),
    link(BAT, "MENU_EXE:0000", "menu", "RUN_BAT:0003", "runs", "batch file line"),
    link("LOADER_EXE:0000", "FMDRV_EXE:0000", "int 0x21", "LOADER_EXE:0002", "loads", "copies fmdrv.exe to drv.exe"),
    link("MENU_EXE:0038", "PLAY_EXE:0000", "int 0x21", "MENU_EXE:003a", "runs", EXEC_GAME),
    link("MENU_EXE:0038", "VIDEO_EXE:0000", "int 0x21", "MENU_EXE:003a", "runs", "the string video.exe built at MENU_EXE:0154"),
    link(PLAY, "FMDRV_EXE:047c", "int 0x66", "PLAY_EXE:1232", "interrupt", INT66),
    link(PLAY, "PCMDRV_EXE:0300", "int 0x66", "PLAY_EXE:1232", "interrupt", "INT 66h, handled by PCMDRV.EXE once it is resident", { provisional: true }),
  );
  writeFileSync(file, JSON.stringify(json));
  graph = CallGraph.load(root);
  ctx = { graph, disassemblyRoot: root, progress: new ProgressStore(path.join(root, "progress.json")), cache: new TtlCache() };
});

const module = (id: string) => {
  const r = lookupModule(ctx, { module: id });
  if (!r.ok) throw new Error(r.error);
  return r.output;
};

describe("module", () => {
  test("the int site function lists each driver's handler as an interrupt link with its explanation, apart from its real callee", () => {
    const o = module(PLAY);
    expect(o.callees).toContain(`- FMDRV_EXE:047c — \`int 0x66\` at PLAY_EXE:1232 calls into another program (interrupt): ${INT66} — `);
    expect(o.callees).toContain("- PCMDRV_EXE:0300 — `int 0x66` at PLAY_EXE:1232 calls into another program (interrupt): INT 66h, handled by PCMDRV.EXE once it is resident (possible handler: known only from a hook record) — ");
    expect(o.callees).toContain(`- ${HELP} — \`call 0x1300\` at PLAY_EXE:1234 — `);
    expect(o.tool_hint).toContain("- Understand what it depends on first: the 1 callee(s) above that are not links to other programs;");
    expect(o.tool_hint).toContain("- 2 callee(s) are other programs it reaches by a link (interrupt): each is a boundary to another program, not a function to call or inline");
    expect(o.tool_hint).not.toContain("through a pointer");
  });
  test("the int site's work unit waits on its real callee only, never on the drivers", () => {
    const plan = getWorkPlan(ctx);
    const unit = plan.units.get(plan.unitOf.get(PLAY)!)!;
    expect(unit.id).toBe("work:PLAY_EXE:0000");
    expect(unit.members).toEqual(["PLAY_EXE:0000", PLAY]);
    expect(unit.dependsOn).toEqual([`work:${HELP}`]);
    expect(unit.externalCallees).toEqual([HELP]);
    expect(module(PLAY).implementation_status).toContain("work:PLAY_EXE:0000 (2 members, 9 lines, waiting on 1 unit)");
    // each program, and the batch file, roots units of its own; the missing DRV is in none
    for (const id of ["FMDRV_EXE:047c", "PCMDRV_EXE:0300", "FMDRV_EXE:0000", "MENU_EXE:0000", "VIDEO_EXE:0000", BAT]) expect(plan.unitOf.get(id)).toBe(`work:${id}`);
    expect(plan.unitOf.get(DRV)).toBeUndefined();
    expect(plan.units.get(`work:${BAT}`)).toMatchObject({ members: [BAT], dependsOn: [], indirectCalls: [] });
  });
  test("a driver's handler names the program that raises its interrupt as a link caller", () => {
    const o = module("FMDRV_EXE:047c");
    expect(o.callers).toContain(`- ${PLAY} — \`int 0x66\` at PLAY_EXE:1232 calls into another program (interrupt): ${INT66} — `);
    expect(o.tool_hint).toContain("- 1 caller(s) are other programs reaching it by a link (they run it, read its file, or raise an interrupt it answers)");
  });
  test("a batch file: each line runs a program; a command missing from the directory says why, with no pointer-table advice", () => {
    const o = module(BAT);
    expect(o.summary).toContain("Batch file RUN.BAT (RUN_BAT:0000)");
    expect(o.callees).toContain("- MENU_EXE:0000 — `menu` at RUN_BAT:0003 runs another program: batch file line — ");
    expect(o.tool_hint).not.toContain("Understand what it depends on first");
    expect(o.tool_hint).toContain("- 3 callee(s) are other programs it reaches by a link (runs):");
    expect(o.tool_hint).toContain(`- \`if exist drv.exe drv\` at RUN_BAT:0002 runs another program: batch file line, but that program is not in this tree: ${DRV_REASON}.`);
    expect(o.tool_hint).not.toContain("function pointers");
    expect(o.entrypoint_traces).toContain("itself an entrypoint");
  });
  test("a file another program reads is labelled as read, not called", () => {
    expect(module("FMDRV_EXE:0000").callers).toContain("- LOADER_EXE:0000 — `int 0x21` at LOADER_EXE:0002 reads another program's file: copies fmdrv.exe to drv.exe — ");
  });
  test("entrypoint traces start at the batch file and mark every link hop", () => {
    const o = module(HELP);
    expect(o.entrypoint_traces).toContain(`- ${BAT} →[runs] MENU_EXE:0000 → MENU_EXE:0038 →[runs] PLAY_EXE:0000 → ${HELP}`);
    expect(o.entrypoint_traces).toContain("cross into another program");
  });
});

describe("trace", () => {
  test("from the batch file across the launcher into a game function, each link hop labelled", () => {
    const r = lookupTrace(ctx, { from: BAT, to: HELP });
    if (!r.ok) throw new Error(r.error);
    const lines = r.output.shortest_path.split("\n");
    expect(lines).toEqual([
      `${BAT} →[runs] MENU_EXE:0000 → MENU_EXE:0038 →[runs] PLAY_EXE:0000 → ${HELP}`,
      `1. ${BAT} → MENU_EXE:0000: \`menu\` at RUN_BAT:0003 runs another program: batch file line`,
      "2. MENU_EXE:0000 → MENU_EXE:0038: `call 0x38` at MENU_EXE:0000",
      `3. MENU_EXE:0038 → PLAY_EXE:0000: \`int 0x21\` at MENU_EXE:003a runs another program: ${EXEC_GAME}`,
      `4. PLAY_EXE:0000 → ${HELP}: \`call 0x1300\` at PLAY_EXE:0002`,
    ]);
    expect(r.output.tool_hint).toContain("cross into another program");
  });
  test("a path of calls only carries no link note", () => {
    const r = lookupTrace(ctx, { from: "PLAY_EXE:0000", to: HELP });
    if (!r.ok) throw new Error(r.error);
    expect(r.output.shortest_path).toContain(`PLAY_EXE:0000 → ${HELP}`);
    expect(r.output.tool_hint).not.toContain("cross into another program");
  });
  test("the interrupt link is followed to the driver too", () => {
    const r = lookupTrace(ctx, { from: BAT, to: "PCMDRV_EXE:0300" });
    if (!r.ok) throw new Error(r.error);
    expect(r.output.shortest_path.split("\n")[0]).toBe(`${BAT} →[runs] MENU_EXE:0000 → MENU_EXE:0038 →[runs] PLAY_EXE:0000 → ${PLAY} →[interrupt] PCMDRV_EXE:0300`);
  });
});

describe("listing annotations", () => {
  const listing = (id: string) => readFileSync(path.join(root, "units", "main", "functions", `${id.replace(":", "_")}.asm`), "utf8").trimEnd();
  const node = (id: string): GraphNode => graph.nodes.get(id)!;
  test("an int line names the drivers' handlers as a link, next to ordinary call arrows", () => {
    const lines = listing(PLAY).split("\n");
    expect(annotateCallTargets(graph, node(PLAY), listing(PLAY)).split("\n")).toEqual([
      CALL_TARGET_HEADER,
      LINK_TARGET_HEADER,
      lines[0],
      lines[1],
      `${lines[2]}\t; ⇒ interrupt answered in another program: FMDRV_EXE:047c, PCMDRV_EXE:0300`,
      `${lines[3]}\t; → ${HELP}`,
      lines[4],
    ]);
  });
  test("batch lines name the program they run; a missing one is not in this tree", () => {
    expect(annotateCallTargets(graph, node(BAT), BATCH_LISTING).split("\n")).toEqual([
      LINK_TARGET_HEADER,
      "0001                loader\t; ⇒ runs another program: LOADER_EXE:0000",
      "0002                if exist drv.exe drv\t; ⇒ runs another program: not in this tree",
      "0003                menu\t; ⇒ runs another program: MENU_EXE:0000",
    ]);
  });
  test("one exec site running two programs; a file read", () => {
    expect(annotateCallTargets(graph, node("MENU_EXE:0038"), "003a  9090          int 0x21")).toBe(`${LINK_TARGET_HEADER}\n003a  9090          int 0x21\t; ⇒ runs another program: PLAY_EXE:0000, VIDEO_EXE:0000`);
    expect(annotateCallTargets(graph, node("LOADER_EXE:0000"), "0002  9090          int 0x21")).toBe(`${LINK_TARGET_HEADER}\n0002  9090          int 0x21\t; ⇒ reads another program's file: FMDRV_EXE:0000`);
  });
  test("a line that is not the link's instruction (listing disagrees with the graph) gets no note", () => {
    expect(annotateCallTargets(graph, node(BAT), "0003                cls")).toBe("0003                cls");
  });
  test("the instruction matches in any case", () => {
    expect(annotateCallTargets(graph, node(BAT), "0003                MENU")).toBe(`${LINK_TARGET_HEADER}\n0003                MENU\t; ⇒ runs another program: MENU_EXE:0000`);
  });
  test("a call and a link on one line: both notes, call first", () => {
    const g = new CallGraph({
      aliases: {},
      nodes: Object.fromEntries(["S:0000", "S:0040", "T:0000"].map((id) => [id, { id, kind: "function", space: id.split(":")[0]!, address: 0, file_offset: 0, source_file: null, listing: null, entrypoint: false }])),
      edges: [
        { source: "S:0000", target: "S:0040", instruction: "call 0x40", instruction_offset: "S:0002", returns: true, conditions: [] },
        { source: "S:0000", target: "T:0000", instruction: "call 0x40", instruction_offset: "S:0002", returns: true, conditions: [], link: "runs" },
      ],
    });
    expect(annotateCallTargets(g, g.nodes.get("S:0000")!, "0002  e83b00      call 0x40")).toBe(`${CALL_TARGET_HEADER}\n${LINK_TARGET_HEADER}\n0002  e83b00      call 0x40\t; → S:0040\t; ⇒ runs another program: T:0000`);
  });
  test("a link with an empty instruction matches no line", () => {
    const g = new CallGraph({
      aliases: {},
      nodes: Object.fromEntries(["S:0000", "T:0000"].map((id) => [id, { id, kind: "function", space: id.split(":")[0]!, address: 0, file_offset: 0, source_file: null, listing: null, entrypoint: false }])),
      edges: [{ source: "S:0000", target: "T:0000", instruction: " ", instruction_offset: "S:0002", returns: true, conditions: [], link: "runs" }],
    });
    expect(annotateCallTargets(g, g.nodes.get("S:0000")!, "0002  90          nop")).toBe("0002  90          nop");
  });
});

describe("dashboard", () => {
  test("sites and trace hops say when they reach another program", () => {
    const r = moduleDetail(ctx, PLAY);
    if (!r.ok) throw new Error(r.error);
    // [reaches another program, only a hook record says so]
    const how = (t: string) => [t.includes("calls into another program (interrupt)"), t.includes("(possible handler: known only from a hook record)")];
    const callees = Object.fromEntries(r.detail.callees.map((n) => [n.id, n.sites.map((s) => how(s.text))]));
    expect(callees).toEqual({ "FMDRV_EXE:047c": [[true, false]], "PCMDRV_EXE:0300": [[true, true]], [HELP]: [[false, false]] });
    const h = moduleDetail(ctx, HELP);
    if (!h.ok) throw new Error(h.error);
    expect(h.detail.traces.shown.map((t) => [t.entry, t.hops.map((x) => x.text.includes("runs another program"))])).toEqual([[BAT, [true, false, true, false]]]);
  });
});

describe("compare fingerprints", () => {
  test("a unit's externals are its callees, not the programs it links to", () => {
    const plan = getWorkPlan(ctx);
    const print = fingerprintUnit(root, graph, plan.units.get("work:PLAY_EXE:0000")!);
    expect(print.externals).toEqual([HELP]);
  });
});

describe("untrusted link values", () => {
  const fn = (id: string): GraphNode => ({ id, kind: "function", space: "m", address: 0, file_offset: 0, source_file: null, listing: null, entrypoint: false });
  // R reaches T through the edge under test; X calls T too, so T roots its own unit
  const graphWith = (edge: object) =>
    new CallGraph({
      aliases: {},
      nodes: Object.fromEntries(["R", "T", "X"].map((id) => [id, fn(id)])),
      edges: [{ source: "R", target: "T", instruction: "int 0x66", instruction_offset: "m:0002", returns: true, conditions: [], ...edge } as GraphEdge, { source: "X", target: "T", instruction: "call 0x0", instruction_offset: "m:0010", returns: true, conditions: [] }],
    });
  const dependsOn = (g: CallGraph) => buildWorkPlan(g, new Set(), () => 10).units.get("work:R")!.dependsOn;

  test.each([[7], ["calls"], [null], [""], ["RUNS"], [" runs"], [{}], [["runs"]], [true], ["__proto__"], ["toString"], [Number.NaN]])("link %j is dropped: the edge is a plain call", (bad) => {
    const g = graphWith({ link: bad });
    const e = g.edges[0]!;
    expect("link" in e).toBe(false);
    expect(e).toMatchObject({ source: "R", target: "T", instruction: "int 0x66" });
    expect(siteText(e)).toBe("`int 0x66` at m:0002");
    expect(dependsOn(g)).toEqual(["work:T"]);
    expect(g.out.get("R")).toEqual([e]);
  });
  test("no link at all: a plain call", () => {
    const g = graphWith({});
    expect(dependsOn(g)).toEqual(["work:T"]);
    expect(siteText(g.edges[0]!)).toBe("`int 0x66` at m:0002");
  });
  test.each([
    ["runs", "`int 0x66` at m:0002 runs another program"],
    ["loads", "`int 0x66` at m:0002 reads another program's file"],
    ["interrupt", "`int 0x66` at m:0002 calls into another program (interrupt)"],
  ])("link %s is kept and is no dependency", (how, text) => {
    const g = graphWith({ link: how });
    expect(g.edges[0]!.link).toBe(how);
    expect(siteText(g.edges[0]!)).toBe(text);
    expect(dependsOn(g)).toEqual([]);
  });
  test.each([
    ["interrupt", " (possible handler: known only from a hook record)"],
    ["runs", " (possible: not proven)"],
  ])("a provisional %s link says it is not proven", (how, suffix) => {
    expect(siteText(graphWith({ link: how, provisional: true, through: "why" }).edges[0]!)).toBe(`\`int 0x66\` at m:0002 ${how === "runs" ? "runs another program" : "calls into another program (interrupt)"}: why${suffix}`);
  });
  test("through on a plain edge still reads as the pointer it went through; an empty through is left out", () => {
    expect(siteText(graphWith({ through: "ds:[6a78]" }).edges[0]!)).toBe("`int 0x66` at m:0002 through ds:[6a78]");
    expect(siteText(graphWith({ link: "runs", through: "" }).edges[0]!)).toBe("`int 0x66` at m:0002 runs another program");
  });
});
