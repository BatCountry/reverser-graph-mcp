import { existsSync } from "node:fs";
import { request } from "node:http";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { TtlCache } from "../src/cache.js";
import { Correspondence, type Match } from "../src/compare/correspond.js";
import { compareUris, confidence, INLINE_DIFF_LINES, mapCounts, mapRows, renderCompare, renderCounterpart, renderMap, renderPairFull, resolveFunction, verdict } from "../src/compare/render.js";
import { comparePair, compareSummary, counterpartView } from "../src/dashboard/compare.js";
import { CallGraph } from "../src/graph/model.js";
import type { Context } from "../src/graph/tools.js";
import { DEFAULT_WORK_UNIT_OPTIONS } from "../src/graph/workunits.js";
import { startHttp, type RunningHttp } from "../src/http/server.js";
import { ProgressStore } from "../src/progress/store.js";
import { registerCompareResources } from "../src/resources.js";
import type { ToolDeps } from "../src/tools/common.js";
import { register as registerCompare } from "../src/tools/compare.js";
import { register as registerCounterpart } from "../src/tools/counterpart.js";
import { fnId as id, tempRoot, twoGames, writeTree, type Fn } from "./trees.js";

/** every fixture compares alpha (this tree) with beta */
const compareUri = compareUris("alpha", "beta");

const c = twoGames();
/** alpha's Y gets equal votes and equally similar candidates: no counterpart */
const tie = twoGames(["mov ax, 5", "mov bx, 8", "ret"]);

/** Long and odd functions, for the size limits of the text; alpha also has many functions of its own. */
function bigGames(): Correspondence {
  const root = tempRoot("rpg-cmode-");
  const range = (n: number) => [...Array(n).keys()];
  const shared = (side: "a" | "b"): Record<string, Fn> => ({
    // one long changed stretch: every other line differs
    ZIG: { at: 0x1000, code: range(30).flatMap((i) => [`mov cx, ${i}`, side === "a" ? `mov ax, ${i}` : `mov bx, ${i}`]) },
    // a change every 10 lines: many short stretches
    MANY: { at: 0x2000, code: range(100).map((i) => (i % 10 === 5 ? `mov ${side === "a" ? "ax" : "bx"}, ${i}` : `mov dx, ${i}`)) },
    // 20 lines only alpha has
    RUN: { at: 0x3000, code: ["push bp", ...(side === "a" ? range(20).map((i) => `mov si, ${i}`) : []), "pop bp", "ret"] },
    // 20 lines only beta has
    RUN2: { at: 0x3800, code: ["push bp", ...(side === "b" ? range(20).map((i) => `mov si, ${i}`) : []), "pop bp", "ret"] },
    // eleven calls in alpha, three in beta, none at aligned places (call / lcall); V is matched, F and G are not
    CALLS: { at: 0x4000, code: side === "a" ? [...range(10).map((i) => `call {F${i}}`), "call {V}", "ret"] : ["lcall {G0}", "lcall {G1}", "lcall {V}", "ret"] },
    V: { at: 0x4800, code: ["mov bp, 0x77", "ret"] },
  });
  const alpha: Record<string, Fn> = { ...shared("a"), OC: { at: 0x4900, code: ["call {F0}", "int3", "int3"] } };
  for (const i of range(10)) alpha[`F${i}`] = { at: 0x5000 + i * 0x10, code: [`mov di, ${i}`, "ret"] };
  for (const i of range(110)) alpha[`O${i}`] = { at: 0x6000 + i * 0x10, code: [`mov bp, ${i}`, "int3"] };
  const extra = {
    "unknown:1": { id: "unknown:1", kind: "unknown-target", space: null, address: null, file_offset: null, source_file: null, listing: null, entrypoint: false },
    [id(0x9000)]: { id: id(0x9000), kind: "function", space: "MAIN-root", address: 0x9000, file_offset: 0x9000, source_file: "MAIN.EXE", listing: null, entrypoint: false },
  };
  const a = writeTree(path.join(root, "alpha"), alpha, extra);
  const b = writeTree(path.join(root, "beta"), { ...shared("b"), G0: { at: 0x4a00, code: ["mov sp, 1", "ret"] }, G1: { at: 0x4a10, code: ["mov sp, 2", "ret"] } });
  return new Correspondence({ name: "alpha", disassemblyRoot: a, graph: CallGraph.load(a) }, { name: "beta", disassemblyRoot: b, graph: CallGraph.load(b) }, DEFAULT_WORK_UNIT_OPTIONS);
}
const big = bigGames();

