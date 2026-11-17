import { statSync } from "node:fs";
import path from "node:path";
import { CallGraph } from "../graph/model.js";
import { buildWorkPlan, listingSize, type WorkUnitOptions } from "../graph/workunits.js";
import { fingerprintAll, matchUnits } from "./carry.js";
import { align, type Alignment } from "./diff.js";
import { alignmentTokens, fingerprintUnit, readInsns, type Insn, type UnitPrint } from "./fingerprint.js";

// Which function of game B is which function of game A (two games, or two builds of one), for reading them
// side by side. A game may hold several programs (e.g. MAIN.EXE and TOOL.EXE, each linking its own copy of the
// Turbo Pascal runtime), so programs are paired first, by the code they share (`pairPrograms`), and functions only
// within a program pair. Matches are found in rounds:
//   1. seeds: work units with the same code that no other unit of the two paired programs has (members pair by
//      position), then single functions with the same code that no other function of the two programs has
//      (fingerprint.ts);
//   2. from every match, the functions called at the same place in the aligned listings, and the only unmatched
//      callers of both, are proposed as matches; a proposal is taken when it is the best for both functions (most
//      proposals, then most similar code); new matches propose more, until nothing changes.
// Code may differ arbitrarily in step 2 (a gutted function is still found through its callers); `similarity` says
// how much of it lines up. Identical code shared by several functions is never paired by guessing, and functions of a
// program without a partner are never paired (their identical code elsewhere is still offered by `sameCode`).

export type Which = "a" | "b";

export interface Side {
  /** the tree's directory name: alpha, beta */
  name: string;
  disassemblyRoot: string;
  graph: CallGraph;
}

export interface Match {
  a: string;
  b: string;
  /** why they were paired */
  how: string;
  /** 0: paired by identical code (a seed); else how many matched neighbours proposed it */
  votes: number;
}

export interface Candidate {
  id: string;
  /** how many matched neighbours point at it */
  votes: number;
  how: string;
}

/** A callee of the pair: what A calls at a place, what B calls at the aligned place. */
export interface CallPair {
  a?: string;
  b?: string;
  /** "same": matched to each other; "other": either is matched to something else; "open": neither matched / one side missing */
  state: "same" | "other" | "open";
}

export interface PairDetail {
  a: string;
  b: string;
  aInsns: Insn[];
  bInsns: Insn[];
  alignment: Alignment;
  /** the instructions are the same once addresses are renamed (fingerprint.ts) */
  sameCode: boolean;
  calls: CallPair[];
  /** same code, and every callee pair is matched to each other */
  identical: boolean;
}

/** A program of each game and how much code they share. */
export interface ProgramPair {
  a: string;
  b: string;
  /** distinct function codes (fingerprint.ts) both programs have */
  shared: number;
  /** distinct function codes either program has */
  union: number;
}

export interface ProgramPairing {
  /** ascending by A's program */
  pairs: ProgramPair[];
  /** programs left without a partner and why, ascending by name */
  unpaired: Record<Which, Array<{ program: string; reason: string }>>;
}

/** A program as text: its file name ("the whole tree" for a tree without a programs table) and its game. */
export const programName = (program: string, game: string) => `${program || "the whole tree"} (${game})`;

interface Fn {
  insns: Insn[];
  tokens: string[];
  key: string;
  /** the program the function belongs to: CallGraph.programOf, else its source file, else "" */
  program: string;
}

