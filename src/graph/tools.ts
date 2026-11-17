import path from "node:path";
import { TTL_LONG_MS, type TtlCache } from "../cache.js";
import { clip } from "../interrupts/render.js";
import type { ProgressStore } from "../progress/store.js";
import { listingFor } from "./files.js";
import { stubCallText } from "./listing-targets.js";
import { adviceFor, LINK_ADVICE, nodeEvidence, siteText, unresolvedReason } from "./indirect.js";
import type { CallGraph, EdgeLink, GraphEdge, GraphNode } from "./model.js";
import { entrypointTraces, findPaths, type Hop, type Path } from "./paths.js";
import { getSameCode, getWorkPlan, implementedNodes } from "./workplan-cache.js";
import { parseWorkUnitId, type WorkPlan, type WorkUnit, type WorkUnitOptions } from "./workunits.js";

/** Resource URIs of one tree (see disasmUris). */
export interface DisasmUris {
  /** `disasm://<tree>/`: every URI of the tree starts with it */
  base: string;
  module: (id: string) => string;
  neighbors: (id: string) => string;
  listing: (id: string) => string;
  trace: (handle: string) => string;
  workPlan: string;
  workUnit: (id: string) => string;
}

/** Every game's server serves the same paths, so the tree comes first: a client holding several servers (one per
 * game) routes `disasm://beta/listing/…` to the server that advertises that tree only. */
export function disasmUris(tree: string): DisasmUris {
  const base = `disasm://${encodeURIComponent(tree)}/`;
  return {
    base,
    module: (id) => `${base}module/${encodeURIComponent(id)}`,
    neighbors: (id) => `${base}neighbors/${encodeURIComponent(id)}`,
    listing: (id) => `${base}listing/${encodeURIComponent(id)}`,
    trace: (handle) => `${base}trace/${handle}`,
    workPlan: `${base}work-plan`,
    workUnit: (id) => `${base}work-unit/${encodeURIComponent(id)}`,
  };
}

/** A tree's name: its directory's (alpha, beta, …); it also names the tree's progress document. */
export const treeName = (disassemblyRoot: string): string => path.basename(disassemblyRoot);

/** The resource URIs of the tree `ctx` serves. */
export const urisOf = (ctx: Pick<Context, "disassemblyRoot">): DisasmUris => disasmUris(treeName(ctx.disassemblyRoot));

export interface Context {
  graph: CallGraph;
  disassemblyRoot: string;
  progress: ProgressStore;
  cache: TtlCache;
  /** work unit sizing (--work-budget-lines / --work-trivial-lines); defaults when absent */
  workOptions?: WorkUnitOptions | undefined;
}

/** "complete", "ready" or "waiting on N units", with ", oversized" for an incomplete unit over the line budget. */
export function workUnitState(plan: WorkPlan, unit: WorkUnit): string {
  if (unit.complete) return "complete";
  const waiting = unit.dependsOn.filter((d) => !plan.units.get(d)?.complete).length;
  return `${waiting ? `waiting on ${waiting} unit${waiting === 1 ? "" : "s"}` : "ready"}${unit.oversized ? ", oversized" : ""}`;
}

/** One line naming a work unit, its size and state, with a link to its detail. */
export function workUnitLine(plan: WorkPlan, unit: WorkUnit, uris: DisasmUris): string {
  return `Work unit: ${unit.id} (${unit.members.length} member${unit.members.length === 1 ? "" : "s"}, ${unit.lines} lines, ${workUnitState(plan, unit)}) — ${uris.workUnit(unit.id)}`;
}

const INLINE_NEIGHBOURS = 8;
const INLINE_TRACES = 3;

const hex = (n: number | null, w = 4) => (n === null ? "?" : `0x${n.toString(16).padStart(w, "0")}`);

function describeConditions(edge: GraphEdge, max = 2): string {
  if (edge.conditions.length === 0) return "";
  const shown = edge.conditions.slice(0, max).map((c) => `${c.offset} ${c.direction}: ${c.expression}`);
  const more = edge.conditions.length > max ? `; +${edge.conditions.length - max} more` : "";
  return ` [when ${shown.join("; ")}${more}]`;
}

