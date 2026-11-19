import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { listingFor } from "../graph/files.js";
import { nodeEvidence, siteText, unresolvedReason } from "../graph/indirect.js";
import { annotateListing, type AnnotatedListing } from "../graph/listing-targets.js";
import type { GraphEdge } from "../graph/model.js";
import { entrypointTraces } from "../graph/paths.js";
import { conditionText, urisOf, type Context } from "../graph/tools.js";
import { getSameCode, getWorkPlan, implementedNodes, nodeLines } from "../graph/workplan-cache.js";
import { parseWorkUnitId, type WorkPlan, type WorkUnit } from "../graph/workunits.js";
import type { AnnotationRecord, ImplementationRecord } from "../progress/store.js";

// JSON the dashboard (web/) renders: progress totals, every function's status, the work queue, one module in full.
// Built from the same call graph, progress.json and work plan the MCP tools use, so both always agree.

/** implemented; else whether its work unit can be started now (every unit it calls is complete) */
export type FunctionStatus = "implemented" | "ready" | "waiting";
export type UnitState = "complete" | "ready" | "waiting";

export interface SpaceStats {
  space: string;
  sourceFile: string | null;
  functions: number;
  implemented: number;
  lines: number;
  implementedLines: number;
}

export interface Activity {
  kind: "implementation" | "annotation";
  module: string;
  at: string;
  detail: string;
}

export interface UnitRow {
  id: string;
  root: string;
  members: number;
  implemented: number;
  lines: number;
  state: UnitState;
  oversized: boolean;
  indirect: number;
  unblocks: number;
  dependsOn: number;
  /** 1-based position in the next_work queue; null once complete */
  rank: number | null;
}

export interface Summary {
  /** --game-name, the Overview's title; null when not configured */
  gameName: string | null;
  version: string;
  disassemblyRoot: string;
  progressFile: string;
  /** `implemented` and `implementedLines` include `bySameCode`: functions implemented through a same-code peer's record */
  functions: { total: number; implemented: number; bySameCode: number; lines: number; implementedLines: number };
  units: { total: number; complete: number; ready: number; waiting: number; partial: number; oversized: number; indirect: number };
  annotations: number;
  spaces: SpaceStats[];
  /** cumulative implemented functions by UTC day of their first record */
  timeline: Array<{ date: string; implemented: number }>;
  recent: Activity[];
  next: UnitRow[];
}

export interface ModuleRow {
  id: string;
  space: string | null;
  address: number | null;
  lines: number;
  callers: number;
  callees: number;
  status: FunctionStatus;
  /** implemented through this same-code peer's record (see graph/samecode.ts); null otherwise */
  sameCodeAs: string | null;
  unit: string | null;
  annotations: number;
}

export interface Neighbour {
  id: string;
  kind: string;
  status: FunctionStatus | null;
  /** implemented through this same-code peer's record; null otherwise */
  sameCodeAs: string | null;
  /** each call site as the module tool words it (what it read through, a link to another program, "possible" caveats) */
  sites: Array<{ text: string; conditions: string[] }>;
  /** unknown-target: why the graph cannot name it */
  reason: string | null;
}

export interface UnitDetail extends UnitRow {
  memberList: Array<{ id: string; implemented: boolean; sameCodeAs: string | null; lines: number }>;
  dependsOnList: Array<{ id: string; state: UnitState }>;
  dependents: Array<{ id: string; state: UnitState }>;
  indirectCalls: string[];
}

/** One call along a trace: the site in the previous function and the function it reaches. */
export interface TraceHop {
  to: string;
  /** the call site as the module tool words it */
  text: string;
  conditions: string[];
  /** further call sites between the same two functions */
  otherSites: number;
}

export interface Traces {
  /** entrypoints (functions nothing calls that call something) reaching this node */
  total: number;
  /** the node is an entrypoint itself */
  targetIsRoot: boolean;
  /** shortest chain from each of the nearest entrypoints, nearest first */
  shown: Array<{ entry: string; hops: TraceHop[] }>;
}

/** Chains shown on a module page; `module` keeps the full list behind its trace resource. */
export const MODULE_PAGE_TRACES = 10;