describe("confidence", () => {
  const m = (votes: number): Match => ({ a: "x", b: "y", how: "", votes });
  test.each([
    [0, 0, "same code"],
    [0, 1, "same code"],
    [1, 1, "strong"],
    [1, 0.6, "strong"],
    [1, 0.5999, "likely"],
    [1, 0.3, "likely"],
    [1, 0.2999, "weak"],
    [1, 0, "weak"],
    [2, 0, "likely"],
    [1, Number.NaN, "weak"],
  ])("%i votes, similarity %f: %s", (votes, similarity, expected) => {
    expect(confidence(m(votes), similarity)).toBe(expected);
  });
});

describe("resolveFunction", () => {
  test("node names and addresses inside a function", () => {
    expect(resolveFunction(c, "a", "main-root:0010")).toEqual({ ok: true, id: id(0x10) });
    expect(resolveFunction(c, "a", "MAIN-root:0012")).toEqual({ ok: true, id: id(0x10), note: expect.stringMatching(/^alpha: .*inside it/) });
  });
  test.each([
    ["", /^alpha: Pass a module/],
    ["nope", /^alpha: .*No graph node/],
    ["unknown:1", /^alpha: unknown:1 is not a function \(kind: unknown-target\), so there is nothing to compare\.$/],
    [id(0x9000), /^alpha: MAIN-root:9000 is a function without a readable listing/],
  ])("%j is refused", (raw, error) => {
    const r = resolveFunction(big, "a", raw);
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(error);
  });
});

