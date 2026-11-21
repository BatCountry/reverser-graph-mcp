import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { TtlCache } from "../src/cache.js";
import { INLINE_DIRECT, INLINE_OTHER, lookupDataReferences, parseDataAddress, renderDataReferencesText, TABLE_REACH, type DataReference } from "../src/graph/datarefs.js";
import { CallGraph } from "../src/graph/model.js";
import type { Context } from "../src/graph/tools.js";
import { ProgressStore } from "../src/progress/store.js";
import { makeFixture } from "./fixture.js";

type Row = Omit<DataReference, "program">;
const row = (segment: string | null, offset: number, access = "reads", n = 0, extra: Partial<Row> = {}): Row => ({
  segment, register: "ds", offset, indexed: false, access, function: `MAIN_EXE:${(0x100 + n).toString(16).padStart(4, "0")}`,
  site: `MAIN_EXE:${(0x104 + n).toString(16).padStart(4, "0")}`, instruction: `mov ax, word ptr [${offset.toString(16)}h]`, ...extra,
});

/** A tree whose data_references.json holds `programs`; `undefined` leaves the file out. */
function tree(programs: Record<string, Row[]> | undefined): Context {
  const fx = makeFixture();
  const file = path.join(fx.disassembly, "navigation", "data_references.json");
  if (programs) writeFileSync(file, JSON.stringify(programs));
  else rmSync(file);
  return { graph: CallGraph.load(fx.disassembly), disassemblyRoot: fx.disassembly, progress: new ProgressStore(fx.progressFile), cache: new TtlCache() };
}

const ok = (ctx: Context, address: string, full = false) => {
  const r = lookupDataReferences(ctx, { address }, full);
  if (!r.ok) throw new Error(r.error);
  return r.output;
};
const error = (ctx: Context, address: string) => {
  const r = lookupDataReferences(ctx, { address });
  return r.ok ? "" : r.error;
};

describe("parseDataAddress", () => {
  test.each([
    ["ds:4f2a", "ds", 0x4f2a],
    ["  DS : [4F2A] ", "ds", 0x4f2a],
    ["ds:0x4f2a", "ds", 0x4f2a],
    ["ds:4f2ah", "ds", 0x4f2a],
    ["[0x4f2a]", "ds", 0x4f2a],
    ["[4f2a]", "ds", 0x4f2a],
    ["word ptr [0x4f2a]", "ds", 0x4f2a],
    ["mov word ptr [0x4f2a], ax", "ds", 0x4f2a],
    ["0x4f2a", "ds", 0x4f2a],
    ["4F2Ah", "ds", 0x4f2a],
    ["ds:0", "ds", 0],
    ["ds:fffff", "ds", 0xfffff],
    ["0714h:[0124]", "0714h", 0x124],
    ["714:0124", "0714h", 0x124],
    ["0x714:0x124", "0714h", 0x124],
    ["0:[10]", "0000h", 0x10],
    ["MAIN_OVR-0020:[000f]", "main_ovr-0020", 0xf],
    ["MAIN_OVR-0020:000f", "main_ovr-0020", 0xf],
    ["12345h:10", "12345h", 0x10], // five digits: no paragraph, so a name no tree has
  ])("%s is %s:%i", (input, segment, offset) => {
    expect(parseDataAddress(input)).toEqual({ ok: true, segment, offset });
  });

  test.each(["cs:[0x40]", "mov ax, word ptr cs:[0x40]", "es:40", "SS:[40]", "fs:40", "gs:40", "any:0040"])("%s names a register, so any segment", (input) => {
    expect(parseDataAddress(input)).toEqual({ ok: true, segment: undefined, offset: 0x40 });
  });

  test.each([
    ["4f2a", "has no hex marker"],
    ["1234", "Bare digits are ambiguous"],
    ["", "empty value"],
    ["   ", "empty value"],
    ["ds:", "is not hex digits"],
    ["ds:zz", "is not hex digits"],
    ["ds:-1", "is not hex digits"],
    ["ds:1.5", "is not hex digits"],
    ["[di + 4]", "is not hex digits"],
    ["[]", "is not hex digits"],
    ["ds:100000", "above the maximum"],
    ["0x100000", "above the maximum"],
    ["ds:1234567890123", "too long"],
    [":4f2a", "has no segment before the colon"],
    ["NaN", "is not a number"],
    ["Infinity", "is not a number"],
  ])("%j is refused: %s", (input, why) => {
    const r = parseDataAddress(input);
    expect(r.ok ? "" : r.error).toContain(why);
    expect(r.ok ? "" : r.error).toContain("Give a data address: ds:4f2a");
  });
});