/** `implemented`: id -> "" (its own record) or the same-code peer whose record covers it (see implementedNodes). */
function mark(ctx: Context, implemented: ReadonlyMap<string, string>, id: string): string {
  const by = implemented.get(id);
  if (by !== undefined) return by ? `${id} (implemented: same code as ${by})` : `${id} (implemented)`;
  return ctx.graph.nodes.get(id)?.kind === "function" ? id : `${id} (${ctx.graph.nodes.get(id)?.kind ?? "unknown"})`;
}

/** "Same code as A, B, C and 2 more", `first` (when given) named first. */
export function sameCodeText(peers: readonly string[], first?: string): string {
  const named = first === undefined ? [...peers] : [first, ...peers.filter((p) => p !== first)];
  const shown = named.slice(0, 3);
  return `Same code as ${shown.join(", ")}${named.length > shown.length ? ` and ${named.length - shown.length} more` : ""}`;
}

/** The link a hop crosses when every transfer between its two nodes is one; undefined for a call or jump. */
function hopLink(h: Hop): EdgeLink | undefined {
  return h.edges.length > 0 && h.edges.every((e) => e.link !== undefined) ? h.edges[0]!.link : undefined;
}

const LINK_HOPS =
  "Hops marked →[runs], →[loads] or →[interrupt] cross into another program (it runs it, reads its file, or raises an interrupt a resident driver answers): boundaries between programs, not calls.";

function formatPath(ctx: Context, implemented: ReadonlyMap<string, string>, p: Path, detailed: boolean): string {
  if (p.hops.length === 0) return mark(ctx, implemented, p.nodes[0]!);
  if (!detailed) {
    return [mark(ctx, implemented, p.nodes[0]!), ...p.hops.map((h) => `${hopLink(h) === undefined ? "→" : `→[${hopLink(h)}]`} ${mark(ctx, implemented, h.to)}`)].join(" ");
  }
  const lines = [mark(ctx, implemented, p.nodes[0]!)];
  p.hops.forEach((h, i) => {
    const first = h.edges[0];
    const extra = h.edges.length > 1 ? ` (+${h.edges.length - 1} more call site${h.edges.length > 2 ? "s" : ""})` : "";
    lines.push(`  ${i + 1}. ${first ? `${siteText(first)}${describeConditions(first)}${extra}` : "(edge not found)"}`, `  → ${mark(ctx, implemented, h.to)}`);
  });
  return lines.join("\n");
}

function describeNode(graph: CallGraph, node: GraphNode): string {
  const where = node.source_file ? ` in ${node.source_file}` : "";
  const space = node.space ? `, ${node.space}` : "";
  const offs = node.file_offset === null ? "" : `, file offset ${hex(node.file_offset, 6)}`;
  if (node.kind === "function") {
    const evidence = nodeEvidence(node);
    const head = /\.bat$/i.test(node.source_file ?? "")
      ? `Batch file ${node.source_file} (${node.id}): its listing shows each line under its line number; lines that start a program link to it.`
      : `Function at ${node.id}${where}${space}${offs}.`;
    const status = node.provisional === true
      ? " Provisional: no call or jump to it is proven; it is listed because the code builds its address and it decodes as a procedure, so it is probably a callback (callers marked as possible targets match only by record field offset)."
      : "";
    const stubs = graph.stubCallsTo(node.id);
    const via = stubs.length ? `\n${stubCallText(node, stubs)}` : "";
    return head + status + via + (evidence.length ? `\nEvidence:\n${evidence.map((l) => `- ${l}`).join("\n")}` : "");
  }
  if (node.kind === "address") return `Code address ${node.id}${where}${space}${offs} (a call/jump target the graph knows by address only, without a function listing).`;
  return `${node.id} is an unresolved transfer target: ${unresolvedReason(node)}.`;
}

// ---------------------------------------------------------------- module

export interface ModuleOutput {
  module: string;
  summary: string;
  implementation_status: string;
  listing: string;
  callers: string;
  callees: string;
  entrypoint_traces: string;
  tool_hint: string;
}
export type ModuleResult = { ok: true; output: ModuleOutput } | { ok: false; error: string };

function neighbourList(ctx: Context, implemented: ReadonlyMap<string, string>, entries: Array<{ node: string; edges: GraphEdge[] }>, limit: number, moreUri: string): string {
  if (entries.length === 0) return "None recorded in the call graph.";
  const lines = entries.slice(0, limit).map(({ node, edges }) => {
    const sites = edges.length > 1 ? `${edges.length} call sites, e.g. ${siteText(edges[0]!)}` : siteText(edges[0]!);
    return `- ${mark(ctx, implemented, node)} — ${sites} — ${urisOf(ctx).module(node)}`;
  });
  if (entries.length > limit) lines.push(`- … ${entries.length - limit} more: ${moreUri}`);
  return lines.join("\n");
}

