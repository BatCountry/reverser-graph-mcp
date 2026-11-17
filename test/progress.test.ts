import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, test } from "vitest";
import { TtlCache } from "../src/cache.js";
import { CallGraph } from "../src/graph/model.js";
import { lookupModule } from "../src/graph/tools.js";
import { getSameCode, getWorkPlan } from "../src/graph/workplan-cache.js";
import { buildWorkPlan } from "../src/graph/workunits.js";
import { checkImplementsComment, findImplementationFiles, ProgressStore } from "../src/progress/store.js";
import { addAnnotation, addImplementation, type ProgressContext } from "../src/progress/tools.js";
import { IDS, makeFixture, type Fixture } from "./fixture.js";

let fx: Fixture;
let ctx: ProgressContext;
beforeEach(() => {
  fx = makeFixture();
  const graph = CallGraph.load(fx.disassembly);
  const progress = new ProgressStore(fx.progressFile);
  ctx = { tree: path.basename(fx.disassembly), graph, progress, implementationRoot: fx.implementation, workPlan: () => getWorkPlan({ graph, disassemblyRoot: fx.disassembly, progress }), sameCode: () => getSameCode({ graph, disassemblyRoot: fx.disassembly }) };
});
const now = new Date("2026-01-02T03:04:05Z");

describe("checkImplementsComment", () => {
  const src = (comment: string) => `${comment}\nint draw_frame() { return 0; }\n`;
  test("accepts a block comment naming the module and a function mention", () => {
    expect(checkImplementsComment(src("/* Implements: module-0001:0010 */"), "module-0001:0010", "draw_frame", "f.cpp")).toEqual({ ok: true });
    expect(checkImplementsComment(src("/*\n * Implements: MAIN-root:4e14, module-0001:0010\n */"), "module-0001:0010", "draw_frame", "f.cpp").ok).toBe(true);
    expect(checkImplementsComment(src("/* Implements: MODULE-0001:0010 */"), "module-0001:0010", "draw_frame", "f.cpp").ok).toBe(true);
  });
  test("module names match as whole tokens only", () => {
    const r = checkImplementsComment(src("/* Implements: module-0001:00100 */"), "module-0001:0010", "draw_frame", "f.cpp");
    expect(r.ok).toBe(false);
    expect(checkImplementsComment(src("/* Implements: xmodule-0001:0010 */"), "module-0001:0010", "draw_frame", "f.cpp").ok).toBe(false);
  });
  test("no comment, wrong module (lists what it names), missing function", () => {
    expect(checkImplementsComment("int x;", "module-0001:0010", "x", "f.cpp")).toMatchObject({ ok: false, error: expect.stringContaining("no `/* Implements") });
    expect(checkImplementsComment(src("/* Implements: module-0002:0030 */"), "module-0001:0010", "draw_frame", "f.cpp")).toMatchObject({ ok: false, error: expect.stringContaining("It names: module-0002:0030") });
    expect(checkImplementsComment("/* Implements: module-0001:0010 */ int other;", "module-0001:0010", "draw_frame", "f.cpp")).toMatchObject({ ok: false, error: expect.stringContaining("draw_frame") });
    expect(checkImplementsComment("// Implements: module-0001:0010\nvoid draw_frame(){}", "module-0001:0010", "draw_frame", "f.cpp").ok).toBe(false); // line comments do not count
    // whatever node ids the comment does hold are listed, in the file-named format too (and not 5-digit lookalikes)
    expect(checkImplementsComment(src("/* Implements: MAIN_OVR-0020:377f, work:MAIN_EXE:61e4, X_EXE:12345 */"), "module-0001:0010", "draw_frame", "f.cpp"))
      .toMatchObject({ ok: false, error: expect.stringContaining("It names: MAIN_OVR-0020:377f, work:MAIN_EXE:61e4.") });
  });
  test("function names are matched as identifiers, and regex characters are escaped", () => {
    expect(checkImplementsComment("/* Implements: module-0001:0010 */ int draw_frame2;", "module-0001:0010", "draw_frame", "f.cpp").ok).toBe(false);
    expect(checkImplementsComment("/* Implements: module-0001:0010 */ x", "module.0001:0010", "x", "f.cpp").ok).toBe(false);
  });
});

