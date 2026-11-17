import type { CallGraph } from "../graph/model.js";
import type { WorkPlan } from "../graph/workunits.js";
import type { AnnotationRecord, AnnotationReference, ImplementationRecord, ProgressStore } from "../progress/store.js";
import { fingerprintUnit, type UnitPrint } from "./fingerprint.js";

// Carrying progress from one tree to another: a destination work unit whose code matches a source work unit
// (fingerprint.ts) receives that unit's implementation records and annotations, member by member.
//
// Same code is not enough when the unit calls out: `call X0; call X1` matches whichever two functions it calls.
// So the calls must also agree with every other match: a function that belongs to a matched unit on one side may
// only correspond to a function at the same position of a unit with the same code on the other side, and a callee
// with no match may stand for only one function of each program across all matches (each program of a game links
// its own copy of shared library code, e.g. the Turbo Pascal runtime in MAIN.EXE and TOOL.EXE).
// Units that break this are dropped, which can unmatch others in turn, until nothing changes.

export interface Tree {
  /** name used for references that cannot be translated, e.g. "alpha" */
  name: string;
  disassemblyRoot: string;
  graph: CallGraph;
  plan: WorkPlan;
  progress: ProgressStore;
}

export interface Carried {
  source: string;
  destination: string;
  /** other source units with the same code and progress of their own (any of them would do; `source` was taken) */
  alternatives: string[];
  /** destination member <- source member, canonical order */
  members: Array<[string, string]>;
  implementations: Array<Omit<ImplementationRecord, "recordedAt">>;
  annotations: Array<Omit<AnnotationRecord, "recordedAt">>;
}

export interface CarryPlan {
  sourceUnits: number;
  destinationUnits: number;
  /** destination units whose code matches a source unit, calls included */
  matched: number;
  /** matched units that receive at least one record */
  carried: Carried[];
  /** same code, but calls to functions that correspond to something else: left alone */
  rejected: Array<{ destination: string; source: string; reason: string }>;
  /** units that could not be fingerprinted (a member's listing is missing) */
  unreadable: string[];
}

type Records = { implementations: ImplementationRecord[]; annotations: AnnotationRecord[] };

function byModule<T extends { module: string }>(records: T[]): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of records) (m.get(r.module) ?? m.set(r.module, []).get(r.module)!).push(r);
  return m;
}

/** What `source` would give to `destination`, translated to destination node ids. */
function translate(src: UnitPrint, dst: UnitPrint, records: { impl: Map<string, ImplementationRecord[]>; notes: Map<string, AnnotationRecord[]> }, sourceName: string): Pick<Carried, "members" | "implementations" | "annotations"> {
  const rename = new Map<string, string>([
    ...src.members.map((m, i) => [m, dst.members[i]!] as const),
    ...src.externals.map((x, i) => [x, dst.externals[i]!] as const),
  ]);
  const ref = (r: AnnotationReference): AnnotationReference => {
    if (r.reference_type !== "module") return r;
    const to = rename.get(r.reference_content);
    return to ? { reference_type: "module", reference_content: to } : { reference_type: "freeform", reference_content: `${sourceName} ${r.reference_content}` };
  };
  const members = src.members.map((m, i) => [dst.members[i]!, m] as [string, string]);
  return {
    members,
    implementations: members.flatMap(([to, from]) => (records.impl.get(from) ?? []).map((r) => ({ module: to, file: r.file, function: r.function }))),
    annotations: members.flatMap(([to, from]) =>
      (records.notes.get(from) ?? []).map((r) => ({ module: to, annotation_type: r.annotation_type, description: r.description, references: r.references.map(ref) })),
    ),
  };
}

const noteKey = (r: Omit<AnnotationRecord, "recordedAt">) => JSON.stringify([r.module, r.annotation_type, r.description, r.references]);

export interface UnitPair {
  dst: UnitPrint;
  /** every source unit with the same code, preferred first */
  candidates: UnitPrint[];
}

export function fingerprintAll(tree: Pick<Tree, "name" | "disassemblyRoot" | "graph" | "plan">, unreadable: string[]): UnitPrint[] {
  const prints: UnitPrint[] = [];
  for (const u of tree.plan.units.values()) {
    const p = fingerprintUnit(tree.disassemblyRoot, tree.graph, u);
    if (p.missing) unreadable.push(`${tree.name} ${p.unit}: ${p.missing}`);
    else prints.push(p);
  }
  return prints;
}

/**
 * Destination units paired with the source units of the same code whose calls agree with every other match.
 * `prefer` orders identical source candidates for one destination unit (negative: `a` first); the graphs say which
 * program each callee belongs to.
 */
export function matchUnits(srcPrints: UnitPrint[], dstPrints: UnitPrint[], prefer: (a: UnitPrint, b: UnitPrint, dst: UnitPrint) => number,
  srcGraph: CallGraph, dstGraph: CallGraph): { live: UnitPair[]; rejected: CarryPlan["rejected"] } {
  const bySourceKey = new Map<string, UnitPrint[]>();
  for (const p of srcPrints) (bySourceKey.get(p.key) ?? bySourceKey.set(p.key, []).get(p.key)!).push(p);
  const pairs: UnitPair[] = dstPrints.flatMap((dst) => {
    const candidates = bySourceKey.get(dst.key);
    return candidates ? [{ dst, candidates: [...candidates].sort((a, b) => prefer(a, b, dst)) }] : [];
  });
  return consistent(pairs, srcPrints, dstPrints, srcGraph, dstGraph);
}