const other = (w: Which): Which => (w === "a" ? "b" : "a");
const byText = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
const push = <K, V>(m: Map<K, V[]>, k: K, v: V) => (m.get(k) ?? m.set(k, []).get(k)!).push(v);
const listed = (xs: string[]) => (xs.length < 3 ? xs.join(" and ") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

/**
 * Pairs each program of game A with the program of game B whose code is most like its own, by the share of the two
 * programs' distinct function codes that both have (shared / union, Jaccard). A program's partner is its mutual
 * closest; a tie for the closest, or no code in common, leaves it unpaired. The share and not the shared count, so a
 * small tool pairs with the small tool that links the same runtime library rather than with the big game linking it
 * too, and a game program with the other game program. File names play no part.
 */
export function pairPrograms(codes: Record<Which, ReadonlyMap<string, ReadonlySet<string>>>, games: Record<Which, string>): ProgramPairing {
  const scores = new Map<string, { shared: number; union: number }>();
  const score = (pa: string, pb: string) => {
    const k = `${pa}\n${pb}`;
    let s = scores.get(k);
    if (!s) {
      const [x, y] = [codes.a.get(pa)!, codes.b.get(pb)!];
      let shared = 0;
      for (const key of x) if (y.has(key)) shared++;
      scores.set(k, (s = { shared, union: x.size + y.size - shared }));
    }
    return s;
  };
  const programs = (w: Which) => [...codes[w].keys()].sort(byText);
  // the programs of the other game sharing the largest share of code (several on a tie; none without shared code)
  const closest: Record<Which, Map<string, string[]>> = { a: new Map(), b: new Map() };
  for (const w of ["a", "b"] as const) {
    for (const p of programs(w)) {
      let best: string[] = [];
      let top = { shared: 0, union: 1 };
      for (const q of programs(other(w))) {
        const s = w === "a" ? score(p, q) : score(q, p);
        if (s.shared === 0) continue;
        // compared as fractions: no rounding can make or break a tie
        const cmp = s.shared * top.union - top.shared * s.union;
        if (cmp > 0) (best = [q]), (top = s);
        else if (cmp === 0) best.push(q);
      }
      closest[w].set(p, best);
    }
  }
  const name = (w: Which, p: string) => programName(p, games[w]);
  const out: ProgramPairing = { pairs: [], unpaired: { a: [], b: [] } };
  for (const w of ["a", "b"] as const) {
    const o = other(w);
    for (const p of programs(w)) {
      const near = closest[w].get(p)!;
      const back = near.length === 1 ? closest[o].get(near[0]!)! : [];
      if (back.length === 1 && back[0] === p) {
        if (w === "a") out.pairs.push({ a: p, b: near[0]!, ...score(p, near[0]!) });
        continue;
      }
      const reason =
        near.length === 0
          ? `it shares no code with any program of ${games[o]}`
          : near.length > 1
            ? `its code is equally close to ${listed(near.map((q) => name(o, q)))}`
            : `its code is closest to ${name(o, near[0]!)}, whose code is ${back.length > 1 ? `equally close to ${listed(back.map((q) => name(w, q)))}` : `closer to ${name(w, back[0]!)}`}`;
      out.unpaired[w].push({ program: p, reason });
    }
  }
  return out;
}

export class Correspondence {
  private readonly matched: Record<Which, Map<string, Match>> = { a: new Map(), b: new Map() };
  private readonly proposals: Record<Which, Map<string, Map<string, { votes: number; how: string }>>> = { a: new Map(), b: new Map() };
  private readonly fns: Record<Which, Map<string, Fn>> = { a: new Map(), b: new Map() };
  private readonly byKey: Record<Which, Map<string, string[]>> = { a: new Map(), b: new Map() };
  /** program -> code key -> its functions with that code */
  private readonly byKeyIn: Record<Which, Map<string, Map<string, string[]>>> = { a: new Map(), b: new Map() };
  /** program -> its partner program in the other game */
  private readonly partner: Record<Which, Map<string, string>> = { a: new Map(), b: new Map() };
  readonly programs: ProgramPairing;
  private readonly alignments = new Map<string, Alignment>();
  private readonly details = new Map<string, PairDetail>();

  constructor(
    readonly a: Side,
    readonly b: Side,
    options: WorkUnitOptions,
  ) {
    for (const w of ["a", "b"] as const) {
      const side = this[w];
      for (const node of side.graph.nodes.values()) {
        if (node.kind !== "function") continue;
        const insns = readInsns(side.disassemblyRoot, side.graph, node.id);
        // a batch file's listing holds command lines, no instructions: nothing to line up
        if (!insns?.length) continue;
        const { key } = fingerprintUnit(side.disassemblyRoot, side.graph, { id: node.id, root: node.id, members: [node.id] });
        const program = side.graph.programOf(node.id) ?? node.source_file ?? "";
        this.fns[w].set(node.id, { insns, tokens: alignmentTokens(side.graph, node.id, insns), key, program });
        push(this.byKey[w], key, node.id);
        push(this.byKeyIn[w].get(program) ?? this.byKeyIn[w].set(program, new Map()).get(program)!, key, node.id);
      }
    }
    const codes = (w: Which) => new Map([...this.byKeyIn[w]].map(([p, keys]) => [p, new Set(keys.keys())]));
    this.programs = pairPrograms({ a: codes("a"), b: codes("b") }, { a: a.name, b: b.name });
    for (const p of this.programs.pairs) (this.partner.a.set(p.a, p.b), this.partner.b.set(p.b, p.a));
    /** both have listings, and their programs are paired */
    const pairable = (a: string, b: string) => {
      const [fa, fb] = [this.fns.a.get(a), this.fns.b.get(b)];
      return fa !== undefined && fb !== undefined && this.partner.a.get(fa.program) === fb.program;
    };
    const queue: Match[] = [];
    const accept = (a: string, b: string, how: string, votes = 0) => {
      if (this.matched.a.has(a) || this.matched.b.has(b) || !pairable(a, b)) return;
      const m = { a, b, how, votes };
      this.matched.a.set(a, m);
      this.matched.b.set(b, m);
      queue.push(m);
    };

    // 1. seeds, within each program pair
    const unreadable: string[] = [];
    const unitsByProgram = (w: Which) => {
      const s = this[w];
      const byProgram = new Map<string, UnitPrint[]>();
      for (const u of fingerprintAll({ ...s, plan: buildWorkPlan(s.graph, new Set(), listingSize(s.disassemblyRoot, s.graph), options) }, unreadable)) {
        // a unit that fingerprints has a listing for every member, its root first
        const root = this.fns[w].get(u.members[0] ?? "");
        if (root) push(byProgram, root.program, u);
      }
      return byProgram;
    };
    const [aUnits, bUnits] = [unitsByProgram("a"), unitsByProgram("b")];
    const count = (keys: string[]) => keys.reduce((m, k) => m.set(k, (m.get(k) ?? 0) + 1), new Map<string, number>());
    for (const pair of this.programs.pairs) {
      // two trees without a programs table are one program each: no need to name it
      const within = pair.a === "" && pair.b === "" ? undefined : `${programName(pair.a, a.name)} or ${programName(pair.b, b.name)}`;
      const [aIn, bIn] = [aUnits.get(pair.a) ?? [], bUnits.get(pair.b) ?? []];
      const [aCount, bCount] = [count(aIn.map((u) => u.key)), count(bIn.map((u) => u.key))];
      // only units whose code is unique on both sides are used, so there is never a second candidate to order
      const { live } = matchUnits(aIn, bIn, () => 0, a.graph, b.graph);
      for (const { dst, candidates } of live) {
        if (aCount.get(dst.key) !== 1 || bCount.get(dst.key) !== 1) continue;
        const src = candidates[0]!;
        src.members.forEach((m, i) => accept(m, dst.members[i]!, `the same code as a whole work unit (${src.unit} ↔ ${dst.unit}), and no other unit${within ? ` of ${within}` : ""} has it`));
      }
      const there = this.byKeyIn.b.get(pair.b)!;
      for (const [key, ids] of this.byKeyIn.a.get(pair.a)!) {
        const same = there.get(key);
        if (ids.length === 1 && same?.length === 1) accept(ids[0]!, same[0]!, within ? `the same code, and no other function of ${within} has it` : "the same code, and no other function in either game has it");
      }
    }

    // 2. propagation
    const propose = (a: string, b: string, how: string) => {
      if (this.matched.a.has(a) || this.matched.b.has(b) || !pairable(a, b)) return;
      for (const [w, x, y] of [["a", a, b], ["b", b, a]] as const) {
        const row = this.proposals[w].get(x) ?? this.proposals[w].set(x, new Map()).get(x)!;
        const p = row.get(y);
        if (p) p.votes++;
        else row.set(y, { votes: 1, how });
      }
    };
    const unmatchedCallers = (w: Which, id: string) => this.callers(w, id).filter((c) => this.fns[w].has(c) && !this.matched[w].has(c));
    while (queue.length) {
      for (const m of queue.splice(0)) {
        for (const c of this.callPairs(m.a, m.b)) if (c.a && c.b) propose(c.a, c.b, `called at the same place by ${m.a} ↔ ${m.b}`);
        const [ca, cb] = [unmatchedCallers("a", m.a), unmatchedCallers("b", m.b)];
        if (ca.length === 1 && cb.length === 1) propose(ca[0]!, cb[0]!, `the only unmatched caller of ${m.a} ↔ ${m.b}`);
      }
      for (const [a, row] of this.proposals.a) {
        if (this.matched.a.has(a)) continue;
        const b = this.best("a", a, row);
        if (b === undefined) continue;
        if (this.best("b", b, this.proposals.b.get(b)!) === a) accept(a, b, row.get(b)!.how, row.get(b)!.votes);
      }
    }
  }

  /** A function's instructions (the listing as read). */
  listing(w: Which, id: string): Insn[] {
    return this.fns[w].get(id)?.insns ?? [];
  }

  /** The most proposed unmatched partner; ties go to the more similar code; a tie on both is no answer. */
  private best(w: Which, id: string, row: Map<string, { votes: number }>): string | undefined {
    const open = [...row].filter(([x]) => !this.matched[other(w)].has(x));
    if (open.length === 0) return undefined;
    const top = Math.max(...open.map(([, p]) => p.votes));
    const tied = open.filter(([, p]) => p.votes === top).map(([x]) => x);
    if (tied.length === 1) return tied[0];
    const score = tied.map((x) => (w === "a" ? this.alignmentOf(id, x) : this.alignmentOf(x, id)).similarity);
    const max = Math.max(...score);
    return score.filter((s) => s === max).length === 1 ? tied[score.indexOf(max)] : undefined;
  }

  private alignmentOf(a: string, b: string): Alignment {
    const k = `${a}\n${b}`;
    let al = this.alignments.get(k);
    if (!al) this.alignments.set(k, (al = align(this.fns.a.get(a)!.tokens, this.fns.b.get(b)!.tokens)));
    return al;
  }

  /** Function targets of the call or jump at an instruction (a link to another program is no call). */
  private targets(w: Which, id: string, ins: Insn): string[] {
    const side = this[w];
    const site = `${side.graph.nodes.get(id)!.space}:${ins.addr.toString(16).padStart(4, "0")}`.toLowerCase();
    return [...new Set((side.graph.bySite.get(site) ?? []).filter((e) => !e.link).map((e) => e.target))].filter((t) => side.graph.nodes.get(t)?.kind === "function");
  }

  /** What each function calls at aligned places: equal lines pair their targets; a changed stretch pairs its calls in order when both sides make as many. */
  private callPairs(a: string, b: string): CallPair[] {
    const fa = this.fns.a.get(a)!;
    const fb = this.fns.b.get(b)!;
    const out: CallPair[] = [];
    const seen = new Set<string>();
    const add = (x: string | undefined, y: string | undefined) => {
      const k = `${x}\n${y}`;
      if (seen.has(k)) return;
      seen.add(k);
      const mx = x === undefined ? undefined : this.matched.a.get(x);
      const my = y === undefined ? undefined : this.matched.b.get(y);
      const state = x !== undefined && y !== undefined && mx?.b === y ? "same" : mx || my ? "other" : "open";
      out.push({ ...(x === undefined ? {} : { a: x }), ...(y === undefined ? {} : { b: y }), state });
    };
    let runA: string[][] = [];
    let runB: string[][] = [];
    const flush = () => {
      if (runA.length === runB.length) runA.forEach((ta, i) => (ta.length === 1 && runB[i]!.length === 1 ? add(ta[0], runB[i]![0]) : (ta.forEach((t) => add(t, undefined)), runB[i]!.forEach((t) => add(undefined, t)))));
      else (runA.flat().forEach((t) => add(t, undefined)), runB.flat().forEach((t) => add(undefined, t)));
      runA = [];
      runB = [];
    };
    for (const r of this.alignmentOf(a, b).rows) {
      const ta = r.a === undefined ? [] : this.targets("a", a, fa.insns[r.a]!);
      const tb = r.b === undefined ? [] : this.targets("b", b, fb.insns[r.b]!);
      if (r.a !== undefined && r.b !== undefined) {
        flush();
        if (ta.length === 1 && tb.length === 1) add(ta[0], tb[0]);
        else (ta.forEach((t) => add(t, undefined)), tb.forEach((t) => add(undefined, t)));
      } else {
        if (ta.length) runA.push(ta);
        if (tb.length) runB.push(tb);
      }
    }
    flush();
    return out;
  }

  /** Nodes that call or jump to this one, once each; programs that reach it through a link (runs, loads, interrupt) are no callers. */
  callers(w: Which, id: string): string[] {
    return [...new Set((this[w].graph.into.get(id) ?? []).filter((e) => !e.link).map((e) => e.source))];
  }

  /** Whether the tree has a readable listing for this function. */
  has(w: Which, id: string): boolean {
    return this.fns[w].has(id);
  }

  counterpart(w: Which, id: string): Match | undefined {
    return this.matched[w].get(id);
  }

  /** Unmatched functions of the other game that matched neighbours point at, most votes first. */
  candidates(w: Which, id: string): Candidate[] {
    return [...(this.proposals[w].get(id) ?? [])]
      .filter(([x]) => !this.matched[other(w)].has(x))
      .map(([x, p]) => ({ id: x, votes: p.votes, how: p.how }))
      .sort((p, q) => q.votes - p.votes || byText(p.id, q.id));
  }

  /** Functions of the other game with exactly this function's code (addresses renamed). */
  sameCode(w: Which, id: string): string[] {
    const key = this.fns[w].get(id)?.key;
    return key === undefined ? [] : (this.byKey[other(w)].get(key) ?? []);
  }

  /** The program a function with a listing belongs to ("" in a tree without a programs table). */
  programOf(w: Which, id: string): string | undefined {
    return this.fns[w].get(id)?.program;
  }

  /** The program of the other game paired with this one, if any. */
  partnerProgram(w: Which, program: string): string | undefined {
    return this.partner[w].get(program);
  }

  /** Functions of one game with a listing, ascending by space then address. */
  functions(w: Which): string[] {
    const g = this[w].graph;
    return [...this.fns[w].keys()].sort((x, y) => {
      const [nx, ny] = [g.nodes.get(x)!, g.nodes.get(y)!];
      return byText(String(nx.space), String(ny.space)) || Number(nx.address) - Number(ny.address);
    });
  }

  get matches(): Match[] {
    return [...this.matched.a.values()];
  }

  /** Any two functions, matched or not, side by side. */
  detail(a: string, b: string): PairDetail {
    const k = `${a}\n${b}`;
    let d = this.details.get(k);
    if (!d) {
      const [fa, fb] = [this.fns.a.get(a)!, this.fns.b.get(b)!];
      const calls = this.callPairs(a, b);
      const sameCode = fa.key === fb.key;
      d = { a, b, aInsns: fa.insns, bInsns: fb.insns, alignment: this.alignmentOf(a, b), sameCode, calls, identical: sameCode && calls.every((c) => c.state === "same") };
      this.details.set(k, d);
    }
    return d;
  }
}

function mtime(root: string): string {
  try {
    return String(statSync(path.join(root, "navigation", "callgraph.json")).mtimeMs);
  } catch {
    return "absent";
  }
}

let shared: { key: string; value: Correspondence } | undefined;

/** One correspondence per process, rebuilt when either callgraph.json or the work unit sizes change. */
export function getCorrespondence(aRoot: string, bRoot: string, options: WorkUnitOptions, aGraph?: CallGraph): Correspondence {
  const key = [aRoot, mtime(aRoot), bRoot, mtime(bRoot), options.budgetLines, options.trivialLines].join("|");
  if (shared?.key !== key) {
    const side = (root: string, graph?: CallGraph): Side => ({ name: path.basename(path.resolve(root)), disassemblyRoot: root, graph: graph ?? CallGraph.load(root) });
    shared = { key, value: new Correspondence(side(aRoot, aGraph), side(bRoot), options) };
  }
  return shared.value;
}
