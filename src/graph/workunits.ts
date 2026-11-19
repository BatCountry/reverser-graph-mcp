import { readFileSync } from "node:fs";
import { listingFor } from "./files.js";
import { unresolvedReason } from "./indirect.js";
import type { CallGraph } from "./model.js";

// Work units: the call graph partitioned into bounded, single-entry pieces a model can reimplement in one sitting,
// plus a ranking of which incomplete piece to do next.
//
// 1. Strongly connected components (mutual recursion) collapse into one condensed node.
// 2. A condensed node with exactly one distinct caller is owned by that caller; the rest are roots. Calls through
//    stored pointers (edges with `through` into a function: table entries, callbacks) take no part in this: the
//    procedures stored there are entries of their own, and an interpreter whose handlers call back into its
//    dispatcher would otherwise fuse into one recursive group of a hundred functions (they do order units, step 6).
//    Each root plus everything it transitively owns is a candidate work unit. A root with no function in it (a call
//    through a run-time address or an address-only node, reached from 0 or 2+ places) has nothing to write and is no
//    work unit; such nodes owned by a single caller stay listed in the caller's unit. Links to other programs (edges
//    with `link`: an interrupt a resident driver answers, a program launch, a file read) take no part in this or in
//    dependencies: the game does not need its sound driver written first, and each program (and batch file) roots
//    units of its own.
// 3. A candidate over budget is split: every non-trivial owned child (size >= trivialLines, or it calls something)
//    becomes its own candidate root, recursively; trivial leaf children stay with the parent.
// 4. Whatever is still over budget is flagged oversized (usually one monolithic function).
// 5. Members, size and completion of each unit.
// 6. A unit depends on every unit its members call. A call through a stored pointer counts like a direct call unless
//    the target's unit already waits on the caller's: there the program recurses through the pointer (a script
//    command that runs the interpreter again), one side has to exist first, and it is the caller, which is listed
//    in `callsBack`. Dependencies therefore never form a cycle, so while work remains some unit is ready.
// Implemented nodes never change the partition; they only mark members done.

export interface WorkUnitOptions {
  budgetLines: number;
  trivialLines: number;
}

export const DEFAULT_WORK_UNIT_OPTIONS: WorkUnitOptions = { budgetLines: 600, trivialLines: 20 };

export interface WorkUnit {
  /** `work:${root}` */
  id: string;
  /** root node id */
  root: string;
  /** node ids incl. root, root first then ascending */
  members: string[];
  /** total listing lines of the members */
  lines: number;
  oversized: boolean;
  /** work unit ids this unit calls into */
  dependsOn: string[];
  /** node ids outside the unit that members call */
  externalCallees: string[];
  /** function members that are implemented */
  implemented: string[];
  /** every function member is implemented */
  complete: boolean;
  /** fraction of dependency units that are complete; 1 with no dependencies */
  readiness: number;
  /** number of incomplete units that depend on this one */
  unblocks: number;
  /** members' transfers the graph cannot resolve to a function, with the generator's reason */
  indirectCalls: IndirectCall[];
  /** functions members call through stored pointers that are no dependency: their work units wait on this one */
  callsBack: string[];
}

export interface IndirectCall {
  site: string;
  instruction: string;
  reason: string;
}

export interface WorkPlan {
  units: ReadonlyMap<string, WorkUnit>;
  /** node id -> work unit id; absent for nodes in no work unit (see step 2) */
  unitOf: ReadonlyMap<string, string>;
  /** incomplete units, best first */
  ranked: WorkUnit[];
}

const PREFIX = "work:";

/** The id of the work unit rooted at `root`. */
export function workUnitId(root: string): string {
  return `${PREFIX}${root}`;
}

/** "work:X" (prefix case-insensitive, surrounding whitespace allowed) -> "X"; anything else undefined. */
export function parseWorkUnitId(s: string): string | undefined {
  const t = s.trim();
  if (t.slice(0, PREFIX.length).toLowerCase() !== PREFIX) return undefined;
  const id = t.slice(PREFIX.length).trim();
  return id === "" ? undefined : id;
}

