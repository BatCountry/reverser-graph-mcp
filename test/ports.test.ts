import { describe, expect, test } from "vitest";
import { lookupPort, PORT_DOC_IDS, renderPortDoc } from "../src/ports/lookup.js";
import { decodeFields, type Field } from "../src/ports/registers.js";

function ok(input: { port: string; index?: string; value?: string }) {
  const r = lookupPort(input);
  if (!r.ok) throw new Error(r.error);
  return r.output;
}

describe("indexed registers", () => {
  test("16-bit OUT to the sequencer index port carries index and data", () => {
    const o = ok({ port: "0x3C4", value: "0x0F02" });
    expect(o.role).toContain("Map Mask");
    expect(o.documentation).toContain("AL=0x02");
    expect(o.documentation).toContain("AH=0x0F");
    expect(o.documentation).toContain("plane 0, plane 1, plane 2, plane 3");
  });
  test("index byte alone selects a register", () => {
    expect(ok({ port: "0x3C4", value: "0x02" }).role).toContain("selects Map Mask");
    expect(ok({ port: "0x3CE", value: "0x5" }).role).toContain("Mode Register");
  });
  test("data port needs an index, then decodes the value", () => {
    expect(ok({ port: "0x3C5" }).documentation).toContain("Provide `index`");
    const o = ok({ port: "0x3CF", index: "0x05", value: "0x02" });
    expect(o.role).toContain("Mode Register");
    expect(o.documentation).toContain("write mode = 2");
  });
  test("map mask decode: single plane, none, all", () => {
    expect(ok({ port: "0x3C5", index: "0x2", value: "0x04" }).documentation).toContain("writes reach plane 2");
    expect(ok({ port: "0x3C5", index: "0x2", value: "0x0" }).documentation).toContain("no plane writable");
    expect(ok({ port: "0x3C5", index: "0x2", value: "0xFF" }).documentation).toContain("plane 3"); // upper bits ignored
  });
  test("undocumented index is reported, not invented", () => {
    const o = ok({ port: "0x3C5", index: "0x99", value: "0x1" });
    expect(o.access).toBe("unknown");
    expect(o.documentation).toContain("not a documented");
  });
  test("CRTC mirrors decode to 3D4/3D5 and mono/colour pairs both work", () => {
    expect(ok({ port: "0x3D1" }).documentation).toContain("decodes to 0x3D5");
    expect(ok({ port: "0x3B4", value: "0x0C" }).role).toContain("Start Address High");
    expect(ok({ port: "0x3D5", index: "0x13", value: "0x28" }).role).toContain("Offset");
    expect(ok({ port: "0x3D1" }).documentation).toContain("0x3D4");
  });
  test("attribute controller: address vs data phase", () => {
    const addr = ok({ port: "0x3C0", value: "0x20" });
    expect(addr.documentation).toContain("selects register 0x00");
    expect(addr.documentation).toContain("keeps the screen on");
    expect(ok({ port: "0x3C0", value: "0x00" }).documentation).toContain("blanks the screen");
    expect(ok({ port: "0x3C0", index: "0x13", value: "0x4" }).role).toContain("Horizontal Pel Panning");
    expect(ok({ port: "0x3C1", index: "0x10" }).access).toBe("read");
    expect(ok({ port: "0x3C0" }).documentation).toContain("flip-flop");
  });
});

