import { describe, expect, test } from "vitest";
import { RegisterFile } from "../src/registers.js";

function build(...inputs: Array<[string, string?]>) {
  return RegisterFile.from(inputs.map(([register, value]) => ({ register, value })));
}

describe("RegisterFile", () => {
  test("AX splits into AH/AL", () => {
    const r = build(["AX", "0x4C0A"]);
    expect(r.ok && [r.regs.get("AH"), r.regs.get("AL"), r.regs.get("AX")]).toEqual([0x4c, 0x0a, 0x4c0a]);
  });
  test("halves assemble into the word", () => {
    const r = build(["ah", "0x4C"], ["al", "0Ah"]);
    expect(r.ok && r.regs.get("AX")).toBe(0x4c0a);
  });
  test("a single half leaves the word unknown", () => {
    const r = build(["AH", "0x4C"]);
    expect(r.ok && [r.regs.get("AH"), r.regs.get("AL"), r.regs.get("AX"), r.regs.has("AX")]).toEqual([0x4c, undefined, undefined, false]);
  });
  test("consistent duplicates are fine, conflicts reported", () => {
    expect(build(["AX", "0x4C0A"], ["AH", "0x4C"]).ok).toBe(true);
    const bad = build(["AX", "0x4C0A"], ["AH", "0x4B"]);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors[0]).toContain("AH");
    expect(build(["ES", "0xA000"], ["ES", "0xB800"]).ok).toBe(false);
  });
  test("both marker styles agree; boundaries accepted; bare digits rejected", () => {
    const a = build(["AX", "0x4C0A"]);
    const b = build(["AX", "4C0Ah"]);
    expect(a.ok && a.regs.get("AX")).toBe(0x4c0a);
    expect(b.ok && b.regs.get("AX")).toBe(0x4c0a);
    expect(build(["AL", "0xFF"]).ok && build(["AX", "0xFFFF"]).ok && build(["EAX", "0xFFFFFFFF"]).ok).toBe(true);
    expect(build(["AL", "0x0"]).ok).toBe(true);
    expect(build(["AL", "255"]).ok).toBe(false);
    expect(build(["AL", "0"]).ok).toBe(false);
  });
  test("EAX uses the low word", () => {
    const r = build(["EAX", "0x12344C0A"]);
    expect(r.ok && r.regs.get("AX")).toBe(0x4c0a);
  });
  test("pointer registers keep word values", () => {
    const r = build(["ES", "0xA000"]);
    expect(r.ok && r.regs.get("ES")).toBe(0xa000);
  });
  test("register without value is recorded as unvalued", () => {
    const r = build(["CX"], ["DX", " "]);
    expect(r.ok && r.regs.unvalued).toEqual(["CX", "DX"]);
  });
  test.each([
    ["AH", "256"], // bare
    ["AH", "0x100"],
    ["AX", "0x10000"],
    ["EAX", "0x100000000"],
    ["AH", "4C"], // hex letters without marker
    ["AX", "$4C0A"],
    ["AL", "-1"],
    ["AL", "NaN"],
    ["AX", "Infinity"],
    ["BH", "zz"],
  ])("rejects %s=%s", (reg, val) => {
    expect(build([reg, val]).ok).toBe(false);
  });
  test("unknown register and non-string register", () => {
    const r = build(["FOO", "1"]);
    expect(!r.ok && r.errors[0]).toContain("unknown register");
    const r2 = RegisterFile.from([{ register: 5 as unknown as string, value: "1" }]);
    expect(r2.ok).toBe(false);
  });
  test("collects every error", () => {
    const r = build(["AH", "999"], ["XX", "1"]);
    expect(!r.ok && r.errors).toHaveLength(2);
  });
});