function checkOptions(options: WorkUnitOptions): void {
  for (const key of ["budgetLines", "trivialLines"] as const) {
    const v = options[key];
    if (!Number.isInteger(v) || v <= 0) throw new RangeError(`${key} must be a positive whole number of lines, got ${v}`);
  }
}

/** Memoized size of a node: non-blank lines of its listing; 0 when it has none or it cannot be read. */
export function listingSize(disassemblyRoot: string, graph: CallGraph): (nodeId: string) => number {
  const memo = new Map<string, number>();
  return (nodeId) => {
    let size = memo.get(nodeId);
    if (size !== undefined) return size;
    size = 0;
    const node = graph.nodes.get(nodeId);
    const best = node ? listingFor(disassemblyRoot, node) : undefined;
    if (best) {
      try {
        for (const line of readFileSync(best.absPath, "utf8").split("\n")) if (line.trim() !== "") size++;
      } catch {
        size = 0;
      }
    }
    memo.set(nodeId, size);
    return size;
  };
}

/** Iterative Tarjan. Components come out in reverse topological order: callees before callers. */
function stronglyConnected(adj: readonly number[][]): { comp: Int32Array; count: number } {
  const n = adj.length;
  const index = new Int32Array(n).fill(-1);
  const low = new Int32Array(n);
  const onStack = new Uint8Array(n);
  const comp = new Int32Array(n).fill(-1);
  const stack: number[] = [];
  const work: Array<[node: number, next: number]> = [];
  let counter = 0;
  let count = 0;
  for (let s = 0; s < n; s++) {
    if (index[s] !== -1) continue;
    work.push([s, 0]);
    index[s] = low[s] = counter++;
    stack.push(s);
    onStack[s] = 1;
    while (work.length) {
      const frame = work[work.length - 1]!;
      const v = frame[0];
      const edges = adj[v]!;
      if (frame[1] < edges.length) {
        const w = edges[frame[1]++]!;
        if (index[w] === -1) {
          index[w] = low[w] = counter++;
          stack.push(w);
          onStack[w] = 1;
          work.push([w, 0]);
        } else if (onStack[w]) {
          low[v] = Math.min(low[v]!, index[w]!);
        }
        continue;
      }
      work.pop();
      if (work.length) {
        const parent = work[work.length - 1]![0];
        low[parent] = Math.min(low[parent]!, low[v]!);
      }
      if (low[v] === index[v]) {
        let w: number;
        do {
          w = stack.pop()!;
          onStack[w] = 0;
          comp[w] = count;
        } while (w !== v);
        count++;
      }
    }
  }
  return { comp, count };
}