describe("renderCounterpart", () => {
  test("identical: verdict, reason, no diff", () => {
    const t = renderCounterpart(c, "a", id(0x10));
    expect(t).toContain(`# ${id(0x10)} (alpha) ↔ ${id(0x210)} (beta)`);
    expect(t).toContain("Identical: the same instructions once addresses are renamed, and every callee is the other's counterpart (6 instructions in alpha, 6 in beta).");
    expect(t).toContain("(confidence: same code)");
    expect(t).toContain("Calls: 3 callees at aligned places, 3 of them each other's counterparts.");
    expect(t).not.toContain("## Differences");
    expect(t).toContain(`Full side by side: ${compareUri.pair(id(0x10), id(0x210))}`);
  });
  test("changed, asked from either game, with a note", () => {
    const t = renderCounterpart(c, "b", id(0x240), "beta: read as X");
    expect(t.startsWith("beta: read as X\n\n# MAIN-root:0040 (alpha) ↔ MAIN-root:0240 (beta)")).toBe(true);
    expect(t).toContain("Changed: 66% of the instructions line up (3 instructions in alpha, 3 in beta).");
    expect(t).toContain("## Differences (1 of 1 changed stretch)");
    expect(t).toContain("- 0042       add ax, 2\n+      0242  add ax, 3");
  });
  test("same code with other callees: no diff, the callee that differs", () => {
    const t = renderCounterpart(c, "a", id(0x100));
    expect(t).toContain("The same instructions once addresses are renamed, but not every callee is the other's counterpart (see Calls).");
    expect(t).toContain(`- ${id(0x120)} ⇄ ${id(0x330)}: ${id(0x120)} is ${id(0x320)}'s counterpart`);
    expect(t).not.toContain("## Differences");
  });
  test("no counterpart: identical code elsewhere", () => {
    expect(renderCounterpart(c, "a", id(0x140))).toBe(`# ${id(0x140)} (alpha): no counterpart found in beta\n\nSame code in beta: ${id(0x340)}, ${id(0x350)}. Several functions share it, so none was picked; \`compare\` any of them.`);
  });
  test("no counterpart: candidates and matched callers", () => {
    const t = renderCounterpart(tie, "a", id(0x120));
    expect(t).toContain(`- ${id(0x320)}: 1 vote, called at the same place by ${id(0xe0)} ↔ ${id(0x2e0)}`);
    expect(t).toContain(`Matched callers (compare them to see what the beta side calls instead):\n- ${id(0xe0)} ↔ ${id(0x2e0)}\n- ${id(0x100)} ↔ ${id(0x300)}`);
    // from the other side, the caller's counterpart is named the other way round
    expect(renderCounterpart(tie, "b", id(0x320))).toContain(`- ${id(0x2e0)} ↔ ${id(0xe0)}`);
  });
  test("no counterpart and no leads", () => {
    expect(renderCounterpart(big, "a", id(0x6000))).toContain("Nothing points at a counterpart: no function in beta has its code, and none of its callers or callees is matched.");
  });
  test("more than eight identical functions or five matched callers are cut", () => {
    const root = tempRoot("rpg-cmode-");
    const fns = (side: "a" | "b"): Record<string, Fn> => {
      const out: Record<string, Fn> = {};
      for (let i = 0; i < 9; i++) out[`S${i}`] = { at: 0x100 + i * 0x10, code: ["nop", "ret"] };
      // six unique callers of T; in beta three call T1 and three T2, equally like T: T stays unmatched
      for (let i = 0; i < 6; i++) out[`C${i}`] = { at: 0x400 + i * 0x10, code: [side === "a" ? "call {T}" : `call {T${(i % 2) + 1}}`, `mov si, ${i}`, "ret"] };
      if (side === "a") out.T = { at: 0x800, code: ["mov ax, 1", "ret"] };
      else (out.T1 = { at: 0x800, code: ["mov ax, 2", "ret"] }), (out.T2 = { at: 0x810, code: ["mov ax, 3", "ret"] });
      return out;
    };
    const a = writeTree(path.join(root, "alpha"), fns("a"));
    const b = writeTree(path.join(root, "beta"), fns("b"));
    const many = new Correspondence({ name: "alpha", disassemblyRoot: a, graph: CallGraph.load(a) }, { name: "beta", disassemblyRoot: b, graph: CallGraph.load(b) }, DEFAULT_WORK_UNIT_OPTIONS);
    expect(renderCounterpart(many, "a", id(0x100))).toContain(`${id(0x170)}, …. Several functions share it`);
    const t = renderCounterpart(many, "a", id(0x800));
    expect(t).toContain("- … 1 more");
    expect(t).toContain(`- ${id(0x800)}: 3 votes`);
  });
});

describe("inline differences stay short", () => {
  test("a stretch longer than the budget is cut", () => {
    const t = renderCompare(big, id(0x1000), id(0x1000));
    expect(t).toContain("## Differences (1 of 1 changed stretch)");
    expect(t).toContain("… this stretch goes on");
    const diff = t.slice(t.indexOf("```"), t.lastIndexOf("```"));
    expect(diff.split("\n").length).toBeLessThanOrEqual(INLINE_DIFF_LINES + 4);
  });
  test("many stretches: the first ones, then a link for the rest", () => {
    const t = renderCompare(big, id(0x2000), id(0x2000));
    const m = /## Differences \((\d+) of 10 changed stretches\)/.exec(t);
    expect(Number(m?.[1])).toBeGreaterThan(0);
    expect(t).toContain(`${10 - Number(m![1])} more: ${compareUri.pair(id(0x2000), id(0x2000))}`);
  });
  test("long runs on one side are cut to their ends", () => {
    const t = renderCompare(big, id(0x3000), id(0x3000));
    expect(t).toContain("- 3002       mov si, 0\n- 3004       mov si, 1\n- 3006       mov si, 2\n- … 15 more only in alpha\n- 3026       mov si, 18\n- 3028       mov si, 19");
    expect(renderPairFull(big, id(0x3000), id(0x3000))).toContain("- 3010       mov si, 7");
    expect(renderCompare(big, id(0x3800), id(0x3800))).toContain("+      3806  mov si, 2\n+ … 15 more only in beta\n+      3826  mov si, 18");
  });
  test("more than eight callees that differ", () => {
    const t = renderCompare(big, id(0x4000), id(0x4000));
    expect(t).toContain(`- only alpha calls ${id(0x5000)} here\n`);
    expect(t).toContain("- … 6 more in the full side by side");
    const full = renderPairFull(big, id(0x4000), id(0x4000));
    expect(full).toContain(`- only alpha calls ${id(0x5090)} here`);
    expect(full).toContain(`- only alpha calls ${id(0x4800)} here (its counterpart is ${id(0x4800)})`);
    expect(full).toContain(`- only beta calls ${id(0x4a00)} here\n`);
    expect(full).toContain(`- only beta calls ${id(0x4800)} here (its counterpart is ${id(0x4800)})`);
  });
  test("an unmatched caller is not listed among the leads", () => {
    // F0 is called by CALLS (matched through V) and by OC (alpha only)
    expect(big.counterpart("a", id(0x4000))?.how).toBe(`the only unmatched caller of ${id(0x4800)} ↔ ${id(0x4800)}`);
    const t = renderCounterpart(big, "a", id(0x5000));
    expect(t).toContain(`- ${id(0x4000)} ↔ ${id(0x4000)}`);
    expect(t).not.toContain(id(0x4900));
    const v = counterpartView(big, "alpha", id(0x5000));
    expect(v.ok && v.view.callers).toEqual([{ here: id(0x4000), there: id(0x4000) }]);
  });
});

