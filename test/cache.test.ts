import { describe, expect, test } from "vitest";
import { TtlCache } from "../src/cache.js";

const doc = (text: string) => ({ title: "t", description: "d", mimeType: "text/markdown", text });

describe("TtlCache", () => {
  test("hit, miss and expiry", () => {
    let now = 1000;
    const c = new TtlCache(() => now);
    const h = c.put(doc("a"), 100);
    expect(c.get(h)?.text).toBe("a");
    expect(c.get("nope")).toBeUndefined();
    now += 100; // exactly at expiry => gone
    expect(c.get(h)).toBeUndefined();
  });
  test("a read slides the expiry window", () => {
    let now = 0;
    const c = new TtlCache(() => now);
    const h = c.put(doc("a"), 100);
    now = 99;
    expect(c.get(h)).toBeDefined();
    now = 198;
    expect(c.get(h)).toBeDefined();
    now = 298;
    expect(c.get(h)).toBeUndefined();
  });
  test("deterministic keys refresh in place", () => {
    let now = 0;
    const c = new TtlCache(() => now);
    expect(c.put(doc("a"), 100, "k")).toBe("k");
    now = 90;
    c.put(doc("b"), 100, "k");
    now = 150;
    expect(c.get("k")?.text).toBe("b");
    expect(c.size).toBe(1);
  });
  test.each([0, -1, NaN, Infinity, -Infinity])("rejects ttl %s", (ttl) => {
    expect(() => new TtlCache().put(doc("a"), ttl)).toThrow(RangeError);
  });
  test("evicts oldest beyond capacity", () => {
    const c = new TtlCache(() => 0, 2);
    const a = c.put(doc("a"), 10);
    c.put(doc("b"), 10);
    const third = c.put(doc("c"), 10);
    expect(c.get(a)).toBeUndefined();
    expect(c.get(third)?.text).toBe("c");
    expect(c.size).toBe(2);
  });
  test("random handles are unique", () => {
    const c = new TtlCache();
    expect(c.put(doc("a"), 10)).not.toBe(c.put(doc("a"), 10));
  });
});
