import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { applyCarry, planCarry, type Tree } from "../src/compare/carry.js";
import { copyProgress, USAGE } from "../src/compare/cli.js";
import { Correspondence, pairPrograms } from "../src/compare/correspond.js";
import { fingerprintUnit } from "../src/compare/fingerprint.js";
import { renderCompare, renderCounterpart, renderMap, resolveFunction } from "../src/compare/render.js";
import { counterpartView } from "../src/dashboard/compare.js";
import { progressFileFor } from "../src/config.js";
import { CallGraph } from "../src/graph/model.js";
import { buildWorkPlan, DEFAULT_WORK_UNIT_OPTIONS, listingSize } from "../src/graph/workunits.js";
import { ProgressStore } from "../src/progress/store.js";
import { ALPHA, BETA, fnId, tempRoot, twoGames, writeTree, type Fn } from "./trees.js";

const R = ["push bp", "call {A}", "mov al, byte ptr [0x100]", "mov di, 0x50", "push ds", "push di", "call {S}", "mov sp, bp", "pop bp", "ret"];
const A = ["mov ax, word ptr [0x102]", "cmp ax, word ptr [bp - 6]", "jne @4", "inc ax", "mov word ptr [0x100], ax", "ret"];
const S = ["ret"];
const T = ["call {S}", "cmp al, 5", "ret"];

function trees(over: { dst?: Record<string, Fn>; src?: Record<string, Fn> } = {}) {
  const root = tempRoot("rpg-carry-");
  const source = writeTree(path.join(root, "alpha"), over.src ?? { R: { at: 0x10, code: R }, A: { at: 0x30, code: A }, S: { at: 0x50, code: S }, T: { at: 0x60, code: T } });
  // relocated: every function and global moves; T's constant changes; S2 is a second copy of S
  const shift = (code: string[], k: number) => code.map((l) => l.replace(/\[0x10([02])\]/g, (_m, d: string) => `[0x11${d}]`).replace("mov di, 0x50", `mov di, 0x${(0x50 + k).toString(16)}`));
  const destination = writeTree(path.join(root, "beta"), over.dst ?? {
    R: { at: 0x110, code: shift(R, 0x10) }, A: { at: 0x130, code: shift(A, 0) }, S: { at: 0x150, code: S }, T: { at: 0x160, code: ["call {S}", "cmp al, 6", "ret"] }, S2: { at: 0x180, code: S },
  });
  const progressRoot = path.join(root, "progress");
  return { root, source, destination, progressRoot };
}

function load(dir: string, progressRoot: string): Tree {
  const graph = CallGraph.load(dir);
  return { name: path.basename(dir), disassemblyRoot: dir, graph, plan: buildWorkPlan(graph, new Set(), listingSize(dir, graph)), progress: new ProgressStore(progressFileFor(progressRoot, dir)) };
}

function seed(progressRoot: string, source: string) {
  const store = new ProgressStore(progressFileFor(progressRoot, source));
  store.addImplementations([
    { module: "MAIN-root:0010", file: "src/r.cpp", function: "r" },
    { module: "MAIN-root:0030", file: "src/r.cpp", function: "a" },
    { module: "MAIN-root:0050", file: "src/s.cpp", function: "s" },
    { module: "MAIN-root:0060", file: "src/t.cpp", function: "t" },
  ]);
  store.addAnnotation({ module: "MAIN-root:0030", annotation_type: "functional", description: "bumps the counter", references: [
    { reference_type: "module", reference_content: "MAIN-root:0010" },
    { reference_type: "module", reference_content: "MAIN-root:0060" },
    { reference_type: "freeform", reference_content: "word at DS:0100" },
  ] });
  store.addAnnotation({ module: "MAIN-root:0010", annotation_type: "behavioral", description: "calls S", references: [{ reference_type: "module", reference_content: "MAIN-root:0050" }] });
  return store;
}