describe("single ports", () => {
  test("3DA vsync bit and value decoding", () => {
    const o = ok({ port: "0x3DA", value: "0x08" });
    expect(o.documentation).toContain("bit 3 vertical retrace = 1");
    expect(o.documentation).toContain("verify against the disassembly");
  });
  test("PIC mask decodes per IRQ", () => {
    const o = ok({ port: "0x21", value: "0x02" });
    expect(o.documentation).toContain("IRQ1 = 1: masked");
    expect(o.documentation).toContain("IRQ0 = 0: enabled");
  });
  test("joystick buttons are active-low", () => {
    expect(ok({ port: "0x201", value: "0xEF" }).documentation).toContain("A button 1 = 0: PRESSED");
  });
  test("SN76496 latch and continuation bytes", () => {
    expect(ok({ port: "0xC0", value: "0x9F" }).documentation).toContain("OFF (silent)");
    expect(ok({ port: "0xC0", value: "0x8E" }).documentation).toContain("tone 0 frequency divider");
    expect(ok({ port: "0xC0", value: "0x0F" }).documentation).toContain("continuation byte");
    expect(ok({ port: "0xC0", value: "0xE7" }).documentation).toContain("white noise, rate 3");
    expect(ok({ port: "0xC0", value: "0xE0" }).documentation).toContain("periodic noise");
    expect(ok({ port: "0xC5" }).documentation).toContain("decodes to 0x0C0");
    expect(ok({ port: "0xC0", value: "0x1FF" }).documentation).toContain("single bytes");
  });
  test("PIT mode register fields", () => {
    const o = ok({ port: "0x43", value: "0xB6" });
    expect(o.documentation).toContain("counter select = 2: counter 2");
    expect(o.documentation).toContain("mode 3 square wave");
  });
  test("both marker styles agree", () => {
    expect(ok({ port: "3C4h" })).toEqual(ok({ port: "0x3C4" }));
  });
});

describe("fallbacks and input validation", () => {
  test("Bundled port ranges cover ports without an authored entry", () => {
    const o = ok({ port: "0x378" });
    expect(o.documentation).toContain("Second Parallel Printer");
  });
  test("unknown port is answered honestly", () => {
    expect(ok({ port: "0x999" }).role).toContain("Not in the bundled");
  });
  test.each([
    [{ port: "3C4" }, "no hex marker"],
    [{ port: "-1" }, "not a number"],
    [{ port: "NaN" }, "not a number"],
    [{ port: "964" }, "Bare digits are ambiguous"],
    [{ port: "0x10000" }, "above the maximum"],
    [{ port: "0x3C4", index: "0x100" }, "above the maximum"],
    [{ port: "0x3C4", index: "2" }, "Bare digits are ambiguous"],
    [{ port: "0x3C4", value: "15" }, "Bare digits are ambiguous"],
    [{ port: "0x3C4", value: "0x10000" }, "above the maximum"],
    [{ port: "0x3C4", value: "Infinity" }, "not a number"],
    [{ port: "" }, "empty"],
  ])("rejects %j", (input, fragment) => {
    const r = lookupPort(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(fragment);
  });
  test("boundaries 0 and FFFFh are accepted", () => {
    expect(lookupPort({ port: "0x0" }).ok).toBe(true);
    expect(lookupPort({ port: "0xFFFF" }).ok).toBe(true);
  });
});

describe("decodeFields", () => {
  const f: Field[] = [{ hi: 0, lo: 0, name: "flag", set: "on" }, { hi: 2, lo: 1, name: "pair", values: { 1: "one" } }, { hi: 3, lo: 3, name: "both", set: "s", clear: "c" }];
  test("clear flags without a clear meaning are omitted, multi-bit unknowns print the number", () => {
    expect(decodeFields(f, 0)).toEqual(["bit 3 both = 0: c", "bits 2-1 pair = 0: value 0"]);
    expect(decodeFields(f, 0b1011)).toEqual(["bit 3 both = 1: s", "bits 2-1 pair = 1: one", "bit 0 flag = 1: on"]);
    expect(decodeFields(undefined, 5)).toEqual([]);
  });
});

describe("resources", () => {
  test.each(PORT_DOC_IDS)("%s renders", (id) => {
    expect(renderPortDoc(id)?.length).toBeGreaterThan(100);
  });
  test("unknown group", () => {
    expect(renderPortDoc("nope")).toBeUndefined();
  });
});
