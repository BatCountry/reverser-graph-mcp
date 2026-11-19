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

/** A line of code in a listing: its address (offset in the node's space), its bytes, and the instruction text. */
export interface CodeLine {
  addr: number;
  /** instruction bytes in hex; empty on a batch-file line, whose text sits past the bytes column */
  bytes: string;
  code: string;
}

/** "XXXX  bytes  text": the address, exactly two spaces, the bytes (none on a batch-file line), then the text. */
const CODE_LINE = /^([0-9a-f]{4,8}) {2}([0-9a-f]*)\s+(\S.*)$/i;

/** The one reader of the listing line format; undefined for a comment, a header or a malformed line. */
export function parseCodeLine(line: string): CodeLine | undefined {
  const m = CODE_LINE.exec(line);
  return m ? { addr: parseInt(m[1]!, 16), bytes: m[2]!, code: m[3]!.trimEnd() } : undefined;
}

export type Transfer = "call" | "jmp" | "jcc" | "loop" | "ret";

const MNEMONIC = /\b(l?call[fn]?|l?jmp[fn]?|j[a-z]{1,4}|loop[a-z]{0,2}|retf?|iret)\b/i;

/** Transfer family of an instruction; undefined for an ordinary one (an edge on one is a fall-through). */
function family(text: string): Transfer | undefined {
  const m = MNEMONIC.exec(text)?.[1]?.toLowerCase();
  if (!m) return undefined;
  if (m.includes("call")) return "call";
  if (m.includes("jmp")) return "jmp";
  if (m.includes("ret")) return "ret";
  return m.startsWith("loop") ? "loop" : "jcc";
}

/** What a line reaches: `→`, `↓ falls through into`, or `⇒ <how>:` (a link), then the targets. */
export interface ListingNote {
  label: string;
  /** function ids, distinct, in edge order; null for an unknown target (named by `unknown`); at most MAX_LINE_TARGETS */
  targets: Array<string | null>;
  /** how an unknown target reads: "unresolved (indirect)" for a call, "not in this tree" for a link */
  unknown: string;
  /** targets beyond MAX_LINE_TARGETS (the module tool lists them all as callees) */
  more: number;
}

export interface ListingLine {
  /** the line as the listing file has it */
  text: string;
  /** set on a line of code */
  code?: CodeLine;
  transfer?: Transfer;
  notes: ListingNote[];
  /** a comment line naming graph nodes ("; shared with MAIN_EXE:1a2c"): its text split at them; absent otherwise */
  parts?: Array<string | { node: string }>;
}

export interface AnnotatedListing {
  /** comment lines explaining the notes, and how stub-table callers reach the function */
  header: string[];
  lines: ListingLine[];
}

const NODE_ID = /[\w.-]+:[0-9a-f]{4,8}/gi;

/** A comment line split at the graph nodes it names, or undefined when it names none. */
function commentParts(graph: CallGraph, line: string): ListingLine["parts"] {
  const parts: NonNullable<ListingLine["parts"]> = [];
  let last = 0;
  for (const m of line.matchAll(NODE_ID)) {
    if (!graph.nodes.has(m[0])) continue;
    parts.push(line.slice(last, m.index), { node: m[0] });
    last = m.index + m[0].length;
  }
  return parts.length ? [...parts, line.slice(last)] : undefined;
}

/** The note for `edges`, or undefined when none reaches a function or unknown target. */
function note(graph: CallGraph, edges: readonly GraphEdge[], label: string, unknown: string): ListingNote | undefined {
  const reached = edges.map((e) => graph.nodes.get(e.target)).filter((t): t is GraphNode => t?.kind === "function" || t?.kind === "unknown-target");
  if (reached.length === 0) return undefined;
  const distinct = [...new Set(reached.map((t) => (t.kind === "function" ? t.id : null)))];
  return { label, targets: distinct.slice(0, MAX_LINE_TARGETS), unknown, more: Math.max(0, distinct.length - MAX_LINE_TARGETS) };
}

/**
 * A listing of `node` with every line's notes: `→ <node>` on a graph call/jump site whose target is a function (or an
 * unresolved indirect target, e.g. a pushed address dispatched by `retf`), `↓ falls through into <node>` on the last
 * instruction before code runs on into another function. The line's transfer family must match the edge's (a
 * fall-through edge only matches an ordinary instruction), which guards against a listing that does not match the
 * graph: it then gets no notes rather than wrong ones. A line whose text contains the instruction of a link edge (an
 * `int` a resident driver answers, a batch line or exec that runs a program, a file read) gets `⇒ <how>: <node>` after
 * any arrow. A function other code reaches through a stub table (see stubCallText) gets that explained in the header.
 */
export function annotateListing(graph: CallGraph, node: GraphNode, text: string): AnnotatedListing {
  let calls = false;
  let links = false;
  const lines = text.split("\n").map((line): ListingLine => {
    const code = parseCodeLine(line);
    if (!code) {
      const parts = commentParts(graph, line);
      return { text: line, notes: [], ...(parts ? { parts } : {}) };
    }
    const transfer = family(code.code);
    const site = graph.bySite.get(`${node.space}:${code.addr.toString(16).padStart(4, "0")}`.toLowerCase()) ?? [];
    const called = note(graph, site.filter((e) => e.link === undefined && family(e.instruction) === transfer && (transfer !== undefined || !e.returns)), transfer === undefined ? "↓ falls through into" : "→", "unresolved (indirect)");
    const lower = code.code.toLowerCase();
    const linked = (Object.keys(LINK_NOTE) as EdgeLink[])
      .map((how) => note(graph, site.filter((e) => e.link === how && e.instruction.trim() !== "" && lower.includes(e.instruction.trim().toLowerCase())), LINK_NOTE[how], "not in this tree"))
      .filter((n): n is ListingNote => n !== undefined);
    calls ||= called !== undefined;
    links ||= linked.length > 0;
    return { text: line, code, ...(transfer ? { transfer } : {}), notes: called ? [called, ...linked] : linked };
  });
  const stubs = graph.stubCallsTo(node.id);
  return { header: [...(stubs.length ? [`; ${stubCallText(node, stubs)}`] : []), ...(calls ? [CALL_TARGET_HEADER] : []), ...(links ? [LINK_TARGET_HEADER] : [])], lines };
}

/** A note as listing text: "→ MAIN_EXE:1a2c, unresolved (indirect), … (+3 more: …)". */
function noteText(n: ListingNote): string {
  const more = n.more ? `, … (+${n.more} more: the module tool lists them as callees)` : "";
  return `${n.label} ${n.targets.map((t) => t ?? n.unknown).join(", ")}${more}`;
}

/** The annotated listing as the MCP serves it: the header, then each line with its notes after tabs. */
export function listingText(a: AnnotatedListing): string {
  return [...a.header, ...a.lines.map((l) => l.text + l.notes.map((n) => `\t; ${noteText(n)}`).join(""))].join("\n");
}

/** `annotateListing` as text: what the listing resource and the module tool show. */
export function annotateCallTargets(graph: CallGraph, node: GraphNode, text: string): string {
  return listingText(annotateListing(graph, node, text));
}
