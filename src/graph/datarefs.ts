import { readFileSync } from "node:fs";
import path from "node:path";
import { parseHexKey, parseNumber } from "../hex.js";
import { urisOf, type Context } from "./tools.js";

/** One row of navigation/data_references.json (its README documents the fields), with the program it belongs to. */
export interface DataReference {
  program: string;
  /** `ds`, a load-image segment (`0714h`) or a space; null: read through `register`, whose value is not known there */
  segment: string | null;
  register: string;
  offset: number;
  /** the operand also has a register of unknown value: `offset` is the base of a table */
  indexed: boolean;
  access: string;
  function: string;
  site: string;
  instruction: string;
}

/** Lines shown in a tool result per kind of reference; the resource shows them all. */
export const INLINE_DIRECT = 12;
export const INLINE_OTHER = 5;
/** A table indexed from this far below an address is reported as possibly reaching it. */
export const TABLE_REACH = 0x100;
const MAX_OFFSET = 0xfffff;

const FORMS = "Give a data address: ds:4f2a, an operand or instruction as a listing shows it ([0x4f2a], mov ax, word ptr cs:[0x40]), or a segment as the server prints it (0714h:[0124], MAIN_OVR-0020:[000f]).";
const ACCESS_ORDER = ["writes", "reads and writes", "takes the address of", "calls through", "jumps through", "reads", "uses"];
const rank = (access: string) => ACCESS_ORDER.indexOf(access);

export type ParsedDataAddress = { ok: true; /** undefined: any segment */ segment: string | undefined; offset: number } | { ok: false; error: string };

/**
 * A client's data address. Without a segment it is in `ds`. Hex as written inside brackets or after a segment; a bare
 * number needs a hex marker. A segment register other than DS names no segment (its value differs from function to
 * function), so the address then stands for that offset in any segment; so does the segment `any`.
 */
export function parseDataAddress(input: string): ParsedDataAddress {
  const text = input.trim();
  const operand = /(?:([\w-]+)\s*:\s*)?\[([^\]]*)\]/.exec(text);
  const cut = text.lastIndexOf(":");
  const segText = operand ? (operand[1] ?? "ds") : cut < 0 ? "ds" : text.slice(0, cut).trim();
  const offText = operand ? operand[2]!.trim() : text.slice(cut + 1).trim();
  const off = operand || cut >= 0 ? parseHexKey(offText, MAX_OFFSET, "offset") : parseNumber(offText, MAX_OFFSET, "address");
  if (!off.ok) return { ok: false, error: `${off.error}. ${FORMS}` };
  if (!segText) return { ok: false, error: `"${input}" has no segment before the colon. ${FORMS}` };
  const seg = segText.toLowerCase();
  if (/^(?:[cefgs]s|any)$/.test(seg)) return { ok: true, segment: undefined, offset: off.value };
  const para = /^(?:0x)?([0-9a-f]{1,4})h?$/.exec(seg);
  return { ok: true, segment: para ? `${para[1]!.padStart(4, "0")}h` : seg, offset: off.value };
}

const hex4 = (n: number) => n.toString(16).padStart(4, "0");
const where = (segment: string, offset: number, indexed = false) => `${segment}:[${indexed ? "index+" : ""}${hex4(offset)}]`;

let shared: { root: string; rows: DataReference[] } | undefined;

/** The tree's data references, read once per root; an error text when the tree has none. */
export function loadDataReferences(disassemblyRoot: string): DataReference[] | string {
  if (shared?.root === disassemblyRoot) return shared.rows;
  const file = path.join(disassemblyRoot, "navigation", "data_references.json");
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return `This tree has no ${file}: it was built before the generator recorded data references. Rebuild it with scripts/build_callgraph.py, then ask again.`;
  }
  // a generated artifact with a documented shape (navigation/README.md), like callgraph.json
  const parsed: Record<string, Array<Omit<DataReference, "program">>> = JSON.parse(text);
  const rows = Object.entries(parsed).flatMap(([program, list]) => list.map((r) => ({ ...r, program })));
  shared = { root: disassemblyRoot, rows };
  return rows;
}

export interface DataReferencesOutput {
  address: string;
  result: string;
  references: string;
  other_ways_in: string;
  all_references: string;
  tool_hint: string;
}

export type DataReferencesResult = { ok: true; output: DataReferencesOutput } | { ok: false; error: string };