describe("planCarry", () => {
  test("relocated identical units receive the source's records, translated; changed units do not", () => {
    const t = trees();
    seed(t.progressRoot, t.source);
    const plan = planCarry(load(t.source, t.progressRoot), load(t.destination, t.progressRoot));
    expect(plan.sourceUnits).toBe(3);
    expect(plan.destinationUnits).toBe(4);
    expect(plan.matched).toBe(3); // R+A, S, S2; not T (cmp al, 6)
    const byDst = Object.fromEntries(plan.carried.map((c) => [c.destination, c]));
    expect(Object.keys(byDst).sort()).toEqual(["work:MAIN-root:0110", "work:MAIN-root:0150", "work:MAIN-root:0180"]);
    expect(byDst["work:MAIN-root:0110"]).toMatchObject({
      source: "work:MAIN-root:0010",
      alternatives: [],
      members: [["MAIN-root:0110", "MAIN-root:0010"], ["MAIN-root:0130", "MAIN-root:0030"]],
      implementations: [{ module: "MAIN-root:0110", file: "src/r.cpp", function: "r" }, { module: "MAIN-root:0130", file: "src/r.cpp", function: "a" }],
    });
    // module references inside the unit or to a callee are renamed; others become freeform text naming the source tree
    expect(byDst["work:MAIN-root:0110"]!.annotations).toEqual([
      { module: "MAIN-root:0110", annotation_type: "behavioral", description: "calls S", references: [{ reference_type: "module", reference_content: "MAIN-root:0150" }] },
      { module: "MAIN-root:0130", annotation_type: "functional", description: "bumps the counter", references: [
        { reference_type: "module", reference_content: "MAIN-root:0110" },
        { reference_type: "freeform", reference_content: "alpha MAIN-root:0060" },
        { reference_type: "freeform", reference_content: "word at DS:0100" },
      ] },
    ]);
    expect(byDst["work:MAIN-root:0180"]!.implementations).toEqual([{ module: "MAIN-root:0180", file: "src/s.cpp", function: "s" }]);
    expect(plan.unreadable).toEqual([]);
  });

  test("applying writes once per kind; a second run finds nothing new", () => {
    const t = trees();
    seed(t.progressRoot, t.source);
    const [src, dst] = [load(t.source, t.progressRoot), load(t.destination, t.progressRoot)];
    expect(applyCarry(planCarry(src, dst), dst.progress)).toEqual({ implementations: 4, annotations: 2 });
    expect(dst.progress.implementedModules()).toEqual(new Set(["MAIN-root:0110", "MAIN-root:0130", "MAIN-root:0150", "MAIN-root:0180"]));
    expect(planCarry(src, dst).carried).toEqual([]);
    expect(applyCarry(planCarry(src, dst), dst.progress)).toEqual({ implementations: 0, annotations: 0 });
  });

  test("a destination member with an implementation of its own keeps it", () => {
    const t = trees();
    seed(t.progressRoot, t.source);
    const dst = load(t.destination, t.progressRoot);
    dst.progress.addImplementation({ module: "MAIN-root:0150", file: "src/curse_s.cpp", function: "s2" });
    const plan = planCarry(load(t.source, t.progressRoot), dst);
    expect(plan.carried.map((c) => c.destination)).not.toContain("work:MAIN-root:0150");
  });

  test("identical source units: the one at the destination's own address, else the lowest id; the rest are listed", () => {
    const src = { R: { at: 0x10, code: R }, A: { at: 0x30, code: A }, S: { at: 0x50, code: S }, T: { at: 0x60, code: T }, S9: { at: 0x180, code: S }, S8: { at: 0x170, code: S } };
    const t = trees({ src });
    const store = seed(t.progressRoot, t.source);
    store.addImplementations([{ module: "MAIN-root:0180", file: "src/s9.cpp", function: "s9" }, { module: "MAIN-root:0170", file: "src/s8.cpp", function: "s8" }]);
    const plan = planCarry(load(t.source, t.progressRoot), load(t.destination, t.progressRoot));
    const byDst = Object.fromEntries(plan.carried.map((c) => [c.destination, c]));
    expect(byDst["work:MAIN-root:0180"]).toMatchObject({ source: "work:MAIN-root:0180", alternatives: ["work:MAIN-root:0050", "work:MAIN-root:0170"] });
    expect(byDst["work:MAIN-root:0150"]).toMatchObject({ source: "work:MAIN-root:0050", alternatives: ["work:MAIN-root:0170", "work:MAIN-root:0180"] });
  });

  test("the same code calling swapped callees is rejected; consistent callers are kept", () => {
    const fns = (x: string[]) => ({ X: { at: 0x10, code: x }, P: { at: 0x40, code: ["ret"] }, Q: { at: 0x50, code: ["inc ax", "ret"] }, Y: { at: 0x60, code: ["call {P}", "call {Q}", "ret"] } });
    const t = trees({ src: fns(["call {P}", "call {Q}", "ret"]), dst: fns(["call {Q}", "call {P}", "ret"]) });
    new ProgressStore(progressFileFor(t.progressRoot, t.source)).addImplementations([
      { module: "MAIN-root:0010", file: "x.cpp", function: "x" },
      { module: "MAIN-root:0060", file: "y.cpp", function: "y" },
    ]);
    const plan = planCarry(load(t.source, t.progressRoot), load(t.destination, t.progressRoot));
    expect(plan.rejected).toEqual([{ destination: "work:MAIN-root:0010", source: "work:MAIN-root:0010", reason: "calls MAIN-root:0050 where the source calls MAIN-root:0040, and the two are not matched to each other" }]);
    expect(plan.matched).toBe(3); // Y, P, Q
    expect(plan.carried.map((c) => c.destination)).toEqual(["work:MAIN-root:0060"]);
  });

  test("callees without a match must stand for one function across all matches", () => {
    // X and Y call U in the source; in the destination they call two different functions, neither the same code as U
    const src = { X: { at: 0x10, code: ["call {U}", "ret"] }, Y: { at: 0x20, code: ["call {U}", "inc ax", "ret"] }, U: { at: 0x40, code: ["inc bx", "ret"] } };
    const dst = { X: { at: 0x10, code: ["call {U1}", "ret"] }, Y: { at: 0x20, code: ["call {U2}", "inc ax", "ret"] }, U1: { at: 0x40, code: ["inc cx", "ret"] }, U2: { at: 0x50, code: ["inc dx", "ret"] }, Z: { at: 0x60, code: ["call {U1}", "call {U2}", "int3"] } };
    const t = trees({ src, dst });
    new ProgressStore(progressFileFor(t.progressRoot, t.source)).addImplementations([{ module: "MAIN-root:0010", file: "x.cpp", function: "x" }, { module: "MAIN-root:0020", file: "y.cpp", function: "y" }]);
    const plan = planCarry(load(t.source, t.progressRoot), load(t.destination, t.progressRoot));
    expect(plan.rejected.map((r) => r.destination).sort()).toEqual(["work:MAIN-root:0010", "work:MAIN-root:0020"]);
    expect(plan.rejected[0]!.reason).toMatch(/other matches pair one of them with a different function/);
    expect(plan).toMatchObject({ matched: 0, carried: [] });
  });
  test("a callee without a match may stand for one function in each program: every program links its own copy", () => {
    // the source's X and Y call U; the destination's X (MAIN.EXE) calls U1 and its Y (TOOL.EXE, another program) calls U2
    const src = { X: { at: 0x10, code: ["call {U}", "ret"] }, Y: { at: 0x20, code: ["call {U}", "inc ax", "ret"] }, U: { at: 0x40, code: ["inc bx", "ret"] } };
    const dst = {
      X: { at: 0x10, code: ["call {U1}", "ret"] }, U1: { at: 0x40, code: ["inc cx", "ret"] }, Z: { at: 0x60, code: ["call {U1}", "int3"] },
      Y: { at: 0x20, code: ["call {U2}", "inc ax", "ret"], space: "TOOL_EXE", file: "TOOL.EXE" }, U2: { at: 0x50, code: ["inc dx", "ret"], space: "TOOL_EXE", file: "TOOL.EXE" },
      Z2: { at: 0x70, code: ["call {U2}", "int3"], space: "TOOL_EXE", file: "TOOL.EXE" },
    };
    const root = tempRoot("rpg-carry-programs-");
    const progressRoot = path.join(root, "progress");
    const source = writeTree(path.join(root, "alpha"), src);
    const run = (programs?: Record<string, string[]>) => {
      const destination = writeTree(path.join(root, programs ? "beta" : "beta-flat"), dst, {}, programs);
      return planCarry(load(source, progressRoot), load(destination, progressRoot));
    };
    new ProgressStore(progressFileFor(progressRoot, source)).addImplementations([{ module: "MAIN-root:0010", file: "x.cpp", function: "x" }, { module: "MAIN-root:0020", file: "y.cpp", function: "y" }]);
    const split = run({ "MAIN.EXE": ["MAIN.EXE"], "TOOL.EXE": ["TOOL.EXE"] });
    expect(split.rejected).toEqual([]);
    expect(split.carried.map((c) => c.destination).sort()).toEqual(["work:MAIN-root:0010", "work:TOOL_EXE:0020"]);
    // the same tree read as one program (no table): U would stand for two functions of it
    expect(run().rejected.map((r) => r.destination).sort()).toEqual(["work:MAIN-root:0010", "work:TOOL_EXE:0020"]);
  });

  test("source units without progress are matched but give nothing", () => {
    const t = trees();
    const plan = planCarry(load(t.source, t.progressRoot), load(t.destination, t.progressRoot));
    expect(plan).toMatchObject({ matched: 3, carried: [] });
    // a member with only an annotation still carries it
    new ProgressStore(progressFileFor(t.progressRoot, t.source)).addAnnotation({ module: "MAIN-root:0050", annotation_type: "functional", description: "returns", references: [] });
    const again = planCarry(load(t.source, t.progressRoot), load(t.destination, t.progressRoot));
    expect(again.carried.map((c) => [c.destination, c.implementations.length, c.annotations.length])).toEqual([["work:MAIN-root:0150", 0, 1], ["work:MAIN-root:0180", 0, 1]]);
  });

  test("a unit whose listing is missing is reported and not compared", () => {
    const t = trees();
    seed(t.progressRoot, t.source);
    writeFileSync(path.join(t.destination, "units/main/functions/MAIN-root_0150.asm"), ""); // empty is still readable
    chmodSync(path.join(t.source, "units/main/functions/MAIN-root_0060.asm"), 0o000);
    try {
      const plan = planCarry(load(t.source, t.progressRoot), load(t.destination, t.progressRoot));
      expect(plan.unreadable).toEqual(["alpha work:MAIN-root:0060: MAIN-root:0060 has no readable listing"]);
      expect(plan.carried.map((c) => c.destination)).not.toContain("work:MAIN-root:0150"); // empty no longer matches S
    } finally {
      chmodSync(path.join(t.source, "units/main/functions/MAIN-root_0060.asm"), 0o644);
    }
  });
});