describe("lookupDataReferences", () => {
  test("a tree built before data references existed says how to get them", () => {
    expect(error(tree(undefined), "ds:4f2a")).toMatch(/^This tree has no .*navigation\/data_references\.json: it was built before .* Rebuild it with scripts\/build_callgraph\.py/);
  });

  test("an unparsable address is refused before the tree is read", () => {
    expect(error(tree(undefined), "4f2a")).toContain("has no hex marker");
  });

  test("writers come first, then by instruction address; the result counts by access", () => {
    const ctx = tree({ "MAIN.EXE": [row("ds", 0x4f20, "calls through", 2), row("ds", 0x4f20, "reads", 0), row("ds", 0x4f20, "writes", 4), row("ds", 0x4f20, "calls through", 1), row("ds", 0x4f22, "writes", 5)] });
    const o = ok(ctx, "lcall [0x4f20]");
    expect(o.address).toBe("ds:[4f20]");
    expect(o.result).toBe("4 instructions in 4 functions name ds:[4f20] by its address: writes 1, calls through 2, reads 1.");
    expect(o.references.split("\n")).toEqual([
      "ds:[4f20] in MAIN.EXE:",
      "- MAIN_EXE:0104 writes it at MAIN_EXE:0108: `mov ax, word ptr [4f20h]` — disasm://disassembly/module/MAIN_EXE%3A0104",
      "- MAIN_EXE:0101 calls through it at MAIN_EXE:0105: `mov ax, word ptr [4f20h]` — disasm://disassembly/module/MAIN_EXE%3A0101",
      "- MAIN_EXE:0102 calls through it at MAIN_EXE:0106: `mov ax, word ptr [4f20h]` — disasm://disassembly/module/MAIN_EXE%3A0102",
      "- MAIN_EXE:0100 reads it at MAIN_EXE:0104: `mov ax, word ptr [4f20h]` — disasm://disassembly/module/MAIN_EXE%3A0100",
    ]);
    expect(o.all_references).toBe("disasm://disassembly/data-references/ds%3A4f20");
    expect(o.other_ways_in).toMatch(/^Not listed at all: accesses through a pointer/);
  });

  test("one instruction, and two in one function, are counted in plain words", () => {
    const ctx = tree({ "MAIN.EXE": [row("ds", 0x10, "writes"), row("ds", 0x20, "reads", 0, { site: "MAIN_EXE:0200" }), row("ds", 0x20, "writes", 0, { site: "MAIN_EXE:0204" })] });
    expect(ok(ctx, "ds:10").result).toBe("1 instruction in 1 function names ds:[0010] by its address: writes 1.");
    expect(ok(ctx, "ds:20").result).toBe("2 instructions in 1 function name ds:[0020] by its address: writes 1, reads 1.");
  });

  test("an address nothing names says so and still says what cannot be seen", () => {
    const o = ok(tree({ "MAIN.EXE": [row("ds", 0x10)] }), "ds:12");
    expect([o.result, o.references]).toEqual(["No instruction names ds:[0012] by its address.", "None."]);
    expect(o.other_ways_in).toMatch(/^Not listed at all/);
  });

  test("a segment no reference names is refused with the segments there are", () => {
    const few = tree({ "MAIN.EXE": [row("ds", 0x10), row("0714h", 0x10), row(null, 0x10)] });
    expect(error(few, "0715:10")).toBe('No instruction names anything in segment "0715h". Segments with references: ds, 0714h. Give a data address: ds:4f2a, an operand or instruction as a listing shows it ([0x4f2a], mov ax, word ptr cs:[0x40]), or a segment as the server prints it (0714h:[0124], MAIN_OVR-0020:[000f]).');
    const many = tree({ "MAIN.EXE": Array.from({ length: 9 }, (_, i) => row(`000${i}h`, 0x10)) });
    expect(error(many, "nope:10")).toContain('in segment "nope". Segments with references: 0000h, 0001h, 0002h, 0003h, 0004h, 0005h, 0006h, 0007h, … (9 in all).');
    expect(ok(many, "ds:10").result).toBe("No instruction names ds:[0010] by its address."); // the data segment always exists
  });

  test("a space is matched whatever the case, and printed as the tree writes it", () => {
    const ctx = tree({ "MAIN.EXE": [row("MAIN_OVR-0020", 0xf)] });
    expect(ok(ctx, "main_ovr-0020:[000f]").address).toBe("MAIN_OVR-0020:[000f]");
    expect(ok(ctx, "MAIN_OVR-0020:f").result).toContain("1 instruction");
  });

  test(`a tool result shows ${INLINE_DIRECT} instructions across programs and links the rest; the resource shows all`, () => {
    const some = (n: number, from: number) => Array.from({ length: n }, (_, i) => row("ds", 0x100, "reads", from + i));
    const ctx = tree({ "A.EXE": some(INLINE_DIRECT - 2, 0), "B.EXE": some(3, 0x20), "C.EXE": some(1, 0x40) });
    const o = ok(ctx, "ds:100");
    const lines = o.references.split("\n");
    expect(lines.filter((l) => l.startsWith("- "))).toHaveLength(INLINE_DIRECT);
    expect(lines.filter((l) => l.endsWith(":"))).toEqual(["ds:[0100] in A.EXE:", "ds:[0100] in B.EXE:"]); // nothing of C.EXE fits
    expect(lines.at(-1)).toBe("… 2 more: disasm://disassembly/data-references/ds%3A0100");
    const full = ok(ctx, "ds:100", true).references.split("\n");
    expect(full.filter((l) => l.startsWith("- "))).toHaveLength(INLINE_DIRECT + 2);
    expect(full.filter((l) => l.endsWith(":"))).toHaveLength(3);
    expect(full.join("\n")).not.toContain("more:");
    const exact = ok(tree({ "A.EXE": some(INLINE_DIRECT, 0) }), "ds:100").references;
    expect(exact).not.toContain("more:");
  });

  test("an indexed operand based at the address is a table there, cut the same way", () => {
    const indexed = (n: number) => row("ds", 0x200, "reads", n, { indexed: true, instruction: "mov ax, word ptr [bx + 0x200]" });
    const ctx = tree({ "MAIN.EXE": [...Array.from({ length: INLINE_OTHER + 2 }, (_, i) => indexed(i)), row("0714h", 0x200, "reads", 0x30, { indexed: true })] });
    const o = ok(ctx, "ds:200");
    expect(o.result).toBe("No instruction names ds:[0200] by its address.");
    const [head, ...rest] = o.other_ways_in.split("\n\n")[0]!.split("\n");
    expect(head).toBe(`Indexed from this address (\`[register + 0200h]\`: a table that starts here, or this offset into whatever the register points at), ${INLINE_OTHER + 2} instructions:`);
    expect(rest).toHaveLength(INLINE_OTHER + 1);
    expect(rest[0]).toBe("  - MAIN_EXE:0100 reads it at MAIN_EXE:0104: `mov ax, word ptr [bx + 0x200]` — disasm://disassembly/module/MAIN_EXE%3A0100");
    expect(rest.at(-1)).toBe("  … 2 more: disasm://disassembly/data-references/ds%3A0200");
    expect(ok(ctx, "ds:200", true).other_ways_in.split("\n\n")[0]!.split("\n")).toHaveLength(INLINE_OTHER + 3);
    const one = tree({ "MAIN.EXE": [indexed(0)] });
    expect(ok(one, "ds:200").other_ways_in).toContain("points at), 1 instruction:\n");
  });

  test(`tables based up to ${TABLE_REACH.toString(16)}h below may reach the address; not the one at it, further away, or in another segment`, () => {
    const base = (segment: string, offset: number, n: number) => row(segment, offset, "reads", n, { indexed: true });
    const ctx = tree({ "MAIN.EXE": [base("ds", 0x300 - TABLE_REACH - 1, 0), base("ds", 0x300 - TABLE_REACH, 1), base("ds", 0x2ff, 2), base("ds", 0x2ff, 3), base("ds", 0x300, 4), base("ds", 0x301, 5), base("0714h", 0x2f0, 6)] });
    const below = ok(ctx, "ds:300").other_ways_in.split("\n\n").find((p) => p.startsWith("Tables indexed"));
    expect(below).toBe("Tables indexed from just below it, which may reach it: ds:[index+0200] (1 instruction), ds:[index+02ff] (2 instructions). Look each base up with `data_references`.");
    expect(ok(ctx, "ds:100").other_ways_in).not.toContain("Tables indexed");
  });

  test("the same offset through a segment register of unknown value is listed apart, with the register", () => {
    const through = (n: number, register = "es") => row(null, 0x400, "writes", n, { register });
    const ctx = tree({ "MAIN.EXE": [row("ds", 0x400), ...Array.from({ length: INLINE_OTHER + 1 }, (_, i) => through(i)), through(0x10, "ss"), row(null, 0x402)] });
    const o = ok(ctx, "ds:400");
    expect(o.result).toContain("1 instruction in 1 function names ds:[0400]");
    const part = o.other_ways_in.split("\n\n").find((p) => p.startsWith("The same offset"))!.split("\n");
    expect(part[0]).toBe(`The same offset through a segment register whose value is not known at that instruction (this location only if the register holds its segment there), ${INLINE_OTHER + 2} instructions:`);
    expect(part[1]).toBe("  - MAIN_EXE:0100 writes it at MAIN_EXE:0104: `mov ax, word ptr [400h]` — disasm://disassembly/module/MAIN_EXE%3A0100 (through ES)");
    expect(part).toHaveLength(INLINE_OTHER + 2);
    expect(part.at(-1)).toBe("  … 2 more: disasm://disassembly/data-references/ds%3A0400");
    expect(ok(ctx, "ds:400", true).other_ways_in).toContain("(through SS)");
    expect(ok(tree({ "MAIN.EXE": [through(0)] }), "ds:400").other_ways_in).toContain("there), 1 instruction:\n");
  });

  test("a register other than DS asks for the offset in every segment", () => {
    const ctx = tree({ "MAIN.EXE": [row("ds", 0x240), row("0714h", 0x240, "writes", 1), row("0714h", 0x200, "reads", 2, { indexed: true })], "TOOL.EXE": [row("ds", 0x240, "reads", 3), row(null, 0x240, "reads", 4)] });
    const o = ok(ctx, "mov ax, word ptr cs:[0x240]");
    expect(o.address).toBe("offset 0240 in any segment");
    expect(o.result).toBe("3 instructions in 3 functions name offset 0240 in any segment by its address: writes 1, reads 2.");
    expect(o.references.split("\n").filter((l) => l.endsWith(":"))).toEqual(["ds:[0240] in MAIN.EXE:", "0714h:[0240] in MAIN.EXE:", "ds:[0240] in TOOL.EXE:"]);
    expect(o.all_references).toBe("disasm://disassembly/data-references/any%3A0240");
    expect(o.other_ways_in).toContain("0714h:[index+0200] (1 instruction)");
    expect(o.other_ways_in).toContain("1 instruction:\n  - MAIN_EXE:0104 reads it");
  });

  test("the file is read once per tree", () => {
    const ctx = tree({ "MAIN.EXE": [row("ds", 0x10)] });
    expect(ok(ctx, "ds:10").result).toContain("1 instruction");
    rmSync(path.join(ctx.disassemblyRoot, "navigation", "data_references.json"));
    expect(ok(ctx, "ds:10").result).toContain("1 instruction");
  });

  test("the text form carries every part", () => {
    const o = ok(tree({ "MAIN.EXE": [row("ds", 0x10)] }), "ds:10");
    expect(renderDataReferencesText(o)).toBe([`# ds:[0010]`, "", o.result, "", `## References\n${o.references}`, "", `## Other ways in\n${o.other_ways_in}`, "", `Everything, without cuts: ${o.all_references}`, "", o.tool_hint].join("\n"));
  });
});
