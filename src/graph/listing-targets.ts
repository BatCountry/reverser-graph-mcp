import type { CallGraph, EdgeLink, GraphEdge, GraphNode } from "./model.js";

// Listings name call targets the way the code writes them (lcall 0x41, 0x25; call 0x34f), which a model then has to
// translate. Annotating each call/jump line with the graph node it reaches removes that step entirely: the name after
// the arrow goes straight into the `module` tool. A line's address is an offset in the listing's own space, so it
// matches graph call sites directly and shared overlay ranges are not ambiguous here.

export const CALL_TARGET_HEADER = '; Calls and jumps to other functions end in "; → <node>" (code running on into the next function: "; ↓ falls through into <node>"): pass that node name to the module tool.';

export const LINK_TARGET_HEADER =
  '; Lines that reach another program end in "; ⇒ <how>: <node>" (an interrupt a resident driver answers, a program it runs, a file it reads): a boundary to that program\'s interface, not a function to call.';

/** How a listing line reaches another program, in the order the notes list them. */
const LINK_NOTE: Record<EdgeLink, string> = {
  interrupt: "⇒ interrupt answered in another program:",
  runs: "⇒ runs another program:",
  loads: "⇒ reads another program's file:",
};

/** Targets named on one line; a call through a table of stored pointers can have over a hundred. */
export const MAX_LINE_TARGETS = 4;

/**
 * How other code reaches a function through a stub table, for a model that sees `lcall 0xa5, 0x25` in a caller and
 * `0db7` on this function's lines: the first number names the overlay, the second a stub-table slot, not an address.
 */
export function stubCallText(node: GraphNode, stubs: readonly string[]): string {
  const at = node.address === null ? node.id : `0x${node.address.toString(16)}`;
  return `Other code reaches it through a stub table as ${stubs.map((s) => `\`${s}\``).join(" or ")}: the first number names the overlay (${node.space}), the second picks a stub-table entry that jumps to ${at}; it is not an address inside the overlay.`;
}

/** A listing line's own address: 4 hex digits (offset in the node's space), then two spaces. */
const LINE_ADDRESS = /^\s*([0-9a-f]{4}) {2}/i;
const MNEMONIC = /\b(l?call[fn]?|l?jmp[fn]?|j[a-z]{1,4}|loop[a-z]{0,2}|retf?|iret)\b/i;

/** Transfer family of a line or an edge; undefined for an ordinary instruction (an edge on one is a fall-through). */
function family(text: string): string | undefined {
  const m = MNEMONIC.exec(text)?.[1]?.toLowerCase();
  if (!m) return undefined;
  if (m.includes("call")) return "call";
  if (m.includes("jmp")) return "jmp";
  if (m.includes("ret")) return "ret";
  return m.startsWith("loop") ? "loop" : "jcc";
}

/**
 * The nodes `edges` reach, as a listing note names them: functions by id, unknown targets as `unknown`; at most
 * MAX_LINE_TARGETS, then a count. Undefined when none is a function or unknown target.
 */
function targetList(graph: CallGraph, edges: readonly GraphEdge[], unknown: string): string | undefined {
  const targets = edges
    .map((e) => graph.nodes.get(e.target))
    .filter((t): t is GraphNode => t !== undefined && (t.kind === "function" || t.kind === "unknown-target"))
    .map((t) => (t.kind === "function" ? t.id : unknown));
  if (targets.length === 0) return undefined;
  const distinct = [...new Set(targets)];
  const more = distinct.length > MAX_LINE_TARGETS ? `, … (+${distinct.length - MAX_LINE_TARGETS} more: the module tool lists them as callees)` : "";
  return `${distinct.slice(0, MAX_LINE_TARGETS).join(", ")}${more}`;
}

/**
 * Append `; → <node>` to every line of `text` (a listing of `node`) that is a graph call/jump site whose target is a
 * function (or an unresolved indirect target, e.g. a pushed address dispatched by `retf`), and `; ↓ falls through into
 * <node>` to the last instruction before code runs on into another function. The line's transfer family must match
 * the edge's (a fall-through edge only matches an ordinary instruction), which guards against a listing that does not
 * match the graph: it is then returned with no arrows rather than wrong ones. A function other code reaches through a
 * stub table (see stubCallText) gets that explained in a first comment line. A line whose text contains the
 * instruction of a link edge (an `int` a resident driver answers, a batch line or exec that runs a program, a file
 * read) gets `; ⇒ <how>: <node>` after any arrow; a link to a program the tree lacks is named `not in this tree`.
 */
export function annotateCallTargets(graph: CallGraph, node: GraphNode, text: string): string {
  if (!node.space) return text;
  let calls = 0;
  let links = 0;
  const lines = text.split("\n").map((line) => {
    const m = LINE_ADDRESS.exec(line);
    if (!m) return line;
    const code = line.slice(m[0].length);
    const lineFamily = family(code);
    const site = graph.bySite.get(`${node.space}:${m[1]}`.toLowerCase()) ?? [];
    const notes: string[] = [];
    const called = targetList(graph, site.filter((e) => e.link === undefined && family(e.instruction) === lineFamily && (lineFamily !== undefined || !e.returns)), "unresolved (indirect)");
    if (called !== undefined) {
      calls++;
      notes.push(`${lineFamily === undefined ? "↓ falls through into" : "→"} ${called}`);
    }
    const lower = code.toLowerCase();
    for (const how of Object.keys(LINK_NOTE) as EdgeLink[]) {
      const linked = targetList(graph, site.filter((e) => e.link === how && e.instruction.trim() !== "" && lower.includes(e.instruction.trim().toLowerCase())), "not in this tree");
      if (linked === undefined) continue;
      links++;
      notes.push(`${LINK_NOTE[how]} ${linked}`);
    }
    return notes.length ? `${line}${notes.map((n) => `\t; ${n}`).join("")}` : line;
  });
  const stubs = graph.stubCallsTo(node.id);
  const header = [...(stubs.length ? [`; ${stubCallText(node, stubs)}`] : []), ...(calls ? [CALL_TARGET_HEADER] : []), ...(links ? [LINK_TARGET_HEADER] : [])];
  return [...header, ...(calls || links ? lines : [text])].join("\n");
}