describe("fingerprints", () => {
  const print = (dir: string, root: string) => {
    const tree = load(dir, path.join(dir, "..", "progress"));
    return fingerprintUnit(dir, tree.graph, tree.plan.units.get(`work:${root}`)!);
  };
  const pair = (a: string[], b: string[]) => {
    const t = trees({ src: { X: { at: 0x10, code: a } }, dst: { X: { at: 0x210, code: b } } });
    return [print(t.source, "MAIN-root:0010").key, print(t.destination, "MAIN-root:0210").key];
  };

  test.each([
    ["globals renamed consistently", ["mov ax, word ptr [0x100]", "mov word ptr [0x102], ax", "mov word ptr [0x100], ax"], ["mov ax, word ptr [0x200]", "mov word ptr [0x208], ax", "mov word ptr [0x200], ax"], true],
    ["globals renamed inconsistently", ["mov ax, word ptr [0x100]", "mov word ptr [0x100], ax"], ["mov ax, word ptr [0x200]", "mov word ptr [0x208], ax"], false],
    ["segment overrides kept apart", ["mov ax, word ptr es:[0x10]"], ["mov ax, word ptr [0x10]"], false],
    ["far pointer argument renamed", ["mov di, 0x50", "push cs", "push di"], ["mov di, 0x90", "push cs", "push di"], true],
    ["a plain immediate is a constant", ["mov di, 0x50", "push di"], ["mov di, 0x90", "push di"], false],
    ["pointer pushed through another register is a constant", ["mov di, 0x50", "push ds", "push si"], ["mov di, 0x90", "push ds", "push si"], false],
    ["stack and field offsets must match", ["mov ax, word ptr [bp - 6]"], ["mov ax, word ptr [bp - 8]"], false],
    ["local jumps by position", ["cmp ax, 1", "jne @3", "inc ax", "ret"], ["cmp ax, 1", "jne @3", "inc ax", "ret"], true],
    ["local jump to a different position", ["cmp ax, 1", "jne @3", "inc ax", "ret"], ["cmp ax, 1", "jne @2", "inc ax", "ret"], false],
    ["a jump to an address the listing lacks stays literal", ["jmp 0x9000"], ["jmp 0x9000"], true],
    ["far jumps without an edge stay literal", ["ljmp 0x10, 0x20"], ["ljmp 0x10, 0x24"], false],
  ])("%s", (_name, a, b, same) => {
    const [x, y] = pair(a as string[], b as string[]);
    expect(x === y).toBe(same);
  });

  test("calls to different externals are symbols in first-use order, so the shape matches even when callees swap", () => {
    const src = { X: { at: 0x10, code: ["call {P}", "call {Q}", "ret"] }, P: { at: 0x40, code: ["ret"] }, Q: { at: 0x50, code: ["inc ax", "ret"] }, Y: { at: 0x60, code: ["call {P}", "call {Q}", "call {P}"] } };
    const dst = { X: { at: 0x10, code: ["call {Q}", "call {P}", "ret"] }, P: { at: 0x40, code: ["ret"] }, Q: { at: 0x50, code: ["inc ax", "ret"] }, Y: { at: 0x60, code: ["call {P}", "call {Q}", "call {P}"] } };
    const t = trees({ src, dst });
    const a = print(t.source, "MAIN-root:0010");
    const b = print(t.destination, "MAIN-root:0010");
    expect(a.externals).toEqual(["MAIN-root:0040", "MAIN-root:0050"]);
    expect(b.externals).toEqual(["MAIN-root:0050", "MAIN-root:0040"]);
    expect(a.key).toBe(b.key); // same shape: X0 then X1; planCarry is what rejects the swap
    expect(print(t.source, "MAIN-root:0060").externals).toEqual(["MAIN-root:0040", "MAIN-root:0050"]);
  });

  test("edges listed out of address order still give members in address order", () => {
    const t = trees({ src: { X: { at: 0x10, code: ["call {P}", "call {Q}", "ret"] }, P: { at: 0x40, code: ["ret"] }, Q: { at: 0x50, code: ["inc ax", "ret"] } } });
    const file = path.join(t.source, "navigation/callgraph.json");
    const json = JSON.parse(readFileSync(file, "utf8"));
    json.edges.reverse();
    json.edges.push({ ...json.edges[0], target: "MAIN-root:0040" }); // a second edge at Q's call site: equal offsets
    writeFileSync(file, JSON.stringify(json));
    expect(print(t.source, "MAIN-root:0010").members).toEqual(["MAIN-root:0010", "MAIN-root:0040", "MAIN-root:0050"]);
  });

  test("calls into run-time addresses and members are symbolic; a member nothing reaches still counts", () => {
    const t = trees({ src: { X: { at: 0x10, code: ["call {Y}", "lcall [di + 0x10]", "ret"] }, Y: { at: 0x30, code: ["ret"] } } });
    const graph = CallGraph.load(t.source);
    const json = JSON.parse(readFileSync(path.join(t.source, "navigation/callgraph.json"), "utf8"));
    json.nodes["unknown:MAIN-root:0012"] = { id: "unknown:MAIN-root:0012", kind: "unknown-target", space: null, address: null, file_offset: null, source_file: null, listing: null, entrypoint: false };
    json.edges.push({ source: "MAIN-root:0010", target: "unknown:MAIN-root:0012", instruction: "lcall [di + 0x10]", instruction_offset: "MAIN-root:0012", returns: true, conditions: [] });
    writeFileSync(path.join(t.source, "navigation/callgraph.json"), JSON.stringify(json));
    const g2 = CallGraph.load(t.source);
    const plan = buildWorkPlan(g2, new Set(), listingSize(t.source, g2));
    const unit = plan.units.get("work:MAIN-root:0010")!;
    expect(fingerprintUnit(t.source, g2, unit).members).toEqual(["MAIN-root:0010", "MAIN-root:0030"]);
    // a malformed unit whose extra member no call reaches: listed last instead of dropped
    expect(fingerprintUnit(t.source, graph, { ...unit, members: ["MAIN-root:0030", "MAIN-root:0010"], root: "MAIN-root:0030" }).members).toEqual(["MAIN-root:0030", "MAIN-root:0010"]);
  });

  test("a member with no listing on disk", () => {
    const t = trees();
    const tree = load(t.source, t.progressRoot);
    const json = JSON.parse(readFileSync(path.join(t.source, "navigation/callgraph.json"), "utf8"));
    json.nodes["MAIN-root:0060"].listing = null;
    writeFileSync(path.join(t.source, "navigation/callgraph.json"), JSON.stringify(json));
    const g = CallGraph.load(t.source);
    expect(fingerprintUnit(t.source, g, tree.plan.units.get("work:MAIN-root:0060")!).missing).toBe("MAIN-root:0060 has no readable listing");
  });
});

