import type { EdgeLink, GraphEdge, GraphNode } from "./model.js";

// The generator follows constant pointers from where the code stores them to the calls and jumps that read them
// (scripts/dosgraph/pointers.py). A resolved indirect call is an ordinary edge with `through` naming what it
// read; what stays unresolved is an `unknown-target` node with a `reason`. These helpers turn both into prose.

/** How to translate a call through an address computed at run time. */
export const INDIRECT_CALL_ADVICE =
  "implement each such call as a lookup in a table of function pointers keyed by the far address (seg:off) the program stores; register functions in it as they are implemented (`module` resolves a stored seg:off to its function), and make an address missing from the table fail visibly";

/** What a function called through stored pointers needs beyond being written. */
export const POINTER_TARGET_ADVICE =
  "no call names it, so register it in your table of function pointers under every address the program stores for it (the Evidence lines of `module` name each store); a missing entry fails only when that path runs, so test a path that goes through the pointer";

const CHAIN = /previous INT ([0-9A-F]{2})h handler/;

/** Advice for one unresolved transfer, by why it is unresolved. */
export function adviceFor(reason: string | undefined): string {
  const chain = reason === undefined ? null : CHAIN.exec(reason);
  if (chain) {
    return `it hands INT ${chain[1]}h on to the handler that was installed before the program's own (saved from DOS at start-up), not to program code: in a reimplementation pass the interrupt on to the original or platform handler, or leave the chain out if the platform layer owns that interrupt`;
  }
  return INDIRECT_CALL_ADVICE;
}

/** Why an unknown-target node has no function behind it (older trees carry no reason). */
export function unresolvedReason(node: GraphNode | undefined): string {
  return typeof node?.reason === "string" && node.reason ? node.reason : "the call site could not be traced to a function";
}

/** Evidence lines the generator recorded for a function, if any. */
export function nodeEvidence(node: GraphNode): string[] {
  return Array.isArray(node.evidence) ? node.evidence.filter((l): l is string => typeof l === "string") : [];
}

/** What a link edge does, read after its site: "`int 0x66` at PLAY_EXE:1234 calls into another program (interrupt)". */
export const LINK_TEXT: Record<EdgeLink, string> = {
  interrupt: "calls into another program (interrupt)",
  runs: "runs another program",
  loads: "reads another program's file",
};

/** How to treat a link in a reimplementation. */
export const LINK_ADVICE =
  "each is a boundary to another program, not a function to call or inline: implement the interface it uses (the interrupt API a resident driver provides, a program launch, a file the program reads) and leave the other program's code to that program";

/** `instruction` at site, plus what an indirect transfer read its target through, or what a link does and how. */
export function siteText(edge: GraphEdge): string {
  const through = typeof edge.through === "string" && edge.through ? edge.through : "";
  if (edge.link) {
    const possible = edge.provisional !== true ? "" : edge.link === "interrupt" ? " (possible handler: known only from a hook record)" : " (possible: not proven)";
    return `\`${edge.instruction}\` at ${edge.instruction_offset} ${LINK_TEXT[edge.link]}${through ? `: ${through}` : ""}${possible}`;
  }
  const possible = edge.provisional === true ? " (possible target: only the record field offset matches)" : "";
  return `\`${edge.instruction}\` at ${edge.instruction_offset}${through ? ` through ${through}` : ""}${possible}`;
}