/** function -> its unit's fingerprint and its position among the members */
type Positions = Map<string, { key: string; i: number }>;

/** Drops pairs whose calls disagree with the other matches (see the header), until the rest agree. */
function consistent(pairs: UnitPair[], srcPrints: UnitPrint[], dstPrints: UnitPrint[], srcGraph: CallGraph, dstGraph: CallGraph): { live: UnitPair[]; rejected: CarryPlan["rejected"] } {
  const position = (prints: UnitPrint[]): Positions => new Map(prints.flatMap((p) => p.members.map((m, i) => [m, { key: p.key, i }] as const)));
  const srcPos = position(srcPrints);
  const dstPos = position(dstPrints);
  const rejected: CarryPlan["rejected"] = [];
  let live = pairs;
  for (;;) {
    const keys = new Set(live.map((p) => p.dst.key));
    const cls = (pos: Positions, fn: string) => {
      const at = pos.get(fn);
      return at && keys.has(at.key) ? `${at.key}#${at.i}` : undefined;
    };
    const reasons = new Map<UnitPair, string>();
    // loose callee (source) + destination program -> destination callees; and the reverse
    const loose = new Map<string, Set<string>>();
    const looseRev = new Map<string, Set<string>>();
    const looseKey = (xs: string, xd: string) => `${xs}\n${dstGraph.programOf(xd) ?? ""}`;
    const looseRevKey = (xs: string, xd: string) => `${xd}\n${srcGraph.programOf(xs) ?? ""}`;
    for (const p of live) {
      const src = p.candidates[0]!;
      src.externals.forEach((xs, i) => {
        const xd = p.dst.externals[i]!;
        const [cs, cd] = [cls(srcPos, xs), cls(dstPos, xd)];
        if (cs === undefined && cd === undefined) {
          (loose.get(looseKey(xs, xd)) ?? loose.set(looseKey(xs, xd), new Set()).get(looseKey(xs, xd))!).add(xd);
          (looseRev.get(looseRevKey(xs, xd)) ?? looseRev.set(looseRevKey(xs, xd), new Set()).get(looseRevKey(xs, xd))!).add(xs);
        } else if (cs !== cd && !reasons.has(p)) {
          reasons.set(p, `calls ${xd} where the source calls ${xs}, and the two are not matched to each other`);
        }
      });
    }
    for (const p of live) {
      if (reasons.has(p)) continue;
      const src = p.candidates[0]!;
      const i = src.externals.findIndex((xs, k) => (loose.get(looseKey(xs, p.dst.externals[k]!))?.size ?? 0) > 1 || (looseRev.get(looseRevKey(xs, p.dst.externals[k]!))?.size ?? 0) > 1);
      if (i >= 0) reasons.set(p, `calls ${p.dst.externals[i]} where the source calls ${src.externals[i]}, but other matches pair one of them with a different function`);
    }
    if (reasons.size === 0) return { live, rejected };
    for (const [p, reason] of reasons) rejected.push({ destination: p.dst.unit, source: p.candidates[0]!.unit, reason });
    live = live.filter((p) => !reasons.has(p));
  }
}

export function planCarry(source: Tree, destination: Tree): CarryPlan {
  const srcRecords: Records = source.progress.snapshot();
  const records = { impl: byModule(srcRecords.implementations), notes: byModule(srcRecords.annotations) };
  const have = destination.progress.snapshot();
  const haveNotes = new Set(have.annotations.map(noteKey));
  const implemented = new Set(have.implementations.map((r) => r.module));

  const unreadable: string[] = [];
  const srcPrints = fingerprintAll(source, unreadable);
  const dstPrints = fingerprintAll(destination, unreadable);

  // Identical source units (empty stubs, repeated helpers) each implement this code equally well: prefer one with
  // progress, then the one at the destination's own root address (another build of the same program), then the lowest id.
  const hasProgress = (src: UnitPrint) => src.members.some((m) => records.impl.has(m) || records.notes.has(m));
  const { live, rejected } = matchUnits(srcPrints, dstPrints, (a, b, dst) =>
    Number(hasProgress(b)) - Number(hasProgress(a)) || Number(b.unit === dst.unit) - Number(a.unit === dst.unit) || (a.unit < b.unit ? -1 : 1),
    source.graph, destination.graph);

  const carried: Carried[] = [];
  for (const { dst, candidates } of live) {
    const src = candidates[0]!;
    if (!hasProgress(src)) continue;
    const t = translate(src, dst, records, source.name);
    // a member the destination already records an implementation for keeps its own
    const implementations = t.implementations.filter((r) => !implemented.has(r.module));
    const annotations = t.annotations.filter((r) => !haveNotes.has(noteKey(r)));
    if (implementations.length + annotations.length === 0) continue;
    const alternatives = candidates.slice(1).filter(hasProgress).map((c) => c.unit);
    carried.push({ source: src.unit, destination: dst.unit, alternatives, members: t.members, implementations, annotations });
  }
  return { sourceUnits: source.plan.units.size, destinationUnits: destination.plan.units.size, matched: live.length, carried, rejected, unreadable };
}

/** Writes the plan's records into the destination progress document: one write per record kind. */
export function applyCarry(plan: CarryPlan, destination: ProgressStore): { implementations: number; annotations: number } {
  const implementations = plan.carried.flatMap((c) => c.implementations);
  const annotations = plan.carried.flatMap((c) => c.annotations);
  if (implementations.length) destination.addImplementations(implementations);
  if (annotations.length) destination.addAnnotations(annotations);
  return { implementations: implementations.length, annotations: annotations.length };
}