export function lookupModule(ctx: Context, args: { module: string }): ModuleResult {
  const unitRoot = parseWorkUnitId(args.module);
  const resolved = ctx.graph.resolve(unitRoot ?? args.module);
  if (!resolved.ok) return resolved;
  const node = resolved.node;
  const note = unitRoot === undefined ? resolved.note : `"${args.module.trim()}" is a work unit; this is its root function. next_work with module "${args.module.trim()}" lists every member.`;
  const implemented = implementedNodes(ctx);
  const impls = ctx.progress.implementationsFor(node.id);
  const notes = ctx.progress.annotationsFor(node.id);

  const callers = ctx.graph.callersOf(node.id);
  const callees = ctx.graph.calleesOf(node.id);

  const { traces, targetIsRoot } = entrypointTraces(ctx.graph, node.id);
  let traceText: string;
  if (targetIsRoot) traceText = "This node is itself an entrypoint: nothing in the call graph calls it, and it calls others.";
  else if (traces.length === 0) {
    traceText = callers.length === 0
      ? "Unreachable: nothing calls this node and it calls nothing (an isolated address; reachable only through dispatch the graph could not trace, such as indirect calls or jump tables)."
      : "No entrypoint reaches this node: every chain of callers loops back on itself. Look for an indirect call, interrupt vector or callback that enters the cycle.";
  } else {
    const handle = ctx.cache.put(
      {
        title: `Entrypoint traces to ${node.id}`,
        description: `Shortest call chain from each of ${traces.length} entrypoints to ${node.id}, with call sites and branch conditions.`,
        mimeType: "text/markdown",
        text: `# Entrypoint traces to ${node.id}\n\n${traces.length} entrypoint(s) reach it (nearest first). Each chain lists the call site and the branch conditions that guard it.\n\n${traces.map((t, i) => `## ${i + 1}. ${t.nodes[0]} (${t.hops.length} hop${t.hops.length === 1 ? "" : "s"})\n\n${formatPath(ctx, implemented, t, true)}`).join("\n\n")}`,
      },
      TTL_LONG_MS,
      `entry-${node.id.replace(/[^\w-]/g, "_")}`,
    );
    const nearest = traces.slice(0, INLINE_TRACES);
    const shown = nearest.map((t) => `- ${formatPath(ctx, implemented, t, false)}`);
    traceText =
      `${traces.length} entrypoint${traces.length === 1 ? "" : "s"} (nodes nothing calls) reach this module; nearest ${shown.length}:\n${shown.join("\n")}` +
      (traces.length > shown.length ? `\n- … all ${traces.length} with call sites and conditions: ${urisOf(ctx).trace(handle)}` : `\nCall sites and conditions: ${urisOf(ctx).trace(handle)}`) +
      (nearest.some((t) => t.hops.some((h) => hopLink(h))) ? `\n${LINK_HOPS}` : "");
  }

  const file = listingFor(ctx.disassemblyRoot, node);

  const peers = getSameCode(ctx).peers(node.id);
  const coveredBy = implemented.get(node.id) || undefined;
  const records = (id: string) => ctx.progress.implementationsFor(id).map((i) => `${i.function} in ${i.file}`).join("; ");
  const status = impls.length
    ? `Implemented: ${records(node.id)}.${peers.length ? ` ${sameCodeText(peers)}: they count as implemented through this record.` : ""}`
    : coveredBy !== undefined
      ? `${sameCodeText(peers, coveredBy)}; implemented there as ${records(coveredBy)}: nothing to write here, call that implementation.`
      : peers.length
        ? `Not yet implemented. ${sameCodeText(peers)} (identical instructions, calling the same code): write it once, register it for any one of them, and it counts for all.`
        : "Not yet implemented (nothing registered with add_implementation).";
  const annotationText = notes.length ? ` ${notes.length} annotation(s): ${notes.slice(-3).map((n) => `[${n.annotation_type}] ${clip(n.description, 160)}`).join(" | ")}` : "";
  const plan = getWorkPlan(ctx);
  const workUnit = plan.units.get(plan.unitOf.get(node.id) ?? "");
  const workText = workUnit ? `\n${workUnitLine(plan, workUnit, urisOf(ctx))}` : "";

  const hints: string[] = [];
  const linkOnly = (c: { edges: GraphEdge[] }) => c.edges.every((e) => e.link !== undefined);
  const links = callees.filter(linkOnly);
  const unresolved = callees.filter((c) => !linkOnly(c) && ctx.graph.nodes.get(c.node)?.kind === "unknown-target");
  const plain = callees.length - links.length - unresolved.length;
  if (plain > 0) hints.push(`- Understand what it depends on first: the ${plain} callee(s) above${links.length ? " that are not links to other programs" : ""}; implement leaves before callers.`);
  if (callees.some((c) => c.edges.some((e) => e.link === undefined && e.through !== undefined && ctx.graph.nodes.get(e.target)?.kind === "function"))) {
    hints.push("- Callees reached `through` a variable or table are the procedures the program stores there: implement each such call as a call through a pointer that can hold exactly those procedures.");
  }
  for (const c of unresolved) {
    const reason = unresolvedReason(ctx.graph.nodes.get(c.node));
    hints.push(`- ${siteText(c.edges[0]!)} goes somewhere the graph cannot name (${reason}): ${adviceFor(reason)}.`);
  }
  if (links.length) {
    const how = [...new Set(links.flatMap((c) => c.edges.map((e) => e.link)))].join(", ");
    hints.push(`- ${links.length} callee(s) are other programs it reaches by a link (${how}): ${LINK_ADVICE}.`);
  }
  for (const c of links.filter((c) => ctx.graph.nodes.get(c.node)?.kind === "unknown-target")) {
    hints.push(`- ${siteText(c.edges[0]!)}, but that program is not in this tree: ${unresolvedReason(ctx.graph.nodes.get(c.node))}.`);
  }
  const linkCallers = callers.filter(linkOnly).length;
  if (linkCallers) {
    hints.push(`- ${linkCallers} caller(s) are other programs reaching it by a link (they run it, read its file, or raise an interrupt it answers): it is part of this program's interface to them, not a function they call.`);
  }
  if (traces.length && !targetIsRoot) hints.push("- To see how one particular caller reaches this module use the `trace` tool with `from` and `to`.");
  if (!file && node.kind === "function") hints.push("- No listing file was found for this function; check disassembly_root points at the tree this graph was generated from.");
  if (!impls.length && coveredBy === undefined && !notes.length) hints.push("- When you finish or learn something, record it with add_implementation or annotate so the next lookup shows it.");

  return {
    ok: true,
    output: {
      module: node.id,
      summary: (note ? `${note}\n\n` : "") + describeNode(ctx.graph, node),
      implementation_status: status + annotationText + workText,
      listing: file
        ? `This function's instructions, decoded from the binary by following its control flow (${(file.bytes / 1024).toFixed(1)} KB): ${urisOf(ctx).listing(node.id)}`
        : "No listing for this node.",
      callers: `${callers.length} caller${callers.length === 1 ? "" : "s"}:\n${neighbourList(ctx, implemented, callers, INLINE_NEIGHBOURS, urisOf(ctx).neighbors(node.id))}`,
      callees: `${callees.length} callee${callees.length === 1 ? "" : "s"}:\n${neighbourList(ctx, implemented, callees, INLINE_NEIGHBOURS, urisOf(ctx).neighbors(node.id))}`,
      entrypoint_traces: traceText,
      tool_hint: hints.join("\n") || "- Nothing further.",
    },
  };
}