describe("renderCompare and renderPairFull", () => {
  test("recorded counterparts", () => {
    const t = renderCompare(c, id(0x40), id(0x240));
    expect(t).not.toContain("Not recorded");
    expect(t).toContain("Paired because: called at the same place");
    const full = renderPairFull(c, id(0x40), id(0x240));
    expect(full).toContain("Paired because: called at the same place");
    expect(full).toContain("  0040 0240  mov ax, 1");
  });
  test("not counterparts: what each side is paired with, notes first", () => {
    const t = renderCompare(c, id(0xe0), id(0x300), ["alpha: read as G1"]);
    expect(t.startsWith("alpha: read as G1\n\n# MAIN-root:00e0 (alpha) vs MAIN-root:0300 (beta)")).toBe(true);
    expect(t).toContain(`Not recorded as counterparts. ${id(0xe0)}'s counterpart is ${id(0x2e0)}. ${id(0x300)}'s counterpart is ${id(0x100)}.`);
    expect(t).toContain(`~ 00e0 0300  call 0x120  ⇄  call 0x330`);
    expect(renderCompare(c, id(0x140), id(0x350))).toContain(`${id(0x140)} has no counterpart. ${id(0x350)} has no counterpart.`);
    expect(renderPairFull(c, id(0x140), id(0x350))).toContain("Not recorded as counterparts.");
  });
  test("a middle too long to align says so", () => {
    // real ones need two functions of thousands of lines: the verdict is checked on a pair marked inexact
    const d = big.detail(id(0x1000), id(0x1000));
    expect(verdict(big, d)).toBe("Changed: 50% of the instructions line up (60 instructions in alpha, 60 in beta).");
    expect(verdict(big, { ...d, alignment: { ...d.alignment, exact: false } })).toBe(
      "Changed: 50% of the instructions line up (60 instructions in alpha, 60 in beta; too long to align exactly, the differing middle is shown as removed then added).",
    );
  });
  test("callee pairs neither side has matched, or only one side has", () => {
    expect(renderCompare(tie, id(0xe0), id(0x2e0))).toContain(`- ${id(0x120)} ⇄ ${id(0x320)}: neither is matched yet`);
    expect(renderCompare(c, id(0x100), id(0x300))).toContain(`- ${id(0x120)} ⇄ ${id(0x330)}: ${id(0x120)} is ${id(0x320)}'s counterpart`);
    // alpha's T2 belongs to nobody; beta's T is T1's
    const t = twoGames(undefined, { Q2: { at: 0x40, code: ["call {T2}", "mov si, 2", "ret"] }, Q1: { at: 0x20, code: ["call {T1}", "mov si, 1", "ret"] }, T1: { at: 0x60, code: ["mov ax, 5", "inc bx", "ret"] }, T2: { at: 0x70, code: ["mov cx, 9", "dec bx", "ret"] } }, { Q2: { at: 0x40, code: ["call {T}", "mov si, 2", "ret"] }, Q1: { at: 0x20, code: ["call {T}", "mov si, 1", "ret"] }, T: { at: 0x60, code: ["mov ax, 6", "inc bx", "ret"] } });
    expect(renderCompare(t, id(0x40), id(0x40))).toContain(`- ${id(0x70)} ⇄ ${id(0x60)}: ${id(0x60)} is ${id(0x60)}'s counterpart`);
  });
});