export interface ModuleDetail {
  id: string;
  /** how the requested text was read, when it was an address rather than a node name */
  note: string | null;
  kind: string;
  space: string | null;
  address: number | null;
  fileOffset: number | null;
  sourceFile: string | null;
  entrypoint: boolean;
  /** function the graph lists only because its address is built somewhere */
  provisional: boolean;
  evidence: string[];
  /** unknown-target: why the graph cannot name it */
  reason: string | null;
  lines: number;
  status: FunctionStatus | null;
  /** other functions with the same code: one implementation serves all of them */
  sameCode: string[];
  /** the same-code peer whose implementation records cover this function, when it has none of its own */
  coveredBy: { id: string; implementations: ImplementationRecord[] } | null;
  implementations: ImplementationRecord[];
  annotations: AnnotationRecord[];
  callers: Neighbour[];
  callees: Neighbour[];
  /** null for nodes in no work unit: unresolved run-time targets and address-only nodes reached from 0 or 2+ places */
  unit: UnitDetail | null;
  /** how the program reaches it: the nearest entrypoints' call chains */
  traces: Traces;
  /** the listing with each line's call targets and links, structured (the listing resource serves the same as text) */
  listing: AnnotatedListing | null;
  /** that resource's URI (`disasm://<tree>/listing/<id>`), null when there is no listing */
  listingUri: string | null;
}

const RECENT = 15;
const NEXT = 10;

function mtime(file: string): string {
  try {
    return String(statSync(file).mtimeMs);
  } catch {
    return "absent";
  }
}

/** Changes whenever progress.json or callgraph.json is rewritten: the page polls it and refetches on change. */
export function dashboardVersion(ctx: Pick<Context, "disassemblyRoot" | "progress">): string {
  return `${ctx.progress.changeToken()}|${mtime(path.join(ctx.disassemblyRoot, "navigation", "callgraph.json"))}`;
}

function unitState(plan: WorkPlan, unit: WorkUnit): UnitState {
  if (unit.complete) return "complete";
  return unit.dependsOn.every((d) => plan.units.get(d)?.complete) ? "ready" : "waiting";
}

/** `done`: id -> "" (own record) or the same-code peer covering it (implementedNodes). */
function functionStatus(plan: WorkPlan, done: ReadonlyMap<string, string>, id: string): FunctionStatus {
  if (done.has(id)) return "implemented";
  // every function belongs to exactly one work unit
  return unitState(plan, plan.units.get(plan.unitOf.get(id)!)!) === "ready" ? "ready" : "waiting";
}

function rankOf(plan: WorkPlan): Map<string, number> {
  return new Map(plan.ranked.map((u, i) => [u.id, i + 1]));
}

function unitRow(plan: WorkPlan, ranks: ReadonlyMap<string, number>, unit: WorkUnit, ctx: Context): UnitRow {
  return {
    id: unit.id,
    root: unit.root,
    members: unit.members.filter((m) => ctx.graph.nodes.get(m)?.kind === "function").length,
    implemented: unit.implemented.length,
    lines: unit.lines,
    state: unitState(plan, unit),
    oversized: unit.oversized,
    indirect: unit.indirectCalls.length,
    unblocks: unit.unblocks,
    dependsOn: unit.dependsOn.length,
    rank: ranks.get(unit.id) ?? null,
  };
}