describe("checkImplementsComment with work unit ids", () => {
  const unit = "work:MAIN-root:0006";
  const members = ["MAIN-root:0006", "module-0001:0010", "module-0001:0020"];
  const src = (comment: string) => `${comment}\nvoid run_unit() {}\n`;
  test("the work unit id is a whole token", () => {
    expect(checkImplementsComment(src(`/* Implements: ${unit} */`), unit, "run_unit", "f.cpp", members)).toEqual({ ok: true });
    expect(checkImplementsComment(src("/* Implements: WORK:main-root:0006 */"), unit, "run_unit", "f.cpp", members).ok).toBe(true);
    expect(checkImplementsComment(src("/* Implements: work:MAIN-root:00060 */"), unit, "run_unit", "f.cpp").ok).toBe(false);
    expect(checkImplementsComment(src("/* Implements: xwork:MAIN-root:0006 */"), unit, "run_unit", "f.cpp").ok).toBe(false);
    // the root alone is not the unit, and the unit is not the root node
    expect(checkImplementsComment(src("/* Implements: MAIN-root:0006 */"), unit, "run_unit", "f.cpp").ok).toBe(false);
    expect(checkImplementsComment(src(`/* Implements: ${unit} */`), "MAIN-root:0006", "run_unit", "f.cpp")).toMatchObject({ ok: false, error: expect.stringContaining(`It names: ${unit}`) });
  });
  test("naming every member instead is enough; otherwise the missing ones are listed", () => {
    expect(checkImplementsComment(src(`/* Implements: ${members.join(", ")} */`), unit, "run_unit", "f.cpp", members).ok).toBe(true);
    expect(checkImplementsComment(src(`/* Implements: ${members[0]} */\n/* Implements: ${members[1]}, ${members[2]} */`), unit, "run_unit", "f.cpp", members).ok).toBe(true);
    expect(checkImplementsComment(src(`/* Implements: ${members[0]}, ${members[1]} */`), unit, "run_unit", "f.cpp", members)).toMatchObject({
      ok: false,
      error: expect.stringContaining(`missing 1 of 3: module-0001:0020. It names: MAIN-root:0006, module-0001:0010.`),
    });
  });
  test("no comment, or the unit named but the function missing", () => {
    expect(checkImplementsComment("void run_unit() {}", unit, "run_unit", "f.cpp", members)).toMatchObject({ ok: false, error: expect.stringContaining(`no \`/* Implements: ... */\` comment. Add one naming ${unit}`) });
    expect(checkImplementsComment(`/* Implements: ${unit} */ int x;`, unit, "run_unit", "f.cpp", members)).toMatchObject({ ok: false, error: expect.stringContaining('"run_unit"') });
  });
});

describe("findImplementationFiles", () => {
  test("basename, trailing path, and no match", () => {
    expect(findImplementationFiles(fx.implementation, "bare.cpp")).toHaveLength(1);
    expect(findImplementationFiles(fx.implementation, "render.cpp")).toHaveLength(2);
    expect(findImplementationFiles(fx.implementation, "src/render.cpp")).toHaveLength(1);
    expect(findImplementationFiles(fx.implementation, "nope.cpp")).toEqual([]);
  });
  test("does not match a longer basename suffix", () => {
    expect(findImplementationFiles(fx.implementation, "ender.cpp")).toEqual([]);
  });
});

describe("addImplementation", () => {
  const args = (over: Partial<{ tree: string; module: string; implementation_filename: string; function_name: string }> = {}) => ({
    tree: ctx.tree, module: IDS.A, implementation_filename: "src/render.cpp", function_name: "draw_frame", ...over,
  });

  test("records, persists, and is reflected by lookupModule", () => {
    const r = addImplementation(ctx, args(), now);
    expect(r).toMatchObject({ ok: true, message: expect.stringContaining("Recorded draw_frame in src") });
    const file = JSON.parse(readFileSync(fx.progressFile, "utf8"));
    expect(file.implementations).toEqual([{ module: IDS.A, file: path.join("src", "render.cpp"), function: "draw_frame", recordedAt: now.toISOString() }]);
    const m = lookupModule({ graph: ctx.graph, disassemblyRoot: fx.disassembly, progress: ctx.progress, cache: new TtlCache() }, { module: IDS.A });
    if (!m.ok) throw new Error(m.error);
    expect(m.output.implementation_status).toContain("Implemented: draw_frame in src");
    expect(m.output.callees).toContain(IDS.B);
  });
  test("normalises the module name and is idempotent", () => {
    expect(addImplementation(ctx, args({ module: "MODULE-0001:0010" }), now)).toMatchObject({ ok: true });
    expect(addImplementation(ctx, args(), now)).toMatchObject({ ok: true, message: expect.stringContaining("Refreshed") });
    expect(ctx.progress.implementationsFor(IDS.A)).toHaveLength(1);
  });
  test("a second implementation of the same module is kept; implemented set marks the node in listings", () => {
    addImplementation(ctx, args(), now);
    // other.cpp names B and C, not A: rejected, nothing recorded
    expect(addImplementation(ctx, args({ implementation_filename: "other.cpp", function_name: "other_fn" }), now).ok).toBe(false);
    expect(addImplementation(ctx, args({ module: IDS.B, implementation_filename: "other.cpp", function_name: "other_fn" }), now).ok).toBe(true);
    expect([...ctx.progress.implementedModules()].sort()).toEqual([IDS.A, IDS.B]);
  });
  test.each([
    [{ module: "nope" }, "module:"],
    [{ implementation_filename: "  " }, "implementation_filename: empty"],
    [{ function_name: "" }, "function_name: empty"],
    [{ implementation_filename: "missing.cpp" }, "No file named"],
    [{ implementation_filename: "render.cpp" }, "ambiguous"],
    [{ implementation_filename: "bare.cpp", function_name: "nothing" }, "no `/* Implements"],
    [{ function_name: "no_such_fn" }, "does not contain the function name"],
    [{ module: IDS.B }, "No `/* Implements: ... */` comment in"],
  ])("rejects %j", (over, fragment) => {
    const r = addImplementation(ctx, args(over), now);
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.error).toContain(fragment);
    expect(existsSync(fx.progressFile)).toBe(false); // rejected calls write nothing
  });
});

