import { describe, expect, test } from "vitest";
import { selectLines } from "../src/graph/line-range.js";

describe("selectLines", () => {
  test.each([
    // N-M, including exact bounds and a single line
    ["1-80", 100, { first: 1, last: 80, clipped: false }],
    ["1-100", 100, { first: 1, last: 100, clipped: false }],
    ["100-100", 100, { first: 100, last: 100, clipped: false }],
    ["7-7", 100, { first: 7, last: 7, clipped: false }],
    // past the end: cut at the last line and say so
    ["1-80", 34, { first: 1, last: 34, clipped: true }],
    ["34-9999999", 34, { first: 34, last: 34, clipped: true }],
    // N+COUNT
    ["50+20", 100, { first: 50, last: 69, clipped: false }],
    ["50+51", 100, { first: 50, last: 100, clipped: false }],
    ["50+52", 100, { first: 50, last: 100, clipped: true }],
    ["1+1", 1, { first: 1, last: 1, clipped: false }],
    // N and N-: from line N on
    ["50", 100, { first: 50, last: 100, clipped: false }],
    ["50-", 100, { first: 50, last: 100, clipped: false }],
    ["100", 100, { first: 100, last: 100, clipped: false }],
    // -N: the last N lines
    ["-20", 100, { first: 81, last: 100, clipped: false }],
    ["-100", 100, { first: 1, last: 100, clipped: false }],
    ["-101", 100, { first: 1, last: 100, clipped: true }],
    // leading zeros are still decimal line numbers
    ["007-010", 100, { first: 7, last: 10, clipped: false }],
  ])("%s of %i lines", (selector, total, expected) => {
    expect(selectLines(selector, total)).toEqual({ ok: true, total, ...expected });
  });

  test.each([
    ["", "is not a line range"],
    ["abc", "is not a line range"],
    ["5-16,960-973", "is not a line range"],
    ["1:80", "is not a line range"],
    ["0x10-0x20", "is not a line range"],
    ["1.5-3", "is not a line range"],
    ["NaN", "is not a line range"],
    ["Infinity", "is not a line range"],
    ["-", "is not a line range"],
    ["+5", "is not a line range"],
    ["--5", "is not a line range"],
    [" 1-5", "is not a line range"],
    ["12345678", "is not a line range"],
    ["1-12345678", "is not a line range"],
    ["0", "starts at line 0"],
    ["0-5", "starts at line 0"],
    ["-0", "asks for no lines"],
    ["5+0", "asks for no lines"],
    ["5+", "no line count"],
    ["101", "starts past the end: the listing has 100 lines"],
    ["101-200", "starts past the end"],
    ["80-1", "ends before it starts"],
  ])("refuses %j", (selector, fragment) => {
    const r = selectLines(selector, 100);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(fragment);
  });

  test("every form names the forms that work", () => {
    const r = selectLines("abc", 100);
    expect(!r.ok && r.error).toContain("N-M");
  });

  test("an empty listing has no lines to select", () => {
    expect(selectLines("1-5", 0)).toEqual({ ok: false, error: "the listing is empty" });
    expect(selectLines("-5", 0)).toEqual({ ok: false, error: "the listing is empty" });
  });
});