export function summary(ctx: Context, gameName: string | null = null): Summary {
  const plan = getWorkPlan(ctx);
  const sizeOf = nodeLines(ctx);
  const ranks = rankOf(plan);
  const { implementations, annotations } = ctx.progress.snapshot();
  const done = implementedNodes(ctx, new Set(implementations.map((r) => r.module)));
  let bySameCode = 0;

  const fns = [...ctx.graph.nodes.values()].filter((n) => n.kind === "function");
  const spaces = new Map<string, SpaceStats>();
  let lines = 0;
  let implementedLines = 0;
  let implementedCount = 0;
  for (const n of fns) {
    const size = sizeOf(n.id);
    const by = done.get(n.id);
    if (by) bySameCode++;
    const key = n.space ?? "(no space)";
    let s = spaces.get(key);
    if (!s) spaces.set(key, (s = { space: key, sourceFile: n.source_file, functions: 0, implemented: 0, lines: 0, implementedLines: 0 }));
    s.functions++;
    s.lines += size;
    lines += size;
    if (by !== undefined) {
      s.implemented++;
      s.implementedLines += size;
      implementedCount++;
      implementedLines += size;
    }
  }

  const units = { total: plan.units.size, complete: 0, ready: 0, waiting: 0, partial: 0, oversized: 0, indirect: 0 };
  for (const u of plan.units.values()) {
    units[unitState(plan, u)]++;
    if (!u.complete) {
      if (u.implemented.length > 0) units.partial++;
      if (u.oversized) units.oversized++;
      if (u.indirectCalls.length > 0) units.indirect++;
    }
  }

  // first record per graph function; re-registering refreshes recordedAt, so this is "first still on record". A
  // function implemented through same code counts from the earliest record of a peer.
  const first = new Map<string, string>();
  for (const r of implementations) {
    if (ctx.graph.nodes.get(r.module)?.kind !== "function") continue;
    const at = first.get(r.module);
    if (at === undefined || r.recordedAt < at) first.set(r.module, r.recordedAt);
  }
  const sameCode = getSameCode(ctx);
  for (const [id, by] of done) {
    if (!by || ctx.graph.nodes.get(id)?.kind !== "function") continue;
    const dates = sameCode.peers(id).flatMap((p) => (done.get(p) === "" && first.has(p) ? [first.get(p)!] : []));
    first.set(id, dates.sort()[0]!); // `by` is such a peer, so there is at least one
  }
  const perDay = new Map<string, number>();
  for (const at of first.values()) perDay.set(at.slice(0, 10), (perDay.get(at.slice(0, 10)) ?? 0) + 1);
  let running = 0;
  const timeline = [...perDay].sort(([a], [b]) => (a < b ? -1 : 1)).map(([date, n]) => ({ date, implemented: (running += n) }));

  const recent: Activity[] = [
    ...implementations.map((r): Activity => ({ kind: "implementation", module: r.module, at: r.recordedAt, detail: `${r.function} in ${r.file}` })),
    ...annotations.map((r): Activity => ({ kind: "annotation", module: r.module, at: r.recordedAt, detail: `[${r.annotation_type}] ${r.description}` })),
  ]
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .slice(0, RECENT);

  return {
    gameName,
    version: dashboardVersion(ctx),
    disassemblyRoot: ctx.disassemblyRoot,
    progressFile: ctx.progress.file,
    functions: { total: fns.length, implemented: implementedCount, bySameCode, lines, implementedLines },
    units,
    annotations: annotations.length,
    spaces: [...spaces.values()].sort((a, b) => (a.space < b.space ? -1 : 1)), // keys are unique
    timeline,
    recent,
    next: plan.ranked.slice(0, NEXT).map((u) => unitRow(plan, ranks, u, ctx)),
  };
}

/** Every function, ascending by space then address. */
export function moduleRows(ctx: Context): ModuleRow[] {
  const plan = getWorkPlan(ctx);
  const sizeOf = nodeLines(ctx);
  const { implementations, annotations } = ctx.progress.snapshot();
  const done = implementedNodes(ctx, new Set(implementations.map((r) => r.module)));
  const notes = new Map<string, number>();
  for (const a of annotations) notes.set(a.module, (notes.get(a.module) ?? 0) + 1);
  return [...ctx.graph.nodes.values()]
    .filter((n) => n.kind === "function")
    .sort((a, b) => ((a.space ?? "") < (b.space ?? "") ? -1 : (a.space ?? "") > (b.space ?? "") ? 1 : (a.address ?? 0) - (b.address ?? 0)))
    .map((n) => ({
      id: n.id,
      space: n.space,
      address: n.address,
      lines: sizeOf(n.id),
      callers: new Set((ctx.graph.into.get(n.id) ?? []).map((e) => e.source)).size,
      callees: new Set((ctx.graph.out.get(n.id) ?? []).map((e) => e.target)).size,
      status: functionStatus(plan, done, n.id),
      sameCodeAs: done.get(n.id) || null,
      unit: plan.unitOf.get(n.id)!,
      annotations: notes.get(n.id) ?? 0,
    }));
}

/** Every work unit: the next_work queue in rank order, then complete units by id. */
export function unitRows(ctx: Context): UnitRow[] {
  const plan = getWorkPlan(ctx);
  const ranks = rankOf(plan);
  const complete = [...plan.units.values()].filter((u) => u.complete).sort((a, b) => (a.id < b.id ? -1 : 1));
  return [...plan.ranked, ...complete].map((u) => unitRow(plan, ranks, u, ctx));
}

function tracesTo(ctx: Context, id: string): Traces {
  const { traces, targetIsRoot } = entrypointTraces(ctx.graph, id);
  return {
    total: traces.length,
    targetIsRoot,
    shown: traces.slice(0, MODULE_PAGE_TRACES).map((t) => ({
      entry: t.nodes[0]!,
      hops: t.hops.map((h) => {
        const e = h.edges[0]!; // the trace walked this edge backwards, so every hop has one
        return { to: h.to, text: siteText(e), conditions: e.conditions.map(conditionText), otherSites: h.edges.length - 1 };
      }),
    })),
  };
}

