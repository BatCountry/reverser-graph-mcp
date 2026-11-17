import type { Candidate, CallPair, Correspondence, ProgramPairing, Which } from "../compare/correspond.js";
import { confidence, mapCounts, mapRows, resolveFunction, verdict, type Confidence, type MapRow } from "../compare/render.js";

// JSON for the dashboard's Compare page (compare mode only): the map of counterparts, one pair side by side, and the
// leads for a function without a counterpart. Built from the same correspondence the counterpart/compare tools use.

export interface CompareSummary {
  a: string;
  b: string;
  functions: { a: number; b: number };
  counts: Record<MapRow["status"], number>;
  /** program pairs, and programs without a partner with the reason; functions are paired only within a program pair */
  programs: ProgramPairing;
}

export function compareSummary(c: Correspondence): CompareSummary {
  return { a: c.a.name, b: c.b.name, functions: { a: c.functions("a").length, b: c.functions("b").length }, counts: mapCounts(mapRows(c)), programs: c.programs };
}

export interface PairRow {
  a?: { addr: number; text: string };
  b?: { addr: number; text: string };
  /** same: identical text; moved: same instruction with other addresses; a / b: only on that side */
  kind: "same" | "moved" | "a" | "b";
}

export interface PairView {
  a: string;
  b: string;
  verdict: string;
  similarity: number;
  identical: boolean;
  /** recorded as each other's counterparts */
  matched: boolean;
  how?: string;
  confidence?: Confidence;
  /** when not matched to each other: each side's own counterpart, if any */
  aCounterpart?: string;
  bCounterpart?: string;
  calls: CallPair[];
  rows: PairRow[];
}

export function comparePair(c: Correspondence, rawA: string, rawB: string): { ok: true; pair: PairView } | { ok: false; error: string } {
  const ra = resolveFunction(c, "a", rawA);
  if (!ra.ok) return ra;
  const rb = resolveFunction(c, "b", rawB);
  if (!rb.ok) return rb;
  const d = c.detail(ra.id, rb.id);
  const m = c.counterpart("a", ra.id);
  const matched = m?.b === rb.id;
  const rows = d.alignment.rows.map((r): PairRow => {
    const x = r.a === undefined ? undefined : d.aInsns[r.a]!;
    const y = r.b === undefined ? undefined : d.bInsns[r.b]!;
    const kind = x && y ? (x.text === y.text ? "same" : "moved") : x ? "a" : "b";
    return { ...(x ? { a: x } : {}), ...(y ? { b: y } : {}), kind };
  });
  const other = c.counterpart("b", rb.id);
  return {
    ok: true,
    pair: {
      a: ra.id,
      b: rb.id,
      verdict: verdict(c, d),
      similarity: d.alignment.similarity,
      identical: d.identical,
      matched,
      ...(matched ? { how: m.how, confidence: confidence(m, d.alignment.similarity) } : {}),
      ...(!matched && m ? { aCounterpart: m.b } : {}),
      ...(!matched && other ? { bCounterpart: other.a } : {}),
      calls: d.calls,
      rows,
    },
  };
}

export interface CounterpartView {
  game: string;
  id: string;
  note?: string;
  /** the pair, when there is a counterpart */
  a?: string;
  b?: string;
  sameCode: string[];
  candidates: Candidate[];
  /** matched callers: this side's caller, the other side's */
  callers: Array<{ here: string; there: string }>;
  /** the function's instructions, shown when it has no counterpart */
  listing: Array<{ addr: number; text: string }>;
}

/** A function of either game (by name): its counterpart, or the leads for one. */
export function counterpartView(c: Correspondence, game: string, raw: string): { ok: true; view: CounterpartView } | { ok: false; error: string } {
  const w: Which | undefined = game === c.a.name ? "a" : game === c.b.name ? "b" : undefined;
  if (!w) return { ok: false, error: `No game "${game}": this dashboard compares ${c.a.name} and ${c.b.name}.` };
  const r = resolveFunction(c, w, raw);
  if (!r.ok) return r;
  const m = c.counterpart(w, r.id);
  const callers = c.callers(w, r.id).flatMap((caller) => {
    const cm = c.counterpart(w, caller);
    return cm ? [{ here: caller, there: w === "a" ? cm.b : cm.a }] : [];
  });
  return {
    ok: true,
    view: {
      game,
      id: r.id,
      ...(r.note ? { note: r.note } : {}),
      ...(m ? { a: m.a, b: m.b } : {}),
      sameCode: c.sameCode(w, r.id),
      candidates: c.candidates(w, r.id),
      callers,
      listing: m ? [] : c.listing(w, r.id),
    },
  };
}