describe("addImplementation with a work unit id", () => {
  // fixture work unit work:MAIN-root:0006 = R (entry) + A + B
  const unit = `work:${IDS.R}`;
  const members = [IDS.R, IDS.A, IDS.B];
  const write = (name: string, comment: string) => writeFileSync(path.join(fx.implementation, "src", name), `${comment}\nvoid run_unit() {}\n`);
  const call = (module: string) => addImplementation(ctx, { tree: ctx.tree, module, implementation_filename: "unit.cpp", function_name: "run_unit" }, now);
  const progressFile = () => fx.progressFile;

  test("a comment naming the unit records every function member", () => {
    write("unit.cpp", `/* Implements: ${unit} */`);
    const r = call(unit);
    expect(r).toMatchObject({ ok: true, message: expect.stringContaining(`as the implementation of ${unit}: 3 function members (3 new, 0 refreshed)`) });
    expect([...ctx.progress.implementedModules()].sort()).toEqual([...members].sort());
    const file = JSON.parse(readFileSync(progressFile(), "utf8"));
    expect(file.implementations).toHaveLength(3);
    for (const rec of file.implementations) expect(rec).toMatchObject({ file: path.join("src", "unit.cpp"), function: "run_unit", recordedAt: now.toISOString() });
    expect(call(unit)).toMatchObject({ ok: true, message: expect.stringContaining("(0 new, 3 refreshed)") });
    expect(ctx.progress.implementedModules().size).toBe(3);
    expect(ctx.workPlan().units.get(unit)?.complete).toBe(true);
  });
  test("a comment naming every member works too; the id is case-insensitive and trimmed", () => {
    write("unit.cpp", `/* Implements: ${members.join(", ")} */`);
    expect(call(` WORK:${IDS.R.toLowerCase()} `)).toMatchObject({ ok: true });
    expect(ctx.progress.implementedModules().size).toBe(3);
  });
  test("a comment missing members is rejected with the list and writes nothing", () => {
    write("unit.cpp", `/* Implements: ${IDS.R}, ${IDS.A} */`);
    const r = call(unit);
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining(`missing 1 of 3: ${IDS.B}`) });
    write("unit.cpp", `/* Implements: ${IDS.R} */`);
    expect(call(unit)).toMatchObject({ ok: false, error: expect.stringContaining(`missing 2 of 3: ${IDS.A}, ${IDS.B}`) });
    expect(existsSync(progressFile())).toBe(false);
  });
  test.each([
    [`work:${IDS.A}`, `module: ${IDS.A} does not head a work unit; it belongs to work:${IDS.R}`],
    ["work:nope", 'module: "work:nope" is not a work unit: "nope" is not a node name or an address'],
    ["work:", 'module: "work:" is not a node name or an address'],
    ["work:0016:0020", `module: ${IDS.A} does not head a work unit`],
  ])("rejects %s and writes nothing", (module, fragment) => {
    write("unit.cpp", `/* Implements: ${module} */`);
    const r = call(module);
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.error).toContain(fragment);
    expect(existsSync(progressFile())).toBe(false);
  });
  test("a node in no work unit has nothing to record", () => {
    const graph = new CallGraph({ nodes: { "module-0009:0001": { id: "module-0009:0001", kind: "address", space: "module-0009", address: 1, file_offset: null, source_file: null, listing: null, entrypoint: false } }, edges: [], aliases: {} });
    const r = addImplementation({ ...ctx, graph, workPlan: () => buildWorkPlan(graph, new Set(), () => 0) }, { tree: ctx.tree, module: "work:module-0009:0001", implementation_filename: "render.cpp", function_name: "x" });
    expect(r).toMatchObject({ ok: false, error: 'module: module-0009:0001 is in no work unit: a node of kind "address" has nothing to implement on its own.' });
  });
});