export function renderModuleText(o: ModuleOutput): string {
  return [`# ${o.module}`, "", o.summary, "", o.implementation_status, "", `## Listing\n${o.listing}`, "", `## Callers\n${o.callers}`, "", `## Callees\n${o.callees}`, "", `## Entrypoint traces\n${o.entrypoint_traces}`, "", `## Hints\n${o.tool_hint}`].join("\n");
}

/** Complete callers and callees (module resource detail). */
export function renderNeighbors(ctx: Context, id: string): string | undefined {
  const node = ctx.graph.nodes.get(id);
  if (!node) return undefined;
  const implemented = implementedNodes(ctx);
  const render = (entries: Array<{ node: string; edges: GraphEdge[] }>) =>
    entries.map(({ node: n, edges }) => `- ${mark(ctx, implemented, n)} — ${urisOf(ctx).module(n)}\n${edges.map((e) => `    - ${siteText(e)}${describeConditions(e, 3)}`).join("\n")}`).join("\n");
  const callers = ctx.graph.callersOf(id);
  const callees = ctx.graph.calleesOf(id);
  return `# Callers and callees of ${id}\n\n## Callers (${callers.length})\n\n${render(callers) || "None"}\n\n## Callees (${callees.length})\n\n${render(callees) || "None"}`;
}