/** `full`: no line caps (the resource). */
export function lookupDataReferences(ctx: Context, args: { address: string }, full = false): DataReferencesResult {
  const parsed = parseDataAddress(args.address);
  if (!parsed.ok) return parsed;
  const rows = loadDataReferences(ctx.disassemblyRoot);
  if (typeof rows === "string") return { ok: false, error: rows };
  const { offset } = parsed;
  // spaces are written with upper-case names; the comparison ignores case
  const segment = parsed.segment === undefined ? undefined : (rows.find((r) => r.segment?.toLowerCase() === parsed.segment)?.segment ?? parsed.segment);
  // a mistyped segment is told apart from an address nothing names; `ds` is every program's data segment
  if (segment !== undefined && segment !== "ds" && !rows.some((r) => r.segment === segment)) {
    const known = [...new Set(rows.flatMap((r) => (r.segment === null ? [] : [r.segment])))];
    return { ok: false, error: `No instruction names anything in segment "${segment}". Segments with references: ${known.slice(0, 8).join(", ")}${known.length > 8 ? `, … (${known.length} in all)` : ""}. ${FORMS}` };
  }
  const inSegment = (r: DataReference) => r.segment !== null && (segment === undefined || r.segment === segment);
  const uris = urisOf(ctx);
  const label = segment === undefined ? `offset ${hex4(offset)} in any segment` : where(segment, offset);
  const line = (r: DataReference) => `- ${r.function} ${r.access} it at ${r.site}: \`${r.instruction}\` — ${uris.module(r.function)}`;
  const byUse = (a: DataReference, b: DataReference) => rank(a.access) - rank(b.access) || a.site.localeCompare(b.site);
  const capped = (list: DataReference[], cap: number) => (full ? list : list.slice(0, cap));
  const all = uris.dataReferences(`${segment ?? "any"}:${hex4(offset)}`);

  const direct = rows.filter((r) => inSegment(r) && !r.indexed && r.offset === offset);
  const groups = new Map<string, DataReference[]>();
  for (const r of direct) {
    const key = `${where(r.segment!, r.offset)} in ${r.program}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(r);
  }
  let left = full ? Infinity : INLINE_DIRECT;
  const sections: string[] = [];
  for (const [key, list] of groups) {
    const shown = list.sort(byUse).slice(0, left);
    left -= shown.length;
    if (shown.length) sections.push([`${key}:`, ...shown.map(line)].join("\n"));
  }
  if (!full && direct.length > INLINE_DIRECT) sections.push(`… ${direct.length - INLINE_DIRECT} more: ${all}`);

  const counts = new Map<string, number>();
  for (const r of direct) counts.set(r.access, (counts.get(r.access) ?? 0) + 1);
  const tally = [...counts].sort((a, b) => rank(a[0]) - rank(b[0])).map(([access, n]) => `${access} ${n}`).join(", ");
  const functions = new Set(direct.map((r) => r.function)).size;
  const result = direct.length
    ? `${direct.length} instruction${direct.length === 1 ? "" : "s"} in ${functions} function${functions === 1 ? "" : "s"} name${direct.length === 1 ? "s" : ""} ${label} by its address: ${tally}.`
    : `No instruction names ${label} by its address.`;

  const other: string[] = [];
  const more = (list: DataReference[]) => (list.length > capped(list, INLINE_OTHER).length ? [`  … ${list.length - INLINE_OTHER} more: ${all}`] : []);
  const table = rows.filter((r) => inSegment(r) && r.indexed && r.offset === offset).sort(byUse);
  if (table.length) {
    other.push([`Indexed from this address (\`[register + ${hex4(offset)}h]\`: a table that starts here, or this offset into whatever the register points at), ${table.length} instruction${table.length === 1 ? "" : "s"}:`,
      ...capped(table, INLINE_OTHER).map((r) => `  ${line(r)}`), ...more(table)].join("\n"));
  }
  const below = new Map<string, number>();
  for (const r of rows) {
    if (inSegment(r) && r.indexed && r.offset < offset && r.offset >= offset - TABLE_REACH) below.set(where(r.segment!, r.offset, true), (below.get(where(r.segment!, r.offset, true)) ?? 0) + 1);
  }
  if (below.size) {
    other.push(`Tables indexed from just below it, which may reach it: ${[...below].map(([w, n]) => `${w} (${n} instruction${n === 1 ? "" : "s"})`).join(", ")}. Look each base up with \`data_references\`.`);
  }
  const unknown = rows.filter((r) => r.segment === null && r.offset === offset).sort(byUse);
  if (unknown.length) {
    other.push([`The same offset through a segment register whose value is not known at that instruction (this location only if the register holds its segment there), ${unknown.length} instruction${unknown.length === 1 ? "" : "s"}:`,
      ...capped(unknown, INLINE_OTHER).map((r) => `  ${line(r)} (through ${r.register.toUpperCase()})`), ...more(unknown)].join("\n"));
  }
  other.push("Not listed at all: accesses through a pointer (`les di, [p]` then `es:[di + 4]`; they start where its address is taken or stored), stack-frame slots, and operands of 8087-emulator interrupts.");

  return {
    ok: true,
    output: {
      address: label,
      result,
      references: sections.join("\n\n") || "None.",
      other_ways_in: other.join("\n\n"),
      all_references: all,
      tool_hint: "- Use `module` on a function above for its listing, callers and status.\n- A far pointer or dword variable is two words: look up the address two bytes on as well.",
    },
  };
}

/** Markdown of a result, for text-only clients and the resource. */
export function renderDataReferencesText(o: DataReferencesOutput): string {
  return [`# ${o.address}`, "", o.result, "", `## References\n${o.references}`, "", `## Other ways in\n${o.other_ways_in}`, "", `Everything, without cuts: ${o.all_references}`, "", o.tool_hint].join("\n");
}
