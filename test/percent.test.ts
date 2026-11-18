import { describe, expect, test } from "vitest";
import { percentDown } from "../src/percent.js";

describe("percentDown", () => {
  test.each([
    // the ends: only exactly 1 reads 100%, only 0 reads 0%
    [1, "100%"],
    [0, "0%"],
    // out of range and non-numbers
    [Number.NaN, "0%"],
    [-1, "0%"],
    [Number.NEGATIVE_INFINITY, "0%"],
    [1.5, "100%"],
    [Number.POSITIVE_INFINITY, "100%"],
    // near 100% never rounds up
    [1196 / 1198, "99.8%"],
    [1197 / 1198, "99.9%"],
    [0.996, "99.6%"],
    [0.9999, "99.9%"],
    [1 - 1e-6, "99.9%"],
    [1 / 1198, "0.08%"],
    [0.004, "0.4%"],
    [1e-5, "0.001%"],
    // the band edges: one decimal below 10% and from 90%, whole numbers between
    [0.0999, "9.9%"],
    [0.1, "10%"],
    [0.8999, "89%"],
    [0.9, "90.0%"],
    // rounds down in the middle, and float error does not drop a whole value
    [2 / 3, "66%"],
    [0.5, "50%"],
    [0.29, "29%"],
    [0.57, "57%"],
  ])("%s reads %s", (fraction, text) => {
    expect(percentDown(fraction)).toBe(text);
  });
});