// ---------------------------------------------------------------- trace

export interface TraceOutput {
  from: string;
  to: string;
  result: string;
  shortest_path: string;
  other_paths: string;
  complete_trace: string;
  tool_hint: string;
}
export type TraceResult = { ok: true; output: TraceOutput } | { ok: false; error: string };

export function lookupTrace(ctx: Context, args: { from: string; to: string }): TraceResult {
  const a = ctx.graph.resolve(args.from);
  if (!a.ok) return { ok: false, error: `from: ${a.error}` };
  const b = ctx.graph.resolve(args.to);
  if (!b.ok) return { ok: false, error: `to: ${b.error}` };
  const implemented = implementedNodes(ctx);
  const from = a.node.id;
  const to = b.node.id;
  const readAs = [a.note, b.note].filter(Boolean).map((n) => `${n} `).join("");

  if (from === to) {
    return { ok: true, output: { from, to, result: `${readAs}from and to are the same node.`, shortest_path: from, other_paths: "None.", complete_trace: "n/a", tool_hint: "- Pass two different modules." } };
  }

  const found = findPaths(ctx.graph, from, to, { limit: 6, slack: 2, maxExpansions: 200_000 });
  if (found.shortest === undefined) {
    const hint = found.reverseReachable
      ? `- There IS a route the other way (${to} reaches ${from}); swap from and to.`
      : "- Neither direction is connected in the static call graph. Indirect calls, jump tables, interrupt vectors or callbacks may link them; check the callers of each with the `module` tool.";
    return { ok: true, output: { from, to, result: `${readAs}No call path from ${from} to ${to} in the call graph.`, shortest_path: "None.", other_paths: "None.", complete_trace: "n/a", tool_hint: hint } };
  }

  const [shortest, ...others] = found.paths;
  const handle = ctx.cache.put(
    {
      title: `Call paths ${from} → ${to}`,
      description: `${found.paths.length} loop-free call path(s) from ${from} to ${to}, shortest first, with every call site and branch condition.`,
      mimeType: "text/markdown",
      text: `# Call paths ${from} → ${to}\n\nShortest is ${found.shortest} hop(s).${found.truncated ? " The search was cut off by its work limit; more paths may exist." : ""}\n\n${found.paths.map((p, i) => `## Path ${i + 1} (${p.hops.length} hops)\n\n${formatPath(ctx, implemented, p, true)}`).join("\n\n")}`,
    },
    TTL_LONG_MS,
    `path-${from.replace(/[^\w-]/g, "_")}--${to.replace(/[^\w-]/g, "_")}`,
  );

  const hopsText = shortest!.hops.map((h, i) => {
    const e = h.edges[0];
    const extra = h.edges.length > 1 ? ` (+${h.edges.length - 1} more call sites)` : "";
    return `${i + 1}. ${h.from} → ${h.to}: ${e ? `${siteText(e)}${describeConditions(e)}` : "?"}${extra}`;
  });
  return {
    ok: true,
    output: {
      from,
      to,
      result: `${readAs}${from} reaches ${to} in ${found.shortest} hop${found.shortest === 1 ? "" : "s"}; ${found.paths.length} distinct loop-free path${found.paths.length === 1 ? "" : "s"} within 2 hops of the shortest${found.truncated ? " (search truncated)" : ""}.`,
      shortest_path: `${formatPath(ctx, implemented, shortest!, false)}\n${hopsText.join("\n")}`,
      other_paths: others.length ? others.map((p) => `- ${formatPath(ctx, implemented, p, false)} (${p.hops.length} hops)`).join("\n") : "No other paths within 2 hops of the shortest.",
      complete_trace: `All paths with call sites and conditions: ${urisOf(ctx).trace(handle)}`,
      tool_hint:
        "- Conditions in brackets are the branches taken (or not) on the way to each call; the call site offset locates them in the listing. Use `module` on any hop for its listing." +
        (found.paths.some((p) => p.hops.some((h) => hopLink(h))) ? `\n- ${LINK_HOPS}` : ""),
    },
  };
}