describe("addAnnotation", () => {
  const body = (references: Array<{ reference_type: "module" | "freeform"; reference_content: string }> = []) => ({ description: " Draws the frame ", references });
  test("records with canonicalised module references and freeform text", () => {
    const r = addAnnotation(ctx, { tree: ctx.tree, module: IDS.A, annotation_type: "functional", annotation_body: body([{ reference_type: "module", reference_content: "module-0002:0030" }, { reference_type: "freeform", reference_content: "  writes B800  " }]) }, now);
    expect(r).toMatchObject({ ok: true, message: expect.stringContaining("2 references") });
    expect(ctx.progress.annotationsFor(IDS.A)[0]).toMatchObject({ description: "Draws the frame", references: [{ reference_type: "module", reference_content: IDS.C }, { reference_type: "freeform", reference_content: "writes B800" }] });
  });
  test("annotations accumulate and appear in the module lookup", () => {
    addAnnotation(ctx, { tree: ctx.tree, module: IDS.A, annotation_type: "behavioral", annotation_body: body() }, now);
    addAnnotation(ctx, { tree: ctx.tree, module: IDS.A, annotation_type: "functional", annotation_body: body() }, now);
    const m = lookupModule({ graph: ctx.graph, disassemblyRoot: fx.disassembly, progress: ctx.progress, cache: new TtlCache() }, { module: IDS.A });
    if (!m.ok) throw new Error(m.error);
    expect(m.output.implementation_status).toContain("2 annotation(s)");
  });
  test("rejects unknown module, empty description, and invalid module references (all reported)", () => {
    expect(addAnnotation(ctx, { tree: ctx.tree, module: "nope", annotation_type: "functional", annotation_body: body() }).ok).toBe(false);
    expect(addAnnotation(ctx, { tree: ctx.tree, module: IDS.A, annotation_type: "functional", annotation_body: { description: "  ", references: [] } })).toMatchObject({ ok: false });
    const bad = addAnnotation(ctx, { tree: ctx.tree, module: IDS.A, annotation_type: "functional", annotation_body: body([{ reference_type: "module", reference_content: "x" }, { reference_type: "module", reference_content: "y" }]) });
    expect(bad).toMatchObject({ ok: false });
    if (!bad.ok) expect(bad.error.split("\n")).toHaveLength(2);
    expect(existsSync(fx.progressFile)).toBe(false);
  });
});

describe("the tree a write is for", () => {
  // node names repeat across games, so a write names its game and only that game's server accepts it
  const implement = (tree: string) => addImplementation(ctx, { tree, module: IDS.A, implementation_filename: "src/render.cpp", function_name: "draw_frame" }, now);
  const annotate = (tree: string) => addAnnotation(ctx, { tree, module: IDS.A, annotation_type: "functional", annotation_body: { description: "d", references: [] } }, now);
  test.each([
    ["exact", (t: string) => t],
    ["upper case", (t: string) => t.toUpperCase()],
    ["padded", (t: string) => `  ${t}\t`],
  ])("accepts this server's tree (%s)", (_name, spell) => {
    expect(implement(spell(ctx.tree))).toMatchObject({ ok: true });
    expect(annotate(spell(ctx.tree))).toMatchObject({ ok: true });
  });
  test.each([
    ["", "tree: empty"],
    ["   ", "tree: empty"],
    ["beta", 'tree: "beta" is not this server\'s tree'],
    ["generated/TREE", "is not this server's tree"],
    ["TREEx", "is not this server's tree"],
    ["TRE", "is not this server's tree"],
  ])("refuses %j and records nothing", (raw, fragment) => {
    const tree = raw.replace("TREE", ctx.tree).replace("TRE", ctx.tree.slice(0, -1));
    for (const r of [implement(tree), annotate(tree)]) {
      expect(r).toMatchObject({ ok: false });
      if (!r.ok) expect(r.error).toContain(fragment);
      if (!r.ok) expect(r.error).toContain(`"${ctx.tree}"`); // names the tree this server is for
    }
    expect(existsSync(fx.progressFile)).toBe(false);
  });
  test("the tree is checked before anything else", () => {
    const r = addImplementation(ctx, { tree: "beta", module: "nope", implementation_filename: "", function_name: "" }, now);
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("tree:") });
  });
});

describe("ProgressStore", () => {
  test("an empty or missing store reads as empty; a foreign version fails loudly", () => {
    const store = new ProgressStore(fx.progressFile);
    expect(store.implementationsFor("x")).toEqual([]);
    expect(store.implementedModules().size).toBe(0);
    store.addAnnotation({ module: "m", annotation_type: "functional", description: "d", references: [] });
    const file = fx.progressFile;
    const data = JSON.parse(readFileSync(file, "utf8"));
    data.version = 2;
    writeFileSync(file, JSON.stringify(data));
    expect(() => store.implementationsFor("m")).toThrow(/Unsupported progress file version/);
  });
});
