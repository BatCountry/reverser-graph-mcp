import type { CallGraph, GraphEdge } from "./model.js";

export interface Hop {
  from: string;
  to: string;
  /** every call/transfer site between the two nodes (usually 1) */
  edges: GraphEdge[];
}

export interface Path {
  nodes: string[];
  hops: Hop[];
}

function toPath(graph: CallGraph, nodes: string[]): Path {
  const hops: Hop[] = [];
  for (let i = 0; i + 1 < nodes.length; i++) {
    const from = nodes[i]!;
    const to = nodes[i + 1]!;
    hops.push({ from, to, edges: (graph.out.get(from) ?? []).filter((e) => e.target === to) });
  }
  return { nodes, hops };
}

/** Shortest path from every root (nothing calls it, it calls something) that reaches `target`, nearest root first. */
export function entrypointTraces(graph: CallGraph, target: string): { traces: Path[]; targetIsRoot: boolean } {
  // BFS over reversed edges: parent[x] = the node x calls first on its way to target.
  const next = new Map<string, string>();
  const seen = new Set<string>([target]);
  const queue: string[] = [target];
  const roots: string[] = [];
  for (let i = 0; i < queue.length; i++) {
    const cur = queue[i]!;
    for (const e of graph.into.get(cur) ?? []) {
      if (seen.has(e.source)) continue;
      seen.add(e.source);
      next.set(e.source, cur);
      queue.push(e.source);
      if (graph.isRoot(e.source)) roots.push(e.source);
    }
  }
  const traces = roots.map((root) => {
    const nodes = [root];
    for (let cur = root; cur !== target;) {
      cur = next.get(cur)!;
      nodes.push(cur);
    }
    return toPath(graph, nodes);
  });
  // BFS order already yields nondecreasing distance, so `roots` is nearest first.
  return { traces, targetIsRoot: graph.isRoot(target) };
}

function bfsDistances(start: string, neighbours: (id: string) => Iterable<string>): Map<string, number> {
  const dist = new Map<string, number>([[start, 0]]);
  const queue = [start];
  for (let i = 0; i < queue.length; i++) {
    const cur = queue[i]!;
    for (const n of neighbours(cur)) {
      if (!dist.has(n)) {
        dist.set(n, dist.get(cur)! + 1);
        queue.push(n);
      }
    }
  }
  return dist;
}

export interface FindPathsOptions {
  /** maximum number of paths to return */
  limit: number;
  /** also return paths up to this many hops longer than the shortest */
  slack: number;
  /** DFS node-expansion budget across the whole search; exceeding it ends the search with truncated=true */
  maxExpansions: number;
}

export interface FindPathsResult {
  paths: Path[];
  shortest: number | undefined;
  truncated: boolean;
  /** true if some route exists in the reverse direction (to -> from) */
  reverseReachable: boolean;
}

/** Simple (loop-free) paths from `from` to `to`, shortest first, via iterative deepening pruned by exact distance-to-target. */
export function findPaths(graph: CallGraph, from: string, to: string, opts: FindPathsOptions): FindPathsResult {
  const toTarget = bfsDistances(to, (id) => (graph.into.get(id) ?? []).map((e) => e.source));
  const shortest = toTarget.get(from);
  if (shortest === undefined) {
    const reverse = bfsDistances(to, (id) => (graph.out.get(id) ?? []).map((e) => e.target));
    return { paths: [], shortest: undefined, truncated: false, reverseReachable: reverse.has(from) };
  }
  const paths: Path[] = [];
  let expansions = 0;
  let truncated = false;

  const dfs = (cur: string, budget: number, trail: string[], onTrail: Set<string>, exactLen: number): void => {
    if (paths.length >= opts.limit || truncated) return;
    if (cur === to) {
      if (trail.length - 1 === exactLen) paths.push(toPath(graph, [...trail]));
      return;
    }
    if (++expansions > opts.maxExpansions) {
      truncated = true;
      return;
    }
    const seenNext = new Set<string>();
    for (const e of graph.out.get(cur) ?? []) {
      const n = e.target;
      if (seenNext.has(n) || onTrail.has(n)) continue;
      seenNext.add(n);
      const d = toTarget.get(n);
      if (d === undefined || d + 1 > budget) continue;
      trail.push(n);
      onTrail.add(n);
      dfs(n, budget - 1, trail, onTrail, exactLen);
      onTrail.delete(n);
      trail.pop();
    }
  };

  for (let len = shortest; len <= shortest + opts.slack && paths.length < opts.limit && !truncated; len++) {
    dfs(from, len, [from], new Set([from]), len);
  }
  return { paths, shortest, truncated, reverseReachable: false };
}