function neighbours(ctx: Context, plan: WorkPlan, done: ReadonlyMap<string, string>, edges: readonly GraphEdge[], key: (e: GraphEdge) => string): Neighbour[] {
  const byNode = new Map<string, Neighbour>();
  for (const e of edges) {
    const id = key(e);
    let n = byNode.get(id);
    if (!n) {
      const target = ctx.graph.nodes.get(id);
      const kind = target?.kind ?? "unknown";
      byNode.set(id, (n = { id, kind, status: kind === "function" ? functionStatus(plan, done, id) : null, sameCodeAs: done.get(id) || null, sites: [], reason: kind === "unknown-target" ? unresolvedReason(target) : null }));
    }
    n.sites.push({ text: siteText(e), conditions: e.conditions.map(conditionText) });
  }
  return [...byNode.values()];
}

/**
 * One node in full. `raw` is anything `module` accepts: a node name, a work unit id (its root), or an address as a
 * listing prints it. Unknown or ambiguous input returns the graph's own explanation.
 */
export function moduleDetail(ctx: Context, raw: string): { ok: true; detail: ModuleDetail } | { ok: false; error: string } {
  const unitRoot = parseWorkUnitId(raw);
  const resolved = ctx.graph.resolve(unitRoot ?? raw);
  if (!resolved.ok) return resolved;
  const node = resolved.node;
  const plan = getWorkPlan(ctx);
  const ranks = rankOf(plan);
  const sizeOf = nodeLines(ctx);
  const { implementations, annotations } = ctx.progress.snapshot();
  const done = implementedNodes(ctx, new Set(implementations.map((r) => r.module)));
  const coveredBy = done.get(node.id) || undefined;

  const unitId = plan.unitOf.get(node.id);
  const unit = unitId === undefined ? undefined : plan.units.get(unitId)!;
  const ref = (id: string) => ({ id, state: unitState(plan, plan.units.get(id)!) });
  const unitDetail: UnitDetail | null = unit
    ? {
        ...unitRow(plan, ranks, unit, ctx),
        memberList: unit.members.filter((m) => ctx.graph.nodes.get(m)?.kind === "function").map((m) => ({ id: m, implemented: done.has(m), sameCodeAs: done.get(m) || null, lines: sizeOf(m) })),
        dependsOnList: unit.dependsOn.map(ref),
        dependents: [...plan.units.values()].filter((u) => u.dependsOn.includes(unit.id)).map((u) => ref(u.id)),
        indirectCalls: unit.indirectCalls.map((c) => `${c.site}  ${c.instruction} — ${c.reason}`),
      }
    : null;

  let listing: AnnotatedListing | null = null;
  const file = listingFor(ctx.disassemblyRoot, node);
  if (file) {
    try {
      listing = annotateListing(ctx.graph, node, readFileSync(file.absPath, "utf8"));
    } catch {
      listing = null;
    }
  }

  return {
    ok: true,
    detail: {
      id: node.id,
      note: unitRoot === undefined ? (resolved.note ?? null) : `${raw.trim()} is a work unit; this is its root function.`,
      kind: node.kind,
      space: node.space,
      address: node.address,
      fileOffset: node.file_offset,
      sourceFile: node.source_file,
      entrypoint: node.entrypoint,
      provisional: node.provisional === true,
      evidence: node.kind === "function" ? nodeEvidence(node) : [],
      reason: node.kind === "unknown-target" ? unresolvedReason(node) : null,
      lines: sizeOf(node.id),
      status: node.kind === "function" ? functionStatus(plan, done, node.id) : null,
      sameCode: getSameCode(ctx).peers(node.id),
      coveredBy: coveredBy === undefined ? null : { id: coveredBy, implementations: implementations.filter((r) => r.module === coveredBy) },
      implementations: implementations.filter((r) => r.module === node.id),
      annotations: annotations.filter((r) => r.module === node.id),
      callers: neighbours(ctx, plan, done, ctx.graph.into.get(node.id) ?? [], (e) => e.source),
      callees: neighbours(ctx, plan, done, ctx.graph.out.get(node.id) ?? [], (e) => e.target),
      unit: unitDetail,
      traces: tracesTo(ctx, node.id),
      listing,
      listingUri: listing === null ? null : urisOf(ctx).listing(node.id),
    },
  };
}
