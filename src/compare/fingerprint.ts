import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { listingFor } from "../graph/files.js";
import { parseCodeLine } from "../graph/listing-targets.js";
import type { CallGraph } from "../graph/model.js";
import type { WorkUnit } from "../graph/workunits.js";

// Content fingerprints of work units, for carrying progress between two trees (two games, or two builds of one).
// Two units are the same code when every member's instructions are identical except for what moves when a program
// is rebuilt or relinked, renamed consistently across the whole unit:
//   - jumps inside a function become instruction ordinals; calls and jumps to graph nodes become member ordinals
//     (members in a canonical order: depth-first from the root along calls) or external symbols X0, X1, ...;
//   - absolute memory operands ([0x7216], es:[0x10]) become globals D0, D1, ... per segment override;
//   - `mov r16, imm` that is pushed as a far pointer right after (`push ds|cs|ss; push r16`) becomes P0, P1, ...
// Everything else must match exactly: opcodes, registers, immediates, stack and field offsets ([bp - 6], [si + 0x592]).
// Not compared: bytes outside the listings, so string literals and data reached through those pointers.

const ABSOLUTE = /(?:\b([cdes]s):)?\[(0x[0-9a-f]+|\d+)\]/g;
const DIRECT = /^(l?call[a-z]*|l?jmp[a-z]*|j[a-z]{1,4}|loop[a-z]{0,2}|jcxz)\s+(?:0x[0-9a-f]+|\d+)(?:,\s*(?:0x[0-9a-f]+|\d+))?$/i;
const NEAR_TARGET = /\s(0x[0-9a-f]+|\d+)$/i;
const POINTER = /^mov ([abcd]x|si|di|bp), (0x[0-9a-f]+|\d+)$/i;

export interface UnitPrint {
  unit: string;
  /** sha-256 of the normalized code */
  key: string;
  /** function members, canonical order (the same position holds the same code in a matching unit) */
  members: string[];
  /** graph nodes outside the unit that members call or jump to, in symbol order X0, X1, ... */
  externals: string[];
  /** why the unit cannot be fingerprinted (a member without a readable listing) */
  missing?: string;
}

export interface Insn {
  addr: number;
  /** instruction text as the listing prints it */
  text: string;
}

/** A function's instructions in address order; undefined when it has no readable listing. */
export function readInsns(disassemblyRoot: string, graph: CallGraph, id: string): Insn[] | undefined {
  const file = listingFor(disassemblyRoot, graph.nodes.get(id)!); // callers pass function nodes
  if (!file) return undefined;
  let text: string;
  try {
    text = readFileSync(file.absPath, "utf8");
  } catch {
    return undefined;
  }
  const out: Insn[] = [];
  for (const line of text.split("\n")) {
    // batch-file lines have no instruction bytes: nothing to compare
    const c = parseCodeLine(line);
    if (c?.bytes) out.push({ addr: c.addr, text: c.code });
  }
  return out.sort((a, b) => a.addr - b.addr);
}

/** Members depth-first from the root along calls/jumps in address order; members nothing reaches go last by id. */
function canonicalMembers(graph: CallGraph, unit: Pick<WorkUnit, "root" | "members">): string[] {
  const inUnit = new Set(unit.members.filter((m) => graph.nodes.get(m)?.kind === "function"));
  const order: string[] = [];
  const visit = (id: string): void => {
    if (!inUnit.has(id) || order.includes(id)) return;
    order.push(id);
    const out = [...(graph.out.get(id) ?? [])].sort((a, b) => (a.instruction_offset < b.instruction_offset ? -1 : a.instruction_offset > b.instruction_offset ? 1 : 0));
    for (const e of out) visit(e.target);
  };
  visit(unit.root);
  // every member is owned through a call chain from the root, so this only guards against malformed graphs
  for (const m of [...inUnit].sort()) if (!order.includes(m)) order.push(m);
  return order;
}

/** Line tokens for aligning a function with its counterpart: addresses that move between builds are blanked, not
 * numbered, so one inserted global or callee does not shift every later name. */
export function alignmentTokens(graph: CallGraph, id: string, insns: readonly Insn[]): string[] {
  const space = graph.nodes.get(id)?.space;
  const here = new Set(insns.map((x) => x.addr));
  return insns.map((ins, i) => {
    const text = ins.text;
    if (DIRECT.test(text)) {
      const mnemonic = text.split(/\s+/)[0]!;
      if (graph.bySite.has(`${space}:${ins.addr.toString(16).padStart(4, "0")}`.toLowerCase())) return `${mnemonic} <function>`;
      const local = NEAR_TARGET.exec(text);
      return local && !text.includes(",") && here.has(Number(local[1])) ? `${mnemonic} <here>` : text;
    }
    const ptr = POINTER.exec(text);
    if (ptr && /^push [cds]s$/.test(insns[i + 1]?.text ?? "") && insns[i + 2]?.text === `push ${ptr[1]}`) return `mov ${ptr[1]}, <pointer>`;
    return text.replace(ABSOLUTE, (_m, seg: string | undefined) => `${seg ? `${seg}:` : ""}[<global>]`);
  });
}

