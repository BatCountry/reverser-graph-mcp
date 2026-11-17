import { describe, expect, test } from "vitest";
import { formatHex, hexKey, parseHexKey, parseInterruptNumber, parseNumber } from "../src/hex.js";

describe("parseNumber", () => {
  test.each([
    ["0x4C", 0x4c],
    ["0X4c", 0x4c],
    ["4Ch", 0x4c],
    ["4CH", 0x4c],
    ["0Ah", 10],
    ["FFh", 255],
    ["0xFF", 255], // exact boundary
    ["0x00FF", 255],
    ["  0x4C  ", 0x4c],
    ["0x4_C", 0x4c],
    ["0x0", 0],
    ["0h", 0],
    ["10h", 16],
  ])("accepts %s", (input, value) => {
    expect(parseNumber(input, 255)).toMatchObject({ ok: true, value });
  });

  test("reports digit count without the marker", () => {
    expect(parseNumber("0x00FF", 255)).toMatchObject({ digits: 4 });
    expect(parseNumber("12h", 255)).toMatchObject({ digits: 2 });
  });

  test.each([
    ["", "empty"],
    ["   ", "empty"],
    ["0x", "not a number"],
    ["h", "not a number"],
    ["$4C", "not a number"],
    ["-1", "not a number"],
    ["-0x1", "not a number"],
    ["+1", "not a number"],
    ["1.5", "not a number"],
    ["NaN", "not a number"],
    ["Infinity", "not a number"],
    ["-Infinity", "not a number"],
    ["0xZZ", "not a number"],
    ["0x4Ch", "not a number"], // both markers
    ["4 C", "not a number"],
    ["76", "Bare digits are ambiguous"],
    ["21", "Bare digits are ambiguous"],
    ["0", "Bare digits are ambiguous"],
    ["076", "Bare digits are ambiguous"],
    ["4C", "Hex letters need a hex marker"],
    ["ff", "Hex letters need a hex marker"],
    ["1e3", "Hex letters need a hex marker"],
    ["0x100", "above the maximum"], // boundary + 1
    ["100h", "above the maximum"],
    ["0x" + "0".repeat(13), "too long"],
    ["0x" + "F".repeat(30), "too long"],
  ])("rejects %j (%s)", (input, fragment) => {
    const r = parseNumber(input, 0xff, "x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(fragment);
  });

  test("the error for a bare number shows the marked spelling to use", () => {
    const r = parseNumber("21", 0xff);
    expect(!r.ok && r.error).toContain("write 0x21 or 21h");
    const hexy = parseNumber("4c", 0xff);
    expect(!hexy.ok && hexy.error).toContain("write 0x4C or 4Ch");
  });

  test.each([undefined, null, 5, NaN, Infinity, {}, []])("rejects non-string %j", (input) => {
    expect(parseNumber(input, 0xff).ok).toBe(false);
  });

  test("20-bit maximum is inclusive", () => {
    expect(parseNumber("0x10FFEF", 0x10ffef)).toMatchObject({ ok: true, value: 0x10ffef });
    expect(parseNumber("0x10FFF0", 0x10ffef).ok).toBe(false);
  });
});

describe("parseHexKey", () => {
  test.each([
    ["4C", 0x4c],
    ["0160", 0x160],
    ["0x4C", 0x4c],
    ["4Ch", 0x4c],
    ["FFFF", 0xffff],
  ])("accepts %s", (input, value) => {
    expect(parseHexKey(input, 0xffff)).toMatchObject({ ok: true, value });
  });
  test.each(["", "G0", "-1", "NaN", "10000", "1".repeat(13)])("rejects %j", (input) => {
    expect(parseHexKey(input, 0xffff).ok).toBe(false);
  });
  test("non-string", () => {
    expect(parseHexKey(5, 0xff).ok).toBe(false);
  });
});

describe("parseInterruptNumber", () => {
  test.each([
    ["0x10", 0x10],
    ["10h", 0x10],
    ["INT 21h", 0x21],
    ["int 0x21", 0x21],
    ["Interrupt 0x33", 0x33],
    ["0x0", 0],
    ["FFh", 255],
  ])("accepts %s", (input, value) => {
    expect(parseInterruptNumber(input)).toMatchObject({ ok: true, value });
  });
  test.each(["", "INT", "0x100", "256", "33", "INT 21", "255", "0", "-1", "NaN", "INT 2 1", "21h5", "FF"])("rejects %j", (input) => {
    expect(parseInterruptNumber(input).ok).toBe(false);
  });
  test("rejects non-strings", () => {
    expect(parseInterruptNumber(0x21).ok).toBe(false);
  });
});

test("formatters", () => {
  expect(formatHex(0xa, 2)).toBe("0x0A");
  expect(formatHex(0xabcde, 0)).toBe("0xABCDE");
  expect(hexKey(5)).toBe("05");
  expect(hexKey(0x1234, 4)).toBe("1234");
});