export function buildWorkPlan(
  graph: CallGraph,
  implemented: ReadonlySet<string>,
  sizeOf: (nodeId: string) => number,
  options: WorkUnitOptions = DEFAULT_WORK_UNIT_OPTIONS,
): WorkPlan {
  checkOptions(options);
  const { budgetLines, trivialLines } = options;

  // ---- node-level adjacency (deduplicated, no self-edges, only edges between known nodes, no calls through pointers,
  // no links to other programs)
  const ids = [...graph.nodes.keys()];
  const at = new Map(ids.map((id, i) => [id, i]));
  const size = ids.map((id) => sizeOf(id));
  const adj: number[][] = ids.map((id) => {
    const targets = new Set<number>();
    for (const e of graph.out.get(id) ?? []) {
      const t = at.get(e.target);
      if (t === undefined || e.target === id) continue;
      if (e.link !== undefined || (e.through !== undefined && graph.nodes.get(e.target)!.kind === "function")) continue;
      targets.add(t);
    }
    return [...targets];
  });

  // ---- 1. condense SCCs
  const { comp, count } = stronglyConnected(adj);
  const compMembers: number[][] = Array.from({ length: count }, () => []);
  for (let v = 0; v < ids.length; v++) compMembers[comp[v]!]!.push(v);
  const compSize = new Float64Array(count);
  const compCallers: Array<Set<number>> = Array.from({ length: count }, () => new Set());
  const compCalls = new Uint8Array(count);
  for (let v = 0; v < ids.length; v++) {
    const c = comp[v]!;
    compSize[c]! += size[v]!;
    for (const w of adj[v]!) {
      const d = comp[w]!;
      if (d === c) continue;
      compCalls[c] = 1;
      compCallers[d]!.add(c);
    }
  }

  // ---- 2. ownership forest
  const owner = new Int32Array(count).fill(-1);
  const children: number[][] = Array.from({ length: count }, () => []);
  for (let c = 0; c < count; c++) {
    if (compCallers[c]!.size !== 1) continue;
    const [o] = compCallers[c]!;
    owner[c] = o!;
    children[o!]!.push(c);
  }
  // owners are callers, so they complete after their children in Tarjan order: one forward pass sums subtrees
  const total = new Float64Array(count);
  for (let c = 0; c < count; c++) {
    total[c]! += compSize[c]!;
    if (owner[c] !== -1) total[owner[c]!]! += total[c]!;
  }

  // ---- 3. walk-back split: assign every condensed node to the condensed root of its work unit. A root with no
  // function in it (an unresolved run-time target or an address-only node with 0 or 2+ callers) is not a work unit:
  // there is nothing to write, so it would only ever count as vacuously complete. Its children start their own.
  const hasFunction = compMembers.map((vs) => vs.some((v) => graph.nodes.get(ids[v]!)!.kind === "function"));
  const unitRoot = new Int32Array(count).fill(-1);
  const pending: number[] = [];
  for (let c = 0; c < count; c++) if (owner[c] === -1) pending.push(c);
  while (pending.length) {
    const r = pending.pop()!;
    if (!hasFunction[r]) {
      pending.push(...children[r]!);
      continue;
    }
    unitRoot[r] = r;
    if (total[r]! <= budgetLines) {
      const walk = [...children[r]!];
      while (walk.length) {
        const c = walk.pop()!;
        unitRoot[c] = r;
        walk.push(...children[c]!);
      }
      continue;
    }
    for (const c of children[r]!) {
      // a trivial child calls nothing, so it owns nothing: folding it never drags in more
      if (compSize[c]! < trivialLines && !compCalls[c]) unitRoot[c] = r;
      else pending.push(c);
    }
  }

  // ---- assemble units
  // An SCC root is named by the member its external callers reach (lowest id among those), else its lowest id.
  const rootName = (c: number): string => {
    const members = compMembers[c]!.map((v) => ids[v]!).sort(ascending);
    if (members.length === 1) return members[0]!;
    const entered = members.filter((id) => (graph.into.get(id) ?? []).some((e) => {
      const s = at.get(e.source);
      return s !== undefined && comp[s] !== c;
    }));
    return entered[0] ?? members[0]!;
  };
  const unitNodes = new Map<number, number[]>();
  for (let c = 0; c < count; c++) {
    const r = unitRoot[c]!;
    if (r === -1) continue;
    let list = unitNodes.get(r);
    if (!list) unitNodes.set(r, (list = []));
    list.push(...compMembers[c]!);
  }
  const unitOfIndex = new Array<string | undefined>(ids.length);
  const units = new Map<string, WorkUnit>();
  for (const [r, nodes] of unitNodes) {
    const root = rootName(r);
    const id = workUnitId(root);
    const members = [root, ...nodes.map((v) => ids[v]!).filter((m) => m !== root).sort(ascending)];
    let lines = 0;
    for (const v of nodes) {
      unitOfIndex[v] = id;
      lines += size[v]!;
    }
    const functions = members.filter((m) => graph.nodes.get(m)!.kind === "function");
    const done = functions.filter((m) => implemented.has(m));
    const indirectCalls = members.flatMap((m) =>
      (graph.out.get(m) ?? [])
        .filter((e) => e.link === undefined && graph.nodes.get(e.target)?.kind === "unknown-target")
        .map((e) => ({ site: e.instruction_offset, instruction: e.instruction, reason: unresolvedReason(graph.nodes.get(e.target)) })),
    );
    units.set(id, {
      id, root, members, lines, oversized: lines > budgetLines, dependsOn: [], externalCallees: [],
      implemented: done, complete: done.length === functions.length, readiness: 1, unblocks: 0, indirectCalls, callsBack: [],
    });
  }

  // ---- 6. dependencies, readiness, unblocks
  const calls = new Map<string, { callees: Set<string>; deps: Set<string>; back: Set<string> }>();
  const pointerCalls: Array<{ from: string; target: string; to: string }> = [];
  for (const unit of units.values()) {
    const callees = new Set<string>();
    const deps = new Set<string>();
    calls.set(unit.id, { callees, deps, back: new Set() });
    for (const m of unit.members) {
      for (const w of adj[at.get(m)!]!) {
        const other = unitOfIndex[w];
        if (other === undefined || other === unit.id) continue;
        callees.add(ids[w]!);
        deps.add(other);
      }
      for (const e of graph.out.get(m) ?? []) {
        if (e.link !== undefined || e.through === undefined || graph.nodes.get(e.target)?.kind !== "function") continue;
        const to = unitOfIndex[at.get(e.target)!]!; // every function is in a unit
        if (to !== unit.id) pointerCalls.push({ from: unit.id, target: e.target, to });
      }
    }
  }
  const waitsOn = (unit: string, other: string): boolean => {
    const seen = new Set([unit]);
    const stack = [unit];
    while (stack.length) {
      const u = stack.pop()!;
      if (u === other) return true;
      for (const d of calls.get(u)!.deps) {
        if (seen.has(d)) continue;
        seen.add(d);
        stack.push(d);
      }
    }
    return false;
  };
  // in id order, so a cycle made only of pointer calls breaks at the same call whatever order the graph lists edges in
  pointerCalls.sort((a, b) => ascending(a.from, b.from) || ascending(a.target, b.target));
  for (const { from, target, to } of pointerCalls) {
    const c = calls.get(from)!;
    if (waitsOn(to, from)) {
      c.back.add(target);
    } else {
      c.callees.add(target);
      c.deps.add(to);
    }
  }
  for (const unit of units.values()) {
    const c = calls.get(unit.id)!;
    unit.externalCallees = [...c.callees].sort(ascending);
    unit.dependsOn = [...c.deps].sort(ascending);
    unit.callsBack = [...c.back].sort(ascending);
  }
  for (const unit of units.values()) {
    if (unit.dependsOn.length) unit.readiness = unit.dependsOn.filter((d) => units.get(d)!.complete).length / unit.dependsOn.length;
    if (!unit.complete) for (const d of unit.dependsOn) units.get(d)!.unblocks++;
  }

  const unitOf = new Map<string, string>();
  ids.forEach((id, v) => {
    const owned = unitOfIndex[v];
    if (owned !== undefined) unitOf.set(id, owned);
  });
  const ranked = [...units.values()].filter((u) => !u.complete).sort((a, b) => compareWorkUnits(a, b, budgetLines));
  return { units, unitOf, ranked };
}

/**
 * Which incomplete unit to implement next; negative when `a` comes first. Criteria, in order:
 *   1. fully ready (every dependency unit complete) before anything still waiting on others;
 *   2. no calls through run-time computed addresses before units with them (dispatchers need a function-pointer
 *      table whose entries are implemented elsewhere, so they come last among ready units);
 *   3. more `unblocks` first: finishing it lets more incomplete units progress;
 *   4. not oversized before oversized;
 *   5. smaller interface (fewer distinct external callees to understand) first;
 *   6. size closer to the budget first, so tiny fragments don't crowd out substantial work;
 *   7. id ascending, for a stable order.
 */
export function compareWorkUnits(a: WorkUnit, b: WorkUnit, budgetLines: number): number {
  return (
    Number(b.readiness === 1) - Number(a.readiness === 1) ||
    Number(a.indirectCalls.length > 0) - Number(b.indirectCalls.length > 0) ||
    b.unblocks - a.unblocks ||
    Number(a.oversized) - Number(b.oversized) ||
    a.externalCallees.length - b.externalCallees.length ||
    Math.abs(budgetLines - a.lines) - Math.abs(budgetLines - b.lines) ||
    ascending(a.id, b.id)
  );
}

function ascending(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