export function fingerprintUnit(disassemblyRoot: string, graph: CallGraph, unit: Pick<WorkUnit, "id" | "root" | "members">): UnitPrint {
  return printUnit(disassemblyRoot, graph, unit).print;
}

export interface FunctionPrint {
  /** sha-256 of the normalized code, as fingerprintUnit computes it for a unit of this one function */
  key: string;
  /** nodes it calls or jumps to (itself excluded), in symbol order X0, X1, ... */
  externals: string[];
  /** what the renaming hid, in name order: the absolute memory operands (D0, D1, ...) then the far pointers (P0, ...) */
  data: string[];
}

/** One function's normalized code; undefined when it has no readable listing or no instruction in it (a batch file). */
export function functionPrint(disassemblyRoot: string, graph: CallGraph, id: string): FunctionPrint | undefined {
  const { print, data, instructions } = printUnit(disassemblyRoot, graph, { id, root: id, members: [id] });
  return print.missing === undefined && instructions > 0 ? { key: print.key, externals: print.externals, data } : undefined;
}

function printUnit(disassemblyRoot: string, graph: CallGraph, unit: Pick<WorkUnit, "id" | "root" | "members">): { print: UnitPrint; data: string[]; instructions: number } {
  const members = canonicalMembers(graph, unit);
  const memberIndex = new Map(members.map((m, i) => [m, i]));
  const externals: string[] = [];
  const globals = new Map<string, string>();
  const pointers = new Map<string, string>();
  const symbol = (target: string): string => {
    const member = memberIndex.get(target);
    if (member !== undefined) return `M${member}`;
    if (graph.nodes.get(target)?.kind === "unknown-target") return "INDIRECT";
    let i = externals.indexOf(target);
    if (i < 0) i = externals.push(target) - 1;
    return `X${i}`;
  };
  const named = (table: Map<string, string>, prefix: string, key: string): string => {
    let name = table.get(key);
    if (name === undefined) table.set(key, (name = `${prefix}${table.size}`));
    return name;
  };

  const lines: string[] = [];
  let instructions = 0;
  for (const [k, id] of members.entries()) {
    const insns = readInsns(disassemblyRoot, graph, id);
    if (!insns) return { print: { unit: unit.id, key: "", members, externals, missing: `${id} has no readable listing` }, data: [], instructions: 0 };
    instructions += insns.length;
    const space = graph.nodes.get(id)!.space;
    const ordinal = new Map(insns.map((ins, i) => [ins.addr, i]));
    lines.push(`#${k}`);
    insns.forEach((ins, i) => {
      // a link names another program, which is no part of this unit's code shape or callee interface
      const edges = (graph.bySite.get(`${space}:${ins.addr.toString(16).padStart(4, "0")}`.toLowerCase()) ?? []).filter((e) => e.link === undefined);
      let text = ins.text;
      if (DIRECT.test(text)) {
        const mnemonic = text.split(/\s+/)[0]!;
        const local = NEAR_TARGET.exec(text);
        const target = local && !text.includes(",") ? ordinal.get(Number(local[1])) : undefined;
        // a transfer to another node is named by the edge; one inside the function by instruction ordinal
        text = edges.length ? mnemonic : target !== undefined ? `${mnemonic} @${target}` : text;
      } else {
        const ptr = POINTER.exec(text);
        const next = insns[i + 1]?.text;
        const after = insns[i + 2]?.text;
        if (ptr && next && /^push [cds]s$/.test(next) && after === `push ${ptr[1]}`) {
          text = `mov ${ptr[1]}, ${named(pointers, "P", `${next.slice(5)}:${Number(ptr[2])}`)}`;
        }
        text = text.replace(ABSOLUTE, (_m, seg: string | undefined, value: string) => `${seg ? `${seg}:` : ""}[${named(globals, "D", `${seg ?? ""}:${Number(value)}`)}]`);
      }
      const targets = edges.map((e) => symbol(e.target)).sort();
      lines.push(targets.length ? `${text} -> ${targets.join(",")}` : text);
    });
  }
  return {
    print: { unit: unit.id, key: createHash("sha256").update(lines.join("\n")).digest("hex"), members, externals },
    data: [...[...globals.keys()].map((k) => `D ${k}`), ...[...pointers.keys()].map((k) => `P ${k}`)],
    instructions,
  };
}
