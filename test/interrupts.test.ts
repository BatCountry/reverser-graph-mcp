import { beforeAll, describe, expect, test } from "vitest";
import { TtlCache } from "../src/cache.js";
import { getInterruptDb } from "../src/interrupts/db.js";
import { lookupInterrupt, type InterruptOutput } from "../src/interrupts/lookup.js";
import { renderEntry, renderFunctionFamily, renderInterruptOverview } from "../src/interrupts/render.js";

const db = getInterruptDb();
let cache: TtlCache;
beforeAll(() => {
  cache = new TtlCache();
});

function run(interrupt: unknown, registers?: Array<{ register: string; value?: string }>): InterruptOutput {
  const r = lookupInterrupt(db, cache, { interrupt, registers });
  if (!r.ok) throw new Error(r.error);
  return r.output;
}
const fail = (interrupt: unknown, registers?: Array<{ register: string; value?: string }>) =>
  lookupInterrupt(db, cache, { interrupt, registers });

describe("exact matches", () => {
  test("INT 21h AX=4C0A -> terminate with return code, AH and AL both understood", () => {
    const o = run("0x21", [{ register: "AX", value: "0x4C0A" }]);
    expect(o.interrupt).toBe("Interrupt 21h - MS-DOS Function Calls");
    expect(o.register_invocation_documentation).toContain("TERMINATE WITH RETURN CODE");
    const ah = o.register_inputs.find((r) => r.register === "AH");
    const al = o.register_inputs.find((r) => r.register === "AL");
    expect(ah?.value).toMatch(/^0x4C matched/);
    expect(al?.value).toMatch(/^0x0A \(as supplied\)/);
    expect(o.complete_documentation).toContain("dosref://entry/214C");
    expect(o.complete_documentation).toContain("dosref://notes/walkthrough/21/4C");
  });
  test("AH alone is enough for an AH-keyed function", () => {
    const o = run("21h", [{ register: "AH", value: "0x3D" }]);
    expect(o.register_invocation_documentation).toMatch(/OPEN/);
    expect(o.register_outputs.some((r) => r.register === "CF")).toBe(true);
  });
  test("mouse is AX-keyed: AX=3 is position and button status, not AH=00 family", () => {
    const o = run("INT 33h", [{ register: "AX", value: "0x3" }]);
    expect(o.register_invocation_documentation).toContain("INT 33h AX=0003h");
    expect(o.register_invocation_documentation).toMatch(/POSITION AND BUTTON STATUS/);
    expect(o.register_outputs.map((r) => r.register)).toEqual(["BX", "CX", "DX"]);
  });
  test("single-service interrupt answers without registers", () => {
    const o = run("0x12");
    expect(o.register_invocation_documentation).toMatch(/GET MEMORY SIZE/);
    expect(o.register_outputs[0]?.register).toBe("AX");
  });
  test("INT 10h AH=00 returns set video mode and links to the mode table", () => {
    const o = run("0x10", [{ register: "AH", value: "0x0" }, { register: "AL", value: "0x13" }]);
    expect(o.register_invocation_documentation).toMatch(/SET VIDEO MODE/);
    expect(o.register_inputs.find((r) => r.register === "AL")?.value).toContain("0x13");
  });
  test("IOCTL sub-function selects the AL-qualified entry", () => {
    const o = run("0x21", [{ register: "AX", value: "0x4400" }]);
    expect(o.register_invocation_documentation).toMatch(/IOCTL/);
  });
});

