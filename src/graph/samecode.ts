import { functionPrint, type FunctionPrint } from "../compare/fingerprint.js";
import type { CallGraph } from "./model.js";

// Same code within one tree. Every program of a game links its own copy of the compiler's runtime library (Turbo
// Pascal's System unit in MAIN.EXE and TOOL.EXE), so the same routine turns up at several addresses. Two
// functions are the same code when
//   1. their code is equal as compare/fingerprint.ts normalises it (jumps inside as ordinals, absolute memory operands
//      and far pointers renamed in order of use, callees as external symbols; links to other programs are no callees),
//   2. the callee in each external position is the very same node or itself the same code, and
//   3. inside one program they read and write the same memory: the renaming in 1 lets a copy in another program keep
//      its variables elsewhere, but two getters of different variables in one program are different functions.
// The groups are the coarsest partition with these properties: start from the code keys, split by the groups of the
// callees until nothing changes (mutually recursive copies stay together), split a group whose members in one
// program differ in memory by that memory, and repeat. Implementing one member implements them all.

export class SameCode {
  /** groups of two or more functions, members ascending */
  readonly groups: ReadonlyArray<readonly string[]>;
  private readonly groupOf = new Map<string, readonly string[]>();

  constructor(groups: string[][]) {
    this.groups = groups.map((g) => [...g].sort()).sort((a, b) => (a[0]! < b[0]! ? -1 : 1));
    for (const g of this.groups) for (const id of g) this.groupOf.set(id, g);
  }

  /** The other functions with the same code as `id`, ascending; empty when it has none. */
  peers(id: string): string[] {
    return (this.groupOf.get(id) ?? []).filter((m) => m !== id);
  }

  /** Functions not implemented themselves whose same code is: id -> the implemented peer (lowest id) that covers it. */
  coverage(implemented: ReadonlySet<string>): Map<string, string> {
    const out = new Map<string, string>();
    for (const g of this.groups) {
      const by = g.find((m) => implemented.has(m));
      if (by !== undefined) for (const m of g) if (!implemented.has(m)) out.set(m, by);
    }
    return out;
  }
}

/** Same-code groups of every function with a readable listing (`print` is the normalisation, swappable in tests). */
export function findSameCode(disassemblyRoot: string, graph: CallGraph, print = functionPrint): SameCode {
  const prints = new Map<string, FunctionPrint>();
  for (const [id, node] of graph.nodes) {
    if (node.kind !== "function") continue;
    const p = print(disassemblyRoot, graph, id);
    if (p) prints.set(id, p);
  }
  // class numbers per round: equal strings get equal numbers; a round only ever splits classes, so an unchanged
  // count means an unchanged partition
  const classify = (sig: (id: string) => string): { of: Map<string, number>; count: number } => {
    const numbers = new Map<string, number>();
    const of = new Map<string, number>();
    for (const id of prints.keys()) {
      const s = sig(id);
      let n = numbers.get(s);
      if (n === undefined) numbers.set(s, (n = numbers.size));
      of.set(id, n);
    }
    return { of, count: numbers.size };
  };
  let cls = classify((id) => prints.get(id)!.key);
  for (;;) {
    for (;;) {
      const { of } = cls;
      const next = classify((id) => `${of.get(id)}|${prints.get(id)!.externals.map((x) => (of.has(x) ? `#${of.get(x)}` : x)).join(",")}`);
      const stable = next.count === cls.count;
      cls = next;
      if (stable) break;
    }
    // a class is split by memory when some program holds members of it that differ in memory
    const variants = new Map<string, Set<string>>();
    for (const [id, p] of prints) {
      const k = `${cls.of.get(id)}|${graph.programOf(id) ?? ""}`;
      (variants.get(k) ?? variants.set(k, new Set()).get(k)!).add(p.data.join(";"));
    }
    const split = new Set<number>();
    for (const [k, v] of variants) if (v.size > 1) split.add(Number(k.slice(0, k.indexOf("|"))));
    if (split.size === 0) break;
    const { of } = cls;
    cls = classify((id) => (split.has(of.get(id)!) ? `${of.get(id)}|${prints.get(id)!.data.join(";")}` : `${of.get(id)}`));
  }
  const members = new Map<number, string[]>();
  for (const [id, c] of cls.of) (members.get(c) ?? members.set(c, []).get(c)!).push(id);
  return new SameCode([...members.values()].filter((g) => g.length > 1));
}
