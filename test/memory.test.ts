import { describe, expect, test } from "vitest";
import { lookupMemory, parseAddress, renderMemoryDoc } from "../src/memory/lookup.js";

function ok(input: string) {
  const r = lookupMemory(input);
  if (!r.ok) throw new Error(r.error);
  return r.output;
}

describe("parseAddress", () => {
  test.each([
    ["0xA000", 0xa0000],
    ["A000h", 0xa0000],
    ["0xFFFF", 0xffff0], // largest segment
    ["0x10000", 0x10000], // first value that is read as a linear address
    ["0xFFFFF", 0xfffff],
    ["0xB8000", 0xb8000],
    ["0x0A0000", 0xa0000], // leading zero => 6 digits => linear
    ["B800:0160", 0xb8160],
    ["0040:006C", 0x46c],
    ["FFFF:0010", 0x100000],
    ["FFFF:FFFF", 0x10ffef], // last addressable byte, inclusive
    ["0x10FFEF", 0x10ffef],
    ["0x0", 0],
  ])("%s -> %s", (input, linear) => {
    const r = parseAddress(input);
    expect(r.ok && r.addr.linear).toBe(linear);
  });
  test.each([
    "", "A000", "FFFF", "40960", "0", "0x110000", "0x10FFF0", "-1", "NaN", "Infinity", "-Infinity", "1:2:3", "A000:", ":0010", "G000:0000", "10000:0000", "A000:10000",
  ])("rejects %j", (input) => {
    expect(parseAddress(input).ok).toBe(false);
  });
  test("FFFF:0010 + 1 past the limit", () => {
    expect(parseAddress("FFFF:FFFF").ok).toBe(true);
    expect(parseAddress("FFFF:10000").ok).toBe(false);
  });
  test("non-string", () => {
    expect(parseAddress(0xa000).ok).toBe(false);
  });
  test("SEG:OFF parts are hex even without markers, markers also accepted", () => {
    expect(parseAddress("B800:0160")).toMatchObject({ ok: true, addr: { linear: 0xb8160 } });
    expect(parseAddress("0xB800:0x160")).toMatchObject({ ok: true, addr: { linear: 0xb8160 } });
    expect(parseAddress("B800h:160h")).toMatchObject({ ok: true, addr: { linear: 0xb8160 } });
  });
  test("bare 16-bit reads as segment and keeps the linear alternative", () => {
    const r = parseAddress("0x0449");
    expect(r.ok && r.addr.alternative).toBe(0x449);
    const l = parseAddress("0xB8000");
    expect(l.ok && l.addr.alternative).toBeUndefined();
  });
});

describe("lookupMemory", () => {
  test("A0F8 tolerance lands in the A000 graphics segment", () => {
    const o = ok("0xA0F8");
    expect(o.role).toMatch(/EGA\/VGA/);
    expect(o.offset).toBe("A0F8:0000");
    expect(o.documentation).toContain("A000:0000");
    expect(o.linear_address).toBe("A0F80");
  });
  test.each([
    ["0xA000", /EGA\/VGA graphics/],
    ["0xB000", /Monochrome/],
    ["0xB800", /Colour text/],
    ["0xBFFF", /Colour text/],
    ["0xC000", /Video adapter BIOS/],
    ["0xF000", /System BIOS/],
    ["FFFF:0010", /High Memory/],
    ["0000:0000", /Interrupt Vector/],
    ["0xD000", /Upper memory/],
  ])("%s range", (input, re) => {
    expect(ok(input).matched_range).toMatch(re);
  });
  test("region boundaries are inclusive", () => {
    expect(ok("A000:FFFF").matched_range).toMatch(/EGA\/VGA/);
    expect(ok("B000:0000").matched_range).toMatch(/Monochrome/);
    expect(ok("AFFF:000F").matched_range).toMatch(/EGA\/VGA/);
    expect(ok("B7FF:000F").matched_range).toMatch(/Monochrome/);
    expect(ok("B800:0000").matched_range).toMatch(/Colour text/);
  });
  test("IVT slot names the vector and byte", () => {
    const o = ok("0000:0086");
    expect(o.documentation).toContain("vector 21h");
    expect(o.documentation).toContain("segment (CS)");
    expect(ok("0000:03FF").documentation).toContain("vector FFh");
  });
  test("BDA fields resolve, including mid-field offsets", () => {
    expect(ok("0040:0049").documentation).toMatch(/Current video mode/);
    expect(ok("0040:006C").documentation).toMatch(/timer|clock|tick/i);
    expect(ok("0040:004B").documentation).toMatch(/Number of screen columns|columns/);
    expect(ok("0x0040:0x4A").documentation).toBeDefined();
  });
  test("linear inputs echo a natural segment:offset", () => {
    expect(ok("0xB8160").offset).toBe("B800:0160");
    expect(ok("0x00449").documentation).toMatch(/Current video mode/);
  });
  test("bare low value mentions the linear alternative", () => {
    expect(ok("0x0449").documentation).toContain("Also possible");
  });
  test("boot sector landmark", () => {
    expect(ok("0000:7C00").documentation).toContain("Boot sector");
  });
  test("ROM font landmark and machine id", () => {
    expect(ok("F000:FA6E").documentation).toContain("8x8 character table");
    expect(ok("FFFF:000E").documentation).toContain("Machine ID");
  });
  test("errors surface as ok:false", () => {
    expect(lookupMemory("nonsense")).toMatchObject({ ok: false });
    expect(lookupMemory("0x200000")).toMatchObject({ ok: false });
  });
});

describe("renderMemoryDoc", () => {
  test.each(["bda", "psp", "video-modes", "ivt", "ega-vga-graphics", "hma"])("%s renders", (id) => {
    expect(renderMemoryDoc(id)?.length).toBeGreaterThan(100);
  });
  test("unknown id", () => {
    expect(renderMemoryDoc("nope")).toBeUndefined();
  });
  test("PSP table has the command tail and video modes include 13h", () => {
    expect(renderMemoryDoc("psp")).toMatch(/80\s+byte\s+count of characters in command tail/);
    expect(renderMemoryDoc("video-modes")).toMatch(/13h = G/);
  });
});
