import { describe, expect, test } from "vitest";
import { align, hunks, type Row } from "../src/compare/diff.js";

/** The rows as `=x` (both), `-x` (a only), `+x` (b only). */
const show = (a: string[], b: string[], rows: Row[]) => rows.map((r) => (r.a !== undefined && r.b !== undefined ? `=${a[r.a]}` : r.a !== undefined ? `-${a[r.a]}` : `+${b[r.b!]}`));

describe("align", () => {
  test.each([
    [[], [], [], 1],
    [["x"], [], ["-x"], 0],
    [[], ["y"], ["+y"], 0],
    [["x", "y"], ["x", "y"], ["=x", "=y"], 1],
    [["p", "x", "s"], ["p", "y", "s"], ["=p", "-x", "+y", "=s"], 2 / 3],
    [["p", "x"], ["p"], ["=p", "-x"], 2 / 3],
    [["x", "s"], ["s"], ["-x", "=s"], 2 / 3],
    [["a", "b", "c", "d"], ["b", "x", "d", "e"], ["-a", "=b", "-c", "+x", "=d", "+e"], 0.5],
    [["a", "a"], ["a"], ["=a", "-a"], 2 / 3],
  ])("%j vs %j", (a, b, expected, similarity) => {
    const al = align(a, b);
    expect(show(a, b, al.rows)).toEqual(expected);
    expect(al.similarity).toBeCloseTo(similarity);
    expect(al.same).toBe(expected.filter((r) => r.startsWith("=")).length);
    expect(al.exact).toBe(true);
  });

  test("every line of both sides appears once, in order", () => {
    const a = "the quick brown fox jumps over the lazy dog".split(" ");
    const b = "a quick brown cat jumps over lazy dogs".split(" ");
    const rows = align(a, b).rows;
    expect(rows.flatMap((r) => (r.a === undefined ? [] : [r.a]))).toEqual(a.map((_, i) => i));
    expect(rows.flatMap((r) => (r.b === undefined ? [] : [r.b]))).toEqual(b.map((_, i) => i));
    expect(align(a, b).same).toBe(5); // quick brown jumps over lazy
  });

  test("a middle too big to align is shown as removed then added", () => {
    const al = align(["p", "x", "y", "s"], ["p", "u", "v", "s"], 3);
    expect(show(["p", "x", "y", "s"], ["p", "u", "v", "s"], al.rows)).toEqual(["=p", "-x", "-y", "+u", "+v", "=s"]);
    expect(al.exact).toBe(false);
    expect(align(["p", "x", "y", "s"], ["p", "u", "v", "s"], 4).exact).toBe(true);
    // a one-sided middle needs no table: still exact
    expect(align(["p", "x", "y", "s"], ["p", "s"], 0).exact).toBe(true);
  });
});

describe("hunks", () => {
  const rows = (pattern: string): Row[] => [...pattern].map((ch, i) => (ch === "=" ? { a: i, b: i } : ch === "-" ? { a: i } : { b: i }));
  test.each([
    ["", 2, []],
    ["====", 2, []],
    ["-", 2, [[0, 1]]],
    ["==-==", 0, [[2, 3]]],
    ["=====-=====", 2, [[3, 8]]],
    ["-===+", 1, [[0, 2], [3, 5]]],
    ["-==+", 1, [[0, 4]]],
    ["--=+", 2, [[0, 4]]],
  ])("%s with context %i", (pattern, context, expected) => {
    expect(hunks(rows(pattern), context)).toEqual(expected);
  });
  test("default context is 2", () => {
    expect(hunks(rows("=====-=====")).length).toBe(1);
    expect(hunks(rows("=====-====="))).toEqual([[3, 8]]);
  });
});