describe("copyProgress (command line)", () => {
  const run = (argv: string[], cwd?: string) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = copyProgress(argv, (l) => out.push(l), (l) => err.push(l), cwd, {});
    return { code, out: out.join("\n"), err: err.join("\n") };
  };

  test("dry run reports and writes nothing; a real run writes; verbose lists units", () => {
    const t = trees();
    seed(t.progressRoot, t.source);
    const args = ["--progress-root", "progress", "--source", "alpha", "--destination", "beta"];
    const dry = run([...args, "--dry-run"], t.root);
    expect(dry.code).toBe(0);
    expect(dry.out).toContain("matched      3 of 4 destination work units");
    expect(dry.out).toContain("to copy      4 implementation record(s) and 2 annotation(s) into 3 work unit(s)");
    expect(dry.out).toContain("dry run: nothing written");
    expect(existsSync(path.join(t.progressRoot, "beta.progress.json"))).toBe(false);
    const real = run([...args, "--verbose"], t.root);
    expect(real.code).toBe(0);
    expect(real.out).toContain("  work:MAIN-root:0110 <- work:MAIN-root:0010: 2 implementation(s), 2 annotation(s)");
    expect(real.out).toContain("    MAIN-root:0130 <- MAIN-root:0030");
    expect(real.out).toContain(`wrote        4 implementation record(s) and 2 annotation(s) to ${path.join(t.progressRoot, "beta.progress.json")}`);
    expect(run(args, t.root).out).toContain("to copy      0 implementation record(s)");
  });

  test("identical source units and unreadable units are summarised", () => {
    const src = { R: { at: 0x10, code: R }, A: { at: 0x30, code: A }, S: { at: 0x50, code: S }, T: { at: 0x60, code: T }, S8: { at: 0x170, code: S }, S9: { at: 0x180, code: S } };
    const t = trees({ src });
    seed(t.progressRoot, t.source).addImplementations([{ module: "MAIN-root:0170", file: "src/s8.cpp", function: "s8" }, { module: "MAIN-root:0180", file: "src/s9.cpp", function: "s9" }]);
    chmodSync(path.join(t.destination, "units/main/functions/MAIN-root_0160.asm"), 0o000);
    try {
      const r = run(["--progress-root", t.progressRoot, "--source", t.source, "--destination", t.destination, "--dry-run", "--verbose"]);
      expect(r.out).toContain("identical    2 of them match several identical source units");
      expect(r.out).toContain("  work:MAIN-root:0150 <- work:MAIN-root:0050: 1 implementation(s), 0 annotation(s) (also identical: work:MAIN-root:0170, work:MAIN-root:0180)");
      // same address on both sides: the member line is omitted
      expect(r.out).toContain("  work:MAIN-root:0180 <- work:MAIN-root:0180: 1 implementation(s), 0 annotation(s) (also identical: work:MAIN-root:0050, work:MAIN-root:0170)\n");
      expect(r.out).toContain("unreadable   1 work unit(s)");
      expect(r.out).toContain("  beta work:MAIN-root:0160: MAIN-root:0160 has no readable listing");
    } finally {
      chmodSync(path.join(t.destination, "units/main/functions/MAIN-root_0160.asm"), 0o644);
    }
  });

  test.each([
    [["--help"], 0, USAGE.slice(0, 30)],
    [["--source", "a"], 2, "missing --progress-root, --destination"],
    [["--progress-root", " ", "--source", "a", "--destination", "b"], 2, "missing --progress-root"],
    [["--bogus"], 2, "Unknown option '--bogus'"],
    [["stray"], 2, "Unexpected argument 'stray'"],
    [["--progress-root", "p", "--source", "a", "--destination", "b", "--work-budget-lines", "0"], 2, "--work-budget-lines / REVERSER_WORK_BUDGET_LINES must be a positive whole number"],
    [["--progress-root", "p", "--source", "a", "--destination", "b", "--work-trivial-lines", "x"], 2, "--work-trivial-lines / REVERSER_WORK_TRIVIAL_LINES must be a positive whole number"],
    [["--progress-root", "p", "--source", "x/tree", "--destination", "y/tree"], 2, "share the progress document"],
  ])("%j exits %i", (argv, code, message) => {
    const r = run(argv as string[], tmpdir());
    expect(r.code).toBe(code);
    expect(code === 0 ? r.out : r.err).toContain(message);
  });

  test("rejected matches are counted, and listed with --verbose", () => {
    const fns = (x: string[]) => ({ X: { at: 0x10, code: x }, P: { at: 0x40, code: ["ret"] }, Q: { at: 0x50, code: ["inc ax", "ret"] }, Y: { at: 0x60, code: ["call {P}", "call {Q}", "ret"] } });
    const t = trees({ src: fns(["call {P}", "call {Q}", "ret"]), dst: fns(["call {Q}", "call {P}", "ret"]) });
    new ProgressStore(progressFileFor(t.progressRoot, t.source)).addImplementation({ module: "MAIN-root:0010", file: "x.cpp", function: "x" });
    const args = ["--progress-root", t.progressRoot, "--source", t.source, "--destination", t.destination, "--dry-run"];
    expect(run(args).out).toContain("rejected     1 work unit(s) have the same code but call functions that do not correspond; left alone (--verbose lists them)");
    const verbose = run([...args, "--verbose"]).out;
    expect(verbose).toContain("left alone:\n  work:MAIN-root:0010 <- work:MAIN-root:0010: calls MAIN-root:0050 where the source calls MAIN-root:0040");
  });

  test("trees and source progress must exist", () => {
    const t = trees();
    expect(run(["--progress-root", t.progressRoot, "--source", path.join(t.root, "nope"), "--destination", t.destination])).toMatchObject({ code: 1, err: `${path.join(t.root, "nope")} is not a generated tree: it has no navigation/callgraph.json` });
    expect(run(["--progress-root", t.progressRoot, "--source", t.source, "--destination", t.destination])).toMatchObject({ code: 1, err: `No source progress at ${path.join(t.progressRoot, "alpha.progress.json")}: nothing to copy.` });
  });

  test("work unit sizes come from flags or the server's environment variables", () => {
    const t = trees();
    seed(t.progressRoot, t.source);
    const out: string[] = [];
    const bad = copyProgress(["--progress-root", t.progressRoot, "--source", t.source, "--destination", t.destination], () => {}, (l) => out.push(l), undefined, { REVERSER_WORK_BUDGET_LINES: "-1" });
    expect(bad).toBe(2);
    // a budget of 1 line splits every non-trivial callee into its own unit: R and A now match separately
    const r = run(["--progress-root", t.progressRoot, "--source", t.source, "--destination", t.destination, "--dry-run", "--work-budget-lines", "1", "--work-trivial-lines", "1"]);
    expect(r.out).toContain("matched      4 of 5 destination work units");
  });
});

