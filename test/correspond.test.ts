import { readFileSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { Correspondence, getCorrespondence } from "../src/compare/correspond.js";
import { DEFAULT_WORK_UNIT_OPTIONS } from "../src/graph/workunits.js";
import { CallGraph } from "../src/graph/model.js";
import { ALPHA, twoGames as build, fnId as id, tempRoot, writeTree, type Fn } from "./trees.js";

describe("Correspondence", () => {
  const c = build();
  const pair = (a: number) => c.counterpart("a", id(a));

  test("seeds: functions whose code no other function has", () => {
    expect(pair(0x10)).toEqual({ a: id(0x10), b: id(0x210), how: "the same code, and no other function in either game has it", votes: 0 });
    expect(pair(0x60)?.b).toBe(id(0x260));
    expect(pair(0xc0)?.b).toBe(id(0x2c0));
  });

  test("changed callees are found at the same call site of a match", () => {
    expect(pair(0x40)).toEqual({ a: id(0x40), b: id(0x240), how: `called at the same place by ${id(0x10)} ↔ ${id(0x210)}`, votes: 1 });
    expect(pair(0x80)?.b).toBe(id(0x280));
    expect(c.counterpart("b", id(0x240))?.a).toBe(id(0x40));
  });

  test("a changed caller is found as the only unmatched caller of a match", () => {
    expect(pair(0xa0)).toMatchObject({ b: id(0x2a0), how: `the only unmatched caller of ${id(0xc0)} ↔ ${id(0x2c0)}` });
  });

  test("competing proposals: the more similar code wins", () => {
    // G1 proposes Y1, G2 proposes Y2 for Y: one vote each; Y1 lines up better
    expect(pair(0x120)?.b).toBe(id(0x320));
    expect(c.counterpart("b", id(0x330))).toBeUndefined();
    expect(c.candidates("b", id(0x330))).toEqual([]); // its only proposal, Y, is taken
  });

  test("identical stubs shared by several functions are never paired by guessing", () => {
    expect(pair(0x140)).toBeUndefined();
    expect(c.sameCode("a", id(0x140))).toEqual([id(0x340), id(0x350)]);
    expect(c.sameCode("b", id(0x350))).toEqual([id(0x140), id(0x150)]);
    expect(c.sameCode("a", "MAIN-root:dead")).toEqual([]);
  });

  test("functions, listing, has, matches", () => {
    expect(c.functions("a")).toEqual(Object.values(ALPHA).map((f) => id(f.at)).sort());
    expect(c.listing("a", id(0x60))).toEqual([{ addr: 0x60, text: "mov cx, 7" }, { addr: 0x62, text: "ret" }]);
    expect(c.listing("b", "MAIN-root:dead")).toEqual([]);
    expect([c.has("a", id(0x60)), c.has("a", id(0x260)), c.has("b", id(0x260))]).toEqual([true, false, true]);
    expect(c.matches.map((m) => m.a).sort()).toEqual([0x10, 0x40, 0x60, 0x80, 0xa0, 0xc0, 0xe0, 0x100, 0x120].map((at) => id(at)).sort());
  });

  test("detail: identical code with corresponding callees, changed code, and callees that disagree", () => {
    const m = c.detail(id(0x10), id(0x210));
    expect(m).toMatchObject({ sameCode: true, identical: true });
    expect(m.calls).toEqual([
      { a: id(0x40), b: id(0x240), state: "same" },
      { a: id(0x60), b: id(0x260), state: "same" },
      { a: id(0x80), b: id(0x280), state: "same" },
    ]);
    expect(c.detail(id(0x10), id(0x210))).toBe(m); // cached
    const x = c.detail(id(0x40), id(0x240));
    expect(x).toMatchObject({ sameCode: false, identical: false, calls: [] });
    expect(x.alignment.similarity).toBeCloseTo(4 / 6);
    // G2 (calls Y) against beta's G1 (calls Y1): Y is Y1's counterpart, so that callee pair agrees
    expect(c.detail(id(0x100), id(0x2e0)).calls).toEqual([{ a: id(0x120), b: id(0x320), state: "same" }]);
    // alpha's G1 against beta's G2: other code (mov si, 1 / 2), and Y is Y1's counterpart, Y2 nobody's
    expect(c.detail(id(0xe0), id(0x300))).toMatchObject({ sameCode: false, identical: false, calls: [{ a: id(0x120), b: id(0x330), state: "other" }] });
  });
});

describe("ties and changed call stretches", () => {
  test("equal votes and equally similar code: no pairing, both stay candidates", () => {
    const c = build(["mov ax, 5", "mov bx, 8", "ret"]);
    expect(c.counterpart("a", id(0x120))).toBeUndefined();
    expect(c.candidates("a", id(0x120))).toEqual([
      { id: id(0x320), votes: 1, how: `called at the same place by ${id(0xe0)} ↔ ${id(0x2e0)}` },
      { id: id(0x330), votes: 1, how: `called at the same place by ${id(0x100)} ↔ ${id(0x300)}` },
    ]);
    expect(c.detail(id(0xe0), id(0x300)).calls).toEqual([{ a: id(0x120), b: id(0x330), state: "open" }]);
  });

  test("calls in a changed stretch pair in order when both sides make as many, else stand alone", () => {
    const alpha = { H: { at: 0x10, code: ["push bp", "call {V}", "call {W}", "ret"] }, V: { at: 0x40, code: ["inc ax", "ret"] }, W: { at: 0x50, code: ["inc bx", "ret"] }, Z: { at: 0x60, code: ["call {V}", "call {W}", "int3"] } };
    const beta = {
      H: { at: 0x10, code: ["push bp", "lcall {V}", "lcall {W}", "ret"] },
      J: { at: 0x30, code: ["push bp", "lcall {V}", "ret"] },
      V: { at: 0x40, code: ["inc ax", "ret"] },
      W: { at: 0x50, code: ["inc bx", "ret"] },
      Z: { at: 0x60, code: ["call {V}", "call {W}", "int3"] },
    };
    const c = build(undefined, alpha, beta);
    expect(c.detail(id(0x10), id(0x10)).calls.map((p) => [p.a, p.b])).toEqual([[id(0x40), id(0x40)], [id(0x50), id(0x50)]]);
    expect(c.detail(id(0x10), id(0x30)).calls.map((p) => [p.a, p.b])).toEqual([[id(0x40), undefined], [id(0x50), undefined], [undefined, id(0x40)]]);
  });

  test("sites with several targets, run-time targets and nodes without listings are left out of pairing", () => {
    const root = tempRoot("rpg-corr-");
    const sides = (["alpha", "beta"] as const).map((name) => {
      const fns: Record<string, Fn> = {
        M: { at: 0x10, code: ["push bp", "call {X}", "call {Q}", "ret"] },
        X: { at: 0x40, code: [name === "alpha" ? "inc ax" : "dec ax", "ret"] },
        Q: { at: 0x50, code: ["int3"] },
        // the same call written differently: the site falls in a changed stretch
        N: { at: 0x80, code: [name === "alpha" ? "call {Q}" : "lcall {Q}", "ret"] },
      };
      const dir = writeTree(path.join(root, name), fns);
      const file = path.join(dir, "navigation", "callgraph.json");
      const g = JSON.parse(readFileSync(file, "utf8"));
      g.nodes["unknown:1"] = { id: "unknown:1", kind: "unknown-target", space: null, address: null, file_offset: null, source_file: null, listing: null, entrypoint: false };
      g.nodes[id(0x70)] = { ...g.nodes[id(0x40)], id: id(0x70), address: 0x70, listing: null };
      // every call to Q goes through a table that also holds the listing-less 0x70 and a run-time target
      for (const e of g.edges.filter((x: { target: string }) => x.target === id(0x50))) g.edges.push({ ...e, target: id(0x70) }, { ...e, target: "unknown:1" });
      writeFileSync(file, JSON.stringify(g));
      return { name, disassemblyRoot: dir, graph: CallGraph.load(dir) };
    });
    const c = new Correspondence(sides[0]!, sides[1]!, DEFAULT_WORK_UNIT_OPTIONS);
    expect(c.counterpart("a", id(0x10))?.b).toBe(id(0x10));
    expect(c.counterpart("a", id(0x40))?.b).toBe(id(0x40));
    expect(c.has("a", id(0x70))).toBe(false);
    expect(c.detail(id(0x10), id(0x10)).calls.map((p) => [p.a, p.b])).toEqual([
      [id(0x40), id(0x40)],
      [id(0x50), undefined],
      [id(0x70), undefined],
      [undefined, id(0x50)],
      [undefined, id(0x70)],
    ]);
    expect(c.detail(id(0x80), id(0x80)).calls.map((p) => [p.a, p.b])).toEqual([
      [id(0x50), undefined],
      [id(0x70), undefined],
      [undefined, id(0x50)],
      [undefined, id(0x70)],
    ]);
  });

  test("a work unit no other unit shares pairs all its members, even where single functions are ambiguous", () => {
    // H's helper code `ret` is also D's in each game, so no single function pairs it; U's unit (U + H) does,
    // and D's unit alone is unique as a unit too
    const fns = (base: number): Record<string, Fn> => ({ U: { at: base, code: ["mov ax, 3", "call {H}", "ret"] }, H: { at: base + 0x20, code: ["ret"] }, D: { at: base + 0x30, code: ["ret"] } });
    const c = build(undefined, fns(0x10), fns(0x110));
    expect(c.sameCode("a", id(0x30))).toEqual([id(0x130), id(0x140)]);
    expect(c.counterpart("a", id(0x30))).toEqual({ a: id(0x30), b: id(0x130), how: `the same code as a whole work unit (work:${id(0x10)} ↔ work:${id(0x110)}), and no other unit has it`, votes: 0 });
    expect(c.counterpart("a", id(0x40))?.how).toBe(`the same code as a whole work unit (work:${id(0x40)} ↔ work:${id(0x140)}), and no other unit has it`);
  });
});

describe("getCorrespondence", () => {
  test("one per process, rebuilt when a callgraph.json changes", () => {
    const root = tempRoot("rpg-corr-");
    const a = writeTree(path.join(root, "alpha"), { M: { at: 0x10, code: ["ret"] } });
    const b = writeTree(path.join(root, "beta"), { M: { at: 0x10, code: ["ret"] } });
    const first = getCorrespondence(a, b, DEFAULT_WORK_UNIT_OPTIONS);
    expect(first.a.name).toBe("alpha");
    expect(getCorrespondence(a, b, DEFAULT_WORK_UNIT_OPTIONS)).toBe(first);
    const graph = CallGraph.load(a);
    utimesSync(path.join(b, "navigation", "callgraph.json"), new Date(), new Date(Date.now() + 5000));
    const second = getCorrespondence(a, b, DEFAULT_WORK_UNIT_OPTIONS, graph);
    expect(second).not.toBe(first);
    expect(second.a.graph).toBe(graph);
    expect(second.counterpart("a", id(0x10))?.b).toBe(id(0x10));
  });

  test("a missing tree fails to load with the reason", () => {
    const root = tempRoot("rpg-corr-");
    const a = writeTree(path.join(root, "alpha"), { M: { at: 0x10, code: ["ret"] } });
    expect(() => getCorrespondence(a, path.join(root, "nope"), DEFAULT_WORK_UNIT_OPTIONS)).toThrow(/Cannot read the call graph/);
  });
});

describe("edge cases of matching", () => {
  const games = (alpha: Record<string, Fn>, beta: Record<string, Fn>) => build(undefined, alpha, beta);

  test("addresses that move are not changes: globals, far pointer arguments, local jumps", () => {
    const code = (g: number, p: number) => ["cmp ax, 1", "jne @3", `mov ax, word ptr [0x${g.toString(16)}]`, `mov di, 0x${p.toString(16)}`, "push ds", "push di", `mov bx, word ptr es:[0x${(g + 2).toString(16)}]`, "jmp 0x9999", "ljmp 0x10, 0x20", "ret"];
    const c = games({ F: { at: 0x10, code: code(0x100, 0x50) }, U: { at: 0x80, code: ["call {F}", "inc si", "ret"] } }, { F: { at: 0x110, code: code(0x200, 0x90) }, U: { at: 0x180, code: ["call {F}", "dec si", "ret"] } });
    const d = c.detail(id(0x10), id(0x110));
    expect(d.sameCode).toBe(true);
    expect(d.alignment.similarity).toBe(1);
    expect(c.counterpart("a", id(0x80))).toMatchObject({ b: id(0x180), how: `the only unmatched caller of ${id(0x10)} ↔ ${id(0x110)}` });
    // a different constant is a change
    const e = games({ F: { at: 0x10, code: ["mov ax, 1", "ret"] } }, { F: { at: 0x10, code: ["mov ax, 2", "ret"] } });
    expect(e.detail(id(0x10), id(0x10)).alignment.similarity).toBe(0.5);
  });

  test("a proposal both sides like best wins; the loser is left with no open partner", () => {
    // Q1 and Q2 are seeds; in alpha they call T1 and T2, in beta both call T, which is more like T1.
    // T2 is proposed first, but T prefers T1 (equal votes, more similar code)
    const c = games(
      {
        Q2: { at: 0x40, code: ["call {T2}", "mov si, 2", "ret"] },
        Q1: { at: 0x20, code: ["call {T1}", "mov si, 1", "ret"] },
        T1: { at: 0x60, code: ["mov ax, 5", "inc bx", "ret"] },
        T2: { at: 0x70, code: ["mov cx, 9", "dec bx", "ret"] },
        R: { at: 0x90, code: ["call {T2}", "int3"] },
      },
      { Q2: { at: 0x40, code: ["call {T}", "mov si, 2", "ret"] }, Q1: { at: 0x20, code: ["call {T}", "mov si, 1", "ret"] }, T: { at: 0x60, code: ["mov ax, 6", "inc bx", "ret"] } },
    );
    expect(c.counterpart("b", id(0x60))).toMatchObject({ a: id(0x60), votes: 1 });
    expect(c.counterpart("a", id(0x70))).toBeUndefined();
    expect(c.candidates("a", id(0x70))).toEqual([]);
    expect(c.detail(id(0x40), id(0x40)).calls).toEqual([{ a: id(0x70), b: id(0x60), state: "other" }]);
  });

  test("more votes beat more similar code", () => {
    const c = games(
      {
        Q1: { at: 0x20, code: ["call {T1}", "mov si, 1", "ret"] },
        Q2: { at: 0x40, code: ["call {T2}", "mov si, 2", "ret"] },
        Q3: { at: 0x50, code: ["call {T2}", "mov si, 3", "ret"] },
        T1: { at: 0x60, code: ["mov ax, 5", "inc bx", "ret"] },
        T2: { at: 0x70, code: ["mov cx, 9", "dec bx", "ret"] },
      },
      { Q1: { at: 0x20, code: ["call {T}", "mov si, 1", "ret"] }, Q2: { at: 0x40, code: ["call {T}", "mov si, 2", "ret"] }, Q3: { at: 0x50, code: ["call {T}", "mov si, 3", "ret"] }, T: { at: 0x60, code: ["mov ax, 6", "inc bx", "ret"] } },
    );
    expect(c.counterpart("b", id(0x60))).toMatchObject({ a: id(0x70), votes: 2 });
  });

  test("a callee called twice at aligned places is listed once", () => {
    const c = games({ M: { at: 0x10, code: ["call {X}", "call {X}", "ret"] }, X: { at: 0x40, code: ["ret"] } }, { M: { at: 0x10, code: ["call {X}", "call {X}", "ret"] }, X: { at: 0x40, code: ["ret"] } });
    expect(c.detail(id(0x10), id(0x10)).calls).toEqual([{ a: id(0x40), b: id(0x40), state: "same" }]);
  });

  test("functions come by space, then address", () => {
    const c = games(
      { B: { at: 0x30, code: ["inc ax", "ret"], space: "module-0200" }, A: { at: 0x20, code: ["inc bx", "ret"] }, C: { at: 0x10, code: ["inc cx", "ret"], space: "module-0200" }, D: { at: 0x10, code: ["inc dx", "ret"] } },
      { A: { at: 0x20, code: ["inc bx", "ret"] } },
    );
    expect(c.functions("a")).toEqual([id(0x10), id(0x20), id(0x10, "module-0200"), id(0x30, "module-0200")]);
  });
});