describe("the map", () => {
  test("rows and counts", () => {
    const rows = mapRows(c);
    expect(mapCounts(rows)).toEqual({ identical: 4, changed: 5, "only-a": 2, "only-b": 3 });
    expect(rows.find((r) => r.a === id(0x100))).toEqual({ a: id(0x100), b: id(0x300), status: "changed", similarity: 1, sameCode: true, confidence: "same code" });
    expect(rows.find((r) => r.a === id(0x40))).toEqual({ a: id(0x40), b: id(0x240), status: "changed", similarity: 4 / 6, confidence: "strong" });
  });
  test.each([
    ["all", `- ${id(0x10)} ↔ ${id(0x210)}: identical (same code)`],
    ["identical", `- ${id(0x60)} ↔ ${id(0x260)}: identical (same code)`],
    ["changed", `- ${id(0xa0)} ↔ ${id(0x2a0)}: changed, 57% lines up (likely)`],
    ["changed", `- ${id(0x100)} ↔ ${id(0x300)}: same instructions, other callees (same code)`],
    ["unmatched", `- ${id(0x140)}: only in alpha`],
    ["unmatched", `- ${id(0x330)}: only in beta`],
  ] as const)("%s lists %s", (filter, line) => {
    const t = renderMap(c, filter, 1);
    expect(t).toContain(line);
    expect(t).toContain("4 identical, 5 changed, 2 only in alpha, 3 only in beta.");
    expect(t).toContain("Last page.");
  });
  test("filters keep only their rows", () => {
    const rows = (filter: Parameters<typeof renderMap>[1]) => renderMap(c, filter, 1).split("\n").filter((l) => l.startsWith("- "));
    expect(rows("identical").every((l) => l.includes(": identical"))).toBe(true);
    expect(rows("changed").every((l) => l.includes("↔") && !l.includes(": identical"))).toBe(true);
    expect(rows("unmatched").every((l) => l.includes(": only in "))).toBe(true);
    expect(rows("all")).toHaveLength(14);
  });
  test("pages of 100 with a link to the next", () => {
    const first = renderMap(big, "unmatched", 1);
    expect(first).toContain("unmatched functions, page 1 of 2");
    expect(first).toContain(`Next page: ${compareUri.map("unmatched", 2)}`);
    expect(first.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(100);
    expect(renderMap(big, "unmatched", 2)).toContain("Last page.");
  });
  test.each([0, 3, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("page %f does not exist", (page) => {
    expect(() => renderMap(big, "unmatched", page)).toThrow("unmatched has 2 pages (1-2)");
  });
  test("an empty filter still has page 1", () => {
    const root = tempRoot("rpg-cmode-");
    const a = writeTree(path.join(root, "alpha"), { M: { at: 0x10, code: ["ret"] } });
    const b = writeTree(path.join(root, "beta"), { M: { at: 0x10, code: ["ret"] } });
    const one = new Correspondence({ name: "alpha", disassemblyRoot: a, graph: CallGraph.load(a) }, { name: "beta", disassemblyRoot: b, graph: CallGraph.load(b) }, DEFAULT_WORK_UNIT_OPTIONS);
    expect(renderMap(one, "unmatched", 1)).toContain("page 1 of 1");
    expect(() => renderMap(one, "unmatched", 2)).toThrow("unmatched has 1 page (1-1)");
  });
});

describe("dashboard JSON", () => {
  test("summary", () => {
    expect(compareSummary(c)).toEqual({ a: "alpha", b: "beta", functions: { a: 11, b: 12 }, counts: { identical: 4, changed: 5, "only-a": 2, "only-b": 3 }, programs: { pairs: [{ a: "", b: "", shared: 6, union: 15 }], unpaired: { a: [], b: [] } } });
  });
  test("a pair: rows by kind, the match or each side's own counterpart", () => {
    const p = comparePair(c, id(0x40), "MAIN-root:0240");
    expect(p.ok && p.pair).toMatchObject({ a: id(0x40), b: id(0x240), matched: true, how: expect.stringContaining("called at the same place"), confidence: "strong", identical: false });
    expect(p.ok && p.pair.rows.map((r) => r.kind)).toEqual(["same", "a", "b", "same"]);
    const q = comparePair(c, id(0xe0), id(0x300));
    expect(q.ok && q.pair).toMatchObject({ matched: false, aCounterpart: id(0x2e0), bCounterpart: id(0x100) });
    expect(q.ok && q.pair.rows[0]!.kind).toBe("moved");
    expect(q.ok && "how" in q.pair).toBe(false);
    const r = comparePair(c, id(0x140), id(0x350));
    expect(r.ok && ["aCounterpart" in r.pair, "bCounterpart" in r.pair]).toEqual([false, false]);
  });
  test("a pair with an unknown side", () => {
    expect(comparePair(c, "nope", id(0x240))).toMatchObject({ ok: false, error: expect.stringMatching(/^alpha: /) });
    expect(comparePair(c, id(0x40), "nope")).toMatchObject({ ok: false, error: expect.stringMatching(/^beta: /) });
  });
  test("counterpart: the pair, or the leads with the listing", () => {
    expect(counterpartView(c, "beta", id(0x240))).toEqual({ ok: true, view: { game: "beta", id: id(0x240), a: id(0x40), b: id(0x240), sameCode: [], candidates: [], callers: [{ here: id(0x210), there: id(0x10) }], listing: [] } });
    const v = counterpartView(tie, "alpha", "MAIN-root:0120");
    expect(v.ok && v.view).toMatchObject({ candidates: [{ id: id(0x320) }, { id: id(0x330) }], listing: [{ addr: 0x120, text: "mov ax, 5" }, expect.anything(), expect.anything()] });
    expect(v.ok && "a" in v.view).toBe(false);
    expect(counterpartView(c, "alpha", "MAIN-root:0012")).toMatchObject({ ok: true, view: { id: id(0x10), note: expect.stringContaining("inside it") } });
  });
  test.each([
    ["gamma", id(0x10), 'No game "gamma": this dashboard compares alpha and beta.'],
    ["alpha", "nope", "alpha: "],
  ])("counterpart %s %s is refused", (game, raw, error) => {
    expect(counterpartView(c, game, raw)).toMatchObject({ ok: false, error: expect.stringContaining(error) });
  });
});

describe("MCP tools and resources (in process)", () => {
  let client: Client;
  let bare: Client;
  const text = (r: unknown) => ((r as { content: Array<{ text: string }> }).content ?? []).map((x) => x.text).join("\n");
  const connect = async (deps: ToolDeps, resources: boolean) => {
    const server = new McpServer({ name: "t", version: "0" });
    registerCounterpart(server, deps);
    registerCompare(server, deps);
    if (resources && deps.compare) registerCompareResources(server, deps.compare.names, deps.compare.correspondence);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const cl = new Client({ name: "c", version: "0" });
    await cl.connect(ct);
    return cl;
  };
  const unused = () => {
    throw new Error("not used");
  };

  beforeAll(async () => {
    client = await connect({ graphContext: unused, progressContext: unused, compare: { names: ["alpha", "beta"], correspondence: () => c } }, true);
    bare = await connect({ graphContext: unused, progressContext: unused }, false);
  });
  afterAll(async () => {
    await client?.close();
    await bare?.close();
  });

  test("only offered in compare mode, named after the games", async () => {
    expect((await bare.listTools()).tools).toEqual([]);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["counterpart", "compare"]);
    expect(tools[0]!.title).toBe("Find the same function in the other game (alpha ↔ beta)");
    expect(Object.keys((tools[1]!.inputSchema as { properties: object }).properties)).toEqual(["alpha", "beta"]);
  });

  test("counterpart from either game, and its errors", async () => {
    expect(text(await client.callTool({ name: "counterpart", arguments: { module: id(0x40) } }))).toContain(`# ${id(0x40)} (alpha) ↔ ${id(0x240)} (beta)`);
    expect(text(await client.callTool({ name: "counterpart", arguments: { module: id(0x240), game: "beta" } }))).toContain(`# ${id(0x40)} (alpha) ↔ ${id(0x240)} (beta)`);
    expect(text(await client.callTool({ name: "counterpart", arguments: { module: "MAIN-root:0012", game: "alpha" } }))).toMatch(/^alpha: .*inside it/);
    const bad = await client.callTool({ name: "counterpart", arguments: { module: id(0x240) } });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toMatch(/^alpha: No graph node/);
    expect((await client.callTool({ name: "counterpart", arguments: { module: id(0x10), game: "gamma" } })).isError).toBe(true);
  });

  test("compare any two, and its errors", async () => {
    expect(text(await client.callTool({ name: "compare", arguments: { alpha: id(0xe0), beta: id(0x300) } }))).toContain("Not recorded as counterparts.");
    expect(text(await client.callTool({ name: "compare", arguments: { alpha: "MAIN-root:0012", beta: id(0x210) } }))).toMatch(/^alpha: .*inside it[^]*# MAIN-root:0010 \(alpha\) vs MAIN-root:0210 \(beta\)/);
    const both = await client.callTool({ name: "compare", arguments: { alpha: "x", beta: "y" } });
    expect(both.isError).toBe(true);
    expect(text(both)).toMatch(/^alpha: [^\n]*\nbeta: /);
    const one = await client.callTool({ name: "compare", arguments: { alpha: id(0x10), beta: "y" } });
    expect(text(one)).toMatch(/^beta: /);
    expect((await client.callTool({ name: "compare", arguments: { alpha: id(0x10) } })).isError).toBe(true);
  });

  test("resources: the pair in full and the map", async () => {
    const read = async (uri: string) => (await client.readResource({ uri })).contents.map((x) => ("text" in x ? x.text : "")).join("");
    expect(await read(compareUri.pair(id(0x40), id(0x240)))).toContain("  0040 0240  mov ax, 1");
    expect(await read(compareUri.map("changed", 1))).toContain("changed functions, page 1 of 1");
    const listed = (await client.listResources()).resources.map((r) => r.uri);
    expect(listed).toEqual(["all", "identical", "changed", "unmatched"].map((f) => `disasm://alpha/compare/beta/map/${f}/1`));
    for (const [uri, message] of [
      [compareUri.pair("nope", id(0x240)), 'alpha has no function "nope"'],
      [`disasm://alpha/compare/beta/pair/${encodeURIComponent(id(0x40))}/%E0%A4%A`, 'beta has no function "%E0%A4%A"'],
      [compareUri.pair(id(0x40), "%E0%A4%A"), 'beta has no function "%E0%A4%A"'],
      ["disasm://alpha/compare/beta/map/odd/1", 'Unknown filter "odd"'],
      ["disasm://alpha/compare/beta/map/all/2", "all has 1 page"],
      ["disasm://alpha/compare/beta/map/all/x", "all has 1 page"],
      ["disasm://alpha/compare/beta/map/all/-1", "all has 1 page"],
    ] as const) {
      await expect(client.readResource({ uri }), uri).rejects.toThrow(message);
    }
  });
});

describe("HTTP /api/compare", () => {
  let fx: { a: string };
  let http: RunningHttp;
  let off: RunningHttp;
  let failing: RunningHttp;
  const get = (base: string, p: string): Promise<{ status: number; body: { error?: string } & Record<string, unknown> }> =>
    new Promise((resolve, reject) => {
      const req = request(`${base}${p}`, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (x: string) => (body += x));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(body) }));
      });
      req.on("error", reject);
      req.end();
    });

  beforeAll(async () => {
    fx = { a: c.a.disassemblyRoot };
    const ctx: Context = { graph: c.a.graph, disassemblyRoot: fx.a, progress: new ProgressStore(path.join(tempRoot("rpg-cmode-"), "alpha.progress.json")), cache: new TtlCache() };
    const base = { port: 0, mcp: () => new McpServer({ name: "t", version: "0" }), context: () => ctx, webRoot: path.resolve("web"), buildRoot: path.resolve("build"), onerror: () => {} };
    http = await startHttp({ ...base, compare: () => c });
    off = await startHttp(base);
    failing = await startHttp({
      ...base,
      compare: () => {
        throw new Error("no beta here");
      },
    });
  });
  afterAll(async () => {
    await Promise.all([http?.close(), off?.close(), failing?.close()]);
  });

  test("summary, map, pair, counterpart", async () => {
    expect((await get(http.url, "/api/compare/summary")).body).toMatchObject({ a: "alpha", b: "beta" });
    expect(((await get(http.url, "/api/compare/map")).body.rows as unknown[]).length).toBe(14);
    expect((await get(http.url, `/api/compare/pair/${encodeURIComponent(id(0x40))}/${encodeURIComponent(id(0x240))}`)).body).toMatchObject({ matched: true });
    expect((await get(http.url, `/api/compare/counterpart/beta/${encodeURIComponent(id(0x240))}`)).body).toMatchObject({ a: id(0x40) });
  });

  test.each([
    ["/api/compare/pair/nope/x", 404, /^alpha: /],
    ["/api/compare/pair/a", 400, /compare\/pair\/\{a\}\/\{b\}/],
    ["/api/compare/pair/a/b/c", 400, /compare\/pair/],
    ["/api/compare/pair/a/", 400, /compare\/pair/],
    ["/api/compare/pair/%E0%A4%A/b", 400, /compare\/pair/],
    ["/api/compare/counterpart/gamma/x", 404, /No game "gamma"/],
    ["/api/compare/counterpart/alpha", 400, /compare\/counterpart/],
    ["/api/compare/nope", 404, /Compare routes:/],
  ])("%s answers %i", async (p, status, error) => {
    const r = await get(http.url, p);
    expect(r.status).toBe(status);
    expect(r.body.error).toMatch(error);
  });

  test("outside compare mode, and when the other tree cannot load", async () => {
    expect(await get(off.url, "/api/compare/summary")).toEqual({ status: 404, body: { error: "Not in compare mode: start the server with --compare <other tree>." } });
    expect((await get(off.url, "/api/nope")).body.error).not.toContain("compare/");
    expect((await get(http.url, "/api/nope")).body.error).toContain("compare/…");
    const r = await get(failing.url, "/api/compare/summary");
    expect(r.status).toBe(503);
    expect(r.body.error).toContain("no beta here");
  });
});

describe("build/index.js --compare", () => {
  const SERVER = path.resolve("build/index.js");
  let client: Client;
  beforeAll(async () => {
    if (!existsSync(SERVER)) throw new Error("build/index.js missing: run `npm run build` (npm test does this)");
    client = new Client({ name: "compare-mode", version: "0" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [SERVER, "--disassembly-root", c.a.disassemblyRoot, "--compare", c.b.disassemblyRoot], stderr: "pipe" }));
  }, 30_000);
  afterAll(async () => {
    await client?.close();
  });

  test("advertises the compare tools and answers them", async () => {
    expect(client.getInstructions()).toContain("Call `counterpart` with a function of either game");
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["module", "counterpart", "compare"]));
    const r = await client.callTool({ name: "counterpart", arguments: { module: id(0x40) } });
    expect(JSON.stringify(r.content)).toContain("called at the same place");
    const templates = (await client.listResourceTemplates()).resourceTemplates.map((t) => t.uriTemplate);
    expect(templates).toEqual(expect.arrayContaining(["disasm://alpha/compare/beta/pair/{a}/{b}", "disasm://alpha/compare/beta/map/{filter}/{page}"]));
  });
});