describe("family level and misses", () => {
  test("no registers: AH-keyed list with the discriminating register named", () => {
    const o = run("0x21");
    expect(o.register_inputs[0]?.register).toBe("AH");
    expect(o.tool_hint).toContain("AH=0x00");
    expect(o.complete_documentation).toContain("dosref://interrupt/21");
    expect(o.register_outputs).toEqual([]);
  });
  test("mouse family names AX", () => {
    expect(run("0x33").register_inputs[0]?.register).toBe("AX");
    expect(run("0x33").tool_hint).toContain("AX=0x0000");
  });
  test("AH value no source documents does not invent a match", () => {
    const o = run("0x21", [{ register: "AH", value: "0x74" }]);
    expect(o.register_invocation_documentation).toMatch(/No documented INT 21h function/);
    expect(o.register_inputs[0]?.register).toBe("AH");
  });
  test("vendor-only function numbers still resolve (NetWare AH=EEh) and are flagged by title", () => {
    const o = run("0x21", [{ register: "AH", value: "0xEE" }]);
    expect(o.register_invocation_documentation).toMatch(/NetWare/i);
  });
  test("interrupt outside the bundled set is answered, not an error", () => {
    const o = run("0xF0");
    expect(o.interrupt).toContain("not covered");
    expect(o.tool_hint).toContain("0000:03C0");
  });
  test("registers omitted vs empty list are equivalent", () => {
    expect(run("0x21", [])).toEqual(run("0x21"));
  });
});

describe("untrusted input", () => {
  test.each([
    ["", "interrupt"],
    ["0x100", "above the maximum"],
    ["256", "Bare digits are ambiguous"],
    ["21", "Bare digits are ambiguous"],
    ["-1", "not a number"],
    ["NaN", "not a number"],
    ["Infinity", "not a number"],
    ["FF", "no hex marker"],
    [undefined, "expected a string"],
    [21, "expected a string"],
  ])("interrupt %j", (input, fragment) => {
    const r = fail(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(fragment);
  });
  test.each([
    [[{ register: "AH", value: "256" }], "Bare digits are ambiguous"],
    [[{ register: "AH", value: "0x100" }], "above the maximum"],
    [[{ register: "AX", value: "0x10000" }], "above the maximum"],
    [[{ register: "AH", value: "3D" }], "no hex marker"],
    [[{ register: "AH", value: "-1" }], "not a number"],
    [[{ register: "AL", value: "NaN" }], "not a number"],
    [[{ register: "XX", value: "1" }], "unknown register"],
    [[{ register: "AX", value: "0x4C0A" }, { register: "AH", value: "0x4B" }], "both"],
  ])("registers %j", (regs, fragment) => {
    const r = fail("0x21", regs);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(fragment);
  });
  test("boundary values are accepted", () => {
    expect(fail("0xFF").ok).toBe(true);
    expect(fail("255").ok).toBe(false);
    expect(fail("0x00").ok).toBe(true);
    expect(fail("0x21", [{ register: "AH", value: "0xFF" }]).ok).toBe(true);
    expect(fail("0x21", [{ register: "AH", value: "255" }]).ok).toBe(false);
    expect(fail("0x21", [{ register: "AH", value: "00h" }]).ok).toBe(true);
  });
});

describe("number markers", () => {
  test("both marker styles give the same answer", () => {
    const hex = run("0x21", [{ register: "AH", value: "0x4C" }]);
    expect(run("21h", [{ register: "AH", value: "4Ch" }])).toEqual(hex);
  });
  test('bare "21" is refused with the spelling to use, never silently read as INT 15h', () => {
    const r = fail("INT 21");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("write 0x21 or 21h");
  });
});

describe("handles", () => {
  test("ambiguous queries return a cached ranked handle", () => {
    const o = run("0x21", [{ register: "AH", value: "0x3D" }]);
    const m = /dosref:\/\/query\/([\w-]+)/.exec(o.complete_documentation);
    expect(m).not.toBeNull();
    expect(cache.get(m![1]!)?.text).toContain("INT 21h");
  });
});

describe("renderers", () => {
  test("overview lists AH groups, family lists variants, entry shows registers", () => {
    expect(renderInterruptOverview(db, "21")).toMatch(/AH=4Ch/);
    expect(renderInterruptOverview(db, "33")).toMatch(/AX=0003h/);
    expect(renderFunctionFamily(db, "21", 0x3d)).toMatch(/dosref:\/\/entry\/213D/);
    const e = db.byId.get("213D")!;
    const text = renderEntry(e);
    expect(text).toContain("DS:DX");
    expect(text).toContain("_Entry 213D._");
  });
});