describe("program pairing", () => {
  const sets = (m: Record<string, string[]>) => new Map(Object.entries(m).map(([p, keys]) => [p, new Set(keys)]));
  const pair = (a: Record<string, string[]>, b: Record<string, string[]>) => pairPrograms({ a: sets(a), b: sets(b) }, { a: "alpha", b: "beta" });

  test("the share of code, not the count: a tool pairs with the tool, the game with the game", () => {
    const runtime = ["r1", "r2"];
    const p = pair({ "PLAY.EXE": [...runtime, "g1", "g2", "g3"], "TOOL.EXE": runtime }, { "MAIN.EXE": [...runtime, "g1", "g2", "g4"], "COPY.EXE": [...runtime, "c1"] });
    expect(p).toEqual({
      pairs: [{ a: "PLAY.EXE", b: "MAIN.EXE", shared: 4, union: 6 }, { a: "TOOL.EXE", b: "COPY.EXE", shared: 2, union: 3 }],
      unpaired: { a: [], b: [] },
    });
  });
  test("shares compare exactly: 1/2 and 2/4 tie", () => {
    expect(pair({ P: ["k1", "k2"] }, { Q1: ["k1"], Q2: ["k1", "k2", "k3", "k4"] })).toEqual({
      pairs: [],
      unpaired: {
        a: [{ program: "P", reason: "its code is equally close to Q1 (beta) and Q2 (beta)" }],
        b: [
          { program: "Q1", reason: "its code is closest to P (alpha), whose code is equally close to Q1 (beta) and Q2 (beta)" },
          { program: "Q2", reason: "its code is closest to P (alpha), whose code is equally close to Q1 (beta) and Q2 (beta)" },
        ],
      },
    });
  });
  test("a three-way tie lists them all, from either side", () => {
    const p = pair({ P: ["k"], R: ["k", "x"] }, { Q1: ["k"], Q2: ["k"], Q3: ["k"] });
    expect(p.unpaired.a).toEqual([
      { program: "P", reason: "its code is equally close to Q1 (beta), Q2 (beta) and Q3 (beta)" },
      { program: "R", reason: "its code is equally close to Q1 (beta), Q2 (beta) and Q3 (beta)" },
    ]);
    expect(p.unpaired.b[0]).toEqual({ program: "Q1", reason: "its code is closest to P (alpha), whose code is equally close to Q1 (beta), Q2 (beta) and Q3 (beta)" });
  });
  test("no shared code, an empty side, a tree without a programs table", () => {
    expect(pair({ "": ["k"] }, { "": ["x"] }).unpaired).toEqual({
      a: [{ program: "", reason: "it shares no code with any program of beta" }],
      b: [{ program: "", reason: "it shares no code with any program of alpha" }],
    });
    expect(pair({}, { Q: ["k"] })).toEqual({ pairs: [], unpaired: { a: [], b: [{ program: "Q", reason: "it shares no code with any program of alpha" }] } });
    expect(pair({}, {})).toEqual({ pairs: [], unpaired: { a: [], b: [] } });
    expect(pair({ "": ["k"] }, { "": ["k", "x"] }).pairs).toEqual([{ a: "", b: "", shared: 1, union: 2 }]);
    expect(pair({ "": ["k"] }, { Q: ["k"], R: ["k"] }).unpaired.a).toEqual([{ program: "", reason: "its code is equally close to Q (beta) and R (beta)" }]);
  });

  // alpha: one program, MAIN.EXE. beta: PLAY.EXE (alpha's game, M changed) and MAIN.EXE (a tool with its own copy of
  // the runtime routines R and R0, plus U, which alpha has and beta's game does not). File names must not decide.
  const START: Record<string, Fn> = {
    M: { at: 0x10, code: ["push bp", "call {G}", "pop bp", "ret"], space: "MAIN_EXE" },
    G: { at: 0x30, code: ["mov ax, 0x1234", "ret"], space: "MAIN_EXE" },
    R: { at: 0x50, code: ["mov cx, 0x77", "rep stosb", "ret"], space: "MAIN_EXE" },
    R0: { at: 0x60, code: ["xor cx, cx", "ret"], space: "MAIN_EXE" },
    U: { at: 0x70, code: ["mov dx, 0x99", "ret"], space: "MAIN_EXE" },
    K: { at: 0x80, code: ["mov bx, 0x42", "ret"], space: "MAIN_EXE" },
  };
  const game = { space: "PLAY_EXE", file: "PLAY.EXE" };
  const tool = { space: "MAIN_EXE" };
  const BOTH: Record<string, Fn> = {
    GM: { at: 0x110, code: ["push bp", "call {GG}", "inc si", "pop bp", "ret"], ...game },
    GG: { at: 0x130, code: START.G!.code, ...game },
    GR: { at: 0x150, code: START.R!.code, ...game },
    GR0: { at: 0x160, code: START.R0!.code, ...game },
    GK: { at: 0x180, code: START.K!.code, ...game },
    T: { at: 0x210, code: ["call {SR0}", "int 0x21", "ret"], ...tool },
    SR: { at: 0x250, code: START.R!.code, ...tool },
    SR0: { at: 0x260, code: START.R0!.code, ...tool },
    SU: { at: 0x270, code: START.U!.code, ...tool },
  };
  const games = (alpha: Record<string, Fn>, beta: Record<string, Fn>, programs: { a?: Record<string, string[]>; b?: Record<string, string[]> }) => {
    const root = tempRoot("rpg-programs-");
    const side = (name: string, fns: Record<string, Fn>, table?: Record<string, string[]>) => {
      const dir = writeTree(path.join(root, name), fns, {}, table);
      return { name, disassemblyRoot: dir, graph: CallGraph.load(dir) };
    };
    return new Correspondence(side("alpha", alpha, programs.a), side("beta", beta, programs.b), DEFAULT_WORK_UNIT_OPTIONS);
  };
  const a = (at: number) => fnId(at, "MAIN_EXE");
  const g = (at: number) => fnId(at, "PLAY_EXE");
  const c = games(START, BOTH, { a: { "MAIN.EXE": ["MAIN.EXE"] }, b: { "MAIN.EXE": ["MAIN.EXE"], "PLAY.EXE": ["PLAY.EXE"] } });

  test("programs pair by content, not by file name", () => {
    expect(c.programs).toEqual({
      pairs: [{ a: "MAIN.EXE", b: "PLAY.EXE", shared: 4, union: 7 }],
      unpaired: { a: [], b: [{ program: "MAIN.EXE", reason: "its code is closest to MAIN.EXE (alpha), whose code is closer to PLAY.EXE (beta)" }] },
    });
    expect([c.programOf("a", a(0x10)), c.programOf("b", g(0x110)), c.programOf("b", a(0x210)), c.programOf("b", "nope")]).toEqual(["MAIN.EXE", "PLAY.EXE", "MAIN.EXE", undefined]);
    expect([c.partnerProgram("a", "MAIN.EXE"), c.partnerProgram("b", "PLAY.EXE"), c.partnerProgram("b", "MAIN.EXE")]).toEqual(["PLAY.EXE", "MAIN.EXE", undefined]);
  });

  test("a runtime routine both programs of beta carry pairs with the copy in alpha's partner program", () => {
    // R occurs twice in beta, so it is unique only within the program pair; nothing calls it, so only a seed finds it
    expect(c.counterpart("a", a(0x50))).toEqual({ a: a(0x50), b: g(0x150), how: "the same code as a whole work unit (work:MAIN_EXE:0050 ↔ work:PLAY_EXE:0150), and no other unit of MAIN.EXE (alpha) or PLAY.EXE (beta) has it", votes: 0 });
    expect(c.counterpart("a", a(0x30))).toMatchObject({ b: g(0x130), how: "the same code, and no other function of MAIN.EXE (alpha) or PLAY.EXE (beta) has it" });
    expect(c.counterpart("a", a(0x10))).toMatchObject({ b: g(0x110), how: `the only unmatched caller of ${a(0x30)} ↔ ${g(0x130)}` });
    expect(c.matches.map((m) => [m.a, m.b]).sort()).toEqual([[a(0x10), g(0x110)], [a(0x30), g(0x130)], [a(0x50), g(0x150)], [a(0x60), g(0x160)], [a(0x80), g(0x180)]]);
    // the tool's copies and U get no pairs, though alpha has their code
    for (const at of [0x210, 0x250, 0x260, 0x270]) expect(c.counterpart("b", a(at))).toBeUndefined();
    expect(c.sameCode("b", a(0x250))).toEqual([a(0x50)]);
  });

  test("a file the programs table leaves out is a program of its own", () => {
    const d = games(START, BOTH, { a: { "MAIN.EXE": ["MAIN.EXE"] }, b: { "PLAY.EXE": ["PLAY.EXE"] } });
    expect(d.programs).toEqual(c.programs);
    expect(d.matches).toEqual(c.matches);
  });

  test("counterpart, compare and the map name the program pairs", () => {
    const pairLine = "Programs: MAIN.EXE (alpha) ↔ PLAY.EXE (beta), 4 of their 7 distinct function bodies in both.";
    const toolLine = "Program: MAIN.EXE (beta) has no partner in alpha: its code is closest to MAIN.EXE (alpha), whose code is closer to PLAY.EXE (beta). Its functions are not paired (functions pair only within a program pair).";
    expect(renderCounterpart(c, "a", a(0x50)).split("\n").slice(0, 3)).toEqual([`# ${a(0x50)} (alpha) ↔ ${g(0x150)} (beta)`, "", pairLine]);
    expect(renderCounterpart(c, "b", a(0x250))).toContain(`\n\n${toolLine}\nSame code in alpha: ${a(0x50)}. Its program has no partner, so none was picked; \`compare\` any of them.`);
    // U's code is in beta's tool only, not in the program paired with alpha's
    expect(renderCounterpart(c, "a", a(0x70))).toContain(`${pairLine}\nSame code in beta: ${a(0x270)}. None of them is in PLAY.EXE (beta), the program paired with MAIN.EXE (alpha), so none was picked; \`compare\` any of them.`);
    expect(renderCompare(c, a(0x50), g(0x150))).toContain(`\n${pairLine}\nIdentical:`);
    expect(renderCompare(c, a(0x50), a(0x250))).toContain(`\n${pairLine}\n${toolLine}\nIdentical:`);
    expect(renderMap(c, "all", 1)).toContain(
      "\nPrograms (paired by the share of their code both have; functions are paired only within a program pair):\n" +
        "- MAIN.EXE (alpha) ↔ PLAY.EXE (beta), 4 of their 7 distinct function bodies in both\n" +
        "- MAIN.EXE (beta): no partner, its code is closest to MAIN.EXE (alpha), whose code is closer to PLAY.EXE (beta)\n\n- ",
    );
  });

  test("a tie for the closest program leaves both sides unpaired, and says so", () => {
    const runtime = { R: START.R!, R0: START.R0! };
    const copy = (space: string, file: string, shift: number): Record<string, Fn> =>
      Object.fromEntries(Object.entries(runtime).map(([k, f]) => [`${space}${k}`, { ...f, at: f.at + shift, space, file }]));
    const t = games(runtime, { ...copy("ONE_EXE", "ONE.EXE", 0x100), ...copy("TWO_EXE", "TWO.EXE", 0x200) }, { a: { "MAIN.EXE": ["MAIN.EXE"] }, b: { "ONE.EXE": ["ONE.EXE"], "TWO.EXE": ["TWO.EXE"] } });
    expect(t.matches).toEqual([]);
    expect(t.programs.pairs).toEqual([]);
    expect(renderCounterpart(t, "a", a(0x50))).toContain("Program: MAIN.EXE (alpha) has no partner in beta: its code is equally close to ONE.EXE (beta) and TWO.EXE (beta).");
    expect(renderMap(t, "all", 1)).toContain(
      "- MAIN.EXE (alpha): no partner, its code is equally close to ONE.EXE (beta) and TWO.EXE (beta)\n" +
        "- ONE.EXE (beta): no partner, its code is closest to MAIN.EXE (alpha), whose code is equally close to ONE.EXE (beta) and TWO.EXE (beta)\n" +
        "- TWO.EXE (beta): no partner, its code is closest to MAIN.EXE (alpha), whose code is equally close to ONE.EXE (beta) and TWO.EXE (beta)\n",
    );
  });

  test("one program each: the same pairs as two trees without a programs table, which name no program", () => {
    const flat = twoGames();
    const one = { "MAIN.EXE": ["MAIN.EXE"] };
    const named = games(ALPHA, BETA(["mov cx, 5", "mov dx, 6", "ret"]), { a: one, b: one });
    const pairs = (x: Correspondence) => x.matches.map((m) => [m.a, m.b, m.votes]);
    expect(pairs(named)).toEqual(pairs(flat));
    expect(named.programs.pairs).toEqual([{ a: "MAIN.EXE", b: "MAIN.EXE", shared: 6, union: 15 }]);
    expect(flat.programs).toEqual({ pairs: [{ a: "", b: "", shared: 6, union: 15 }], unpaired: { a: [], b: [] } });
    expect(flat.counterpart("a", fnId(0x10))?.how).toBe("the same code, and no other function in either game has it");
    expect(named.counterpart("a", fnId(0x10))?.how).toBe("the same code, and no other function of MAIN.EXE (alpha) or MAIN.EXE (beta) has it");
    for (const text of [renderCounterpart(flat, "a", fnId(0x10)), renderCounterpart(flat, "a", fnId(0x140)), renderCompare(flat, fnId(0x10), fnId(0x340)), renderMap(flat, "all", 1)]) expect(text).not.toMatch(/Program/);
    expect(renderCounterpart(named, "a", fnId(0x140))).toContain("Programs: MAIN.EXE (alpha) ↔ MAIN.EXE (beta), 6 of their 15 distinct function bodies in both.\nSame code in beta");
  });

  test("two trees without a programs table that share no code: the whole trees are unpaired", () => {
    const root = tempRoot("rpg-programs-");
    const side = (name: string, code: string[]) => {
      const dir = writeTree(path.join(root, name), { F: { at: 0x10, code } });
      return { name, disassemblyRoot: dir, graph: CallGraph.load(dir) };
    };
    const t = new Correspondence(side("alpha", ["inc ax", "ret"]), side("beta", ["dec ax", "ret"]), DEFAULT_WORK_UNIT_OPTIONS);
    expect(renderCounterpart(t, "a", fnId(0x10))).toContain("Program: the whole tree (alpha) has no partner in beta: it shares no code with any program of beta.");
    expect(renderMap(t, "all", 1)).toContain("- the whole tree (beta): no partner, it shares no code with any program of alpha\n");
  });

  test("links to other programs are no calls: drivers are not paired through an int 66h site, nor the game through its drivers", () => {
    // M (the same in both) raises INT 66h answered by AD (changed); N (changed) raises it answered by SB (the same).
    // As calls, M's site would pair AD, and SB's only caller would pair N. G, AH and SH let the programs pair.
    const drivers = (side: "a" | "b"): Record<string, Fn> => {
      const gameFile = { space: "PLAY_EXE", file: "PLAY.EXE" };
      const adlib = { space: "ADLIB_EXE", file: "ADLIB.EXE" };
      const sb = { space: "SBLASTER_EXE", file: "SBLASTER.EXE" };
      return {
        G: { at: 0x10, code: ["mov ax, 0x1234", "ret"], ...gameFile },
        M: { at: 0x20, code: ["push bp", "int 0x66", "pop bp", "ret"], links: { 1: { link: "interrupt", to: ["AD"] } }, ...gameFile },
        N: { at: 0x40, code: ["push di", "int 0x66", ...(side === "b" ? ["inc si"] : []), "pop di", "ret"], links: { 1: { link: "interrupt", to: ["SB"] } }, ...gameFile },
        AH: { at: 0x10, code: ["mov dx, 0x388", "out dx, al", "ret"], ...adlib },
        AD: { at: 0x20, code: ["push ax", `mov al, ${side === "a" ? 1 : 2}`, "pop ax", "iret"], ...adlib },
        SH: { at: 0x10, code: ["mov dx, 0x220", "out dx, al", "ret"], ...sb },
        SB: { at: 0x20, code: ["push bx", "mov bl, 1", "pop bx", "iret"], ...sb },
      };
    };
    const table = { "PLAY.EXE": ["PLAY.EXE"], "ADLIB.EXE": ["ADLIB.EXE"], "SBLASTER.EXE": ["SBLASTER.EXE"] };
    const t = games(drivers("a"), drivers("b"), { a: table, b: table });
    const [m, n, ad, sb] = [fnId(0x20, "PLAY_EXE"), fnId(0x40, "PLAY_EXE"), fnId(0x20, "ADLIB_EXE"), fnId(0x20, "SBLASTER_EXE")];
    expect(t.programs.pairs.map((p) => [p.a, p.b])).toEqual([["ADLIB.EXE", "ADLIB.EXE"], ["PLAY.EXE", "PLAY.EXE"], ["SBLASTER.EXE", "SBLASTER.EXE"]]);
    expect([t.counterpart("a", m)?.b, t.counterpart("a", sb)?.b]).toEqual([m, sb]);
    expect([t.counterpart("a", ad), t.counterpart("a", n)]).toEqual([undefined, undefined]);
    expect([t.candidates("a", ad), t.candidates("a", n)]).toEqual([[], []]);
    expect(t.detail(m, m).calls).toEqual([]);
    expect(t.callers("a", ad)).toEqual([]);
    // the matched game function that raises the interrupt is no matched caller of the handler
    expect(renderCounterpart(t, "a", ad)).toContain("Nothing points at a counterpart");
    expect(counterpartView(t, "alpha", ad)).toMatchObject({ ok: true, view: { callers: [] } });
  });

  test("batch files have no instructions: they are not compared and form no program", () => {
    const withBat = { ...START, BAT: { at: 0, code: [], space: "RUN_BAT", file: "RUN.BAT" } };
    const table = { "MAIN.EXE": ["MAIN.EXE"], "RUN.BAT": ["RUN.BAT"] };
    const t = games(withBat, withBat, { a: table, b: table });
    expect([t.has("a", fnId(0, "RUN_BAT")), t.has("b", fnId(0, "RUN_BAT"))]).toEqual([false, false]);
    expect(t.programs).toEqual({ pairs: [{ a: "MAIN.EXE", b: "MAIN.EXE", shared: 6, union: 6 }], unpaired: { a: [], b: [] } });
    expect(resolveFunction(t, "a", "RUN_BAT:0000")).toEqual({ ok: false, error: "alpha: RUN_BAT:0000 is a function without a readable listing or without instructions (a batch file), so there is nothing to compare." });
  });
});
