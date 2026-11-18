import { programName, type Correspondence, type Match, type PairDetail, type ProgramPair, type Which } from "./correspond.js";
import { hunks, type Row } from "./diff.js";
import { percentDown } from "../percent.js";

// Text for the compare tools and resources: short answers inline, full side-by-side listings behind a URI.

/** URIs of one comparison (see compareUris). */
export interface CompareUris {
  /** `disasm://<a>/compare/<b>/` */
  base: string;
  pair: (x: string, y: string) => string;
  map: (filter: MapFilter, page: number) => string;
}

/** URIs of the comparison between this tree (`a`) and another (`b`): `disasm://<a>/compare/<b>/…`, distinct per
 * server even when several servers compare the same tree with different others. */
export function compareUris(a: string, b: string): CompareUris {
  const base = `disasm://${encodeURIComponent(a)}/compare/${encodeURIComponent(b)}/`;
  return {
    base,
    pair: (x, y) => `${base}pair/${encodeURIComponent(x)}/${encodeURIComponent(y)}`,
    map: (filter, page) => `${base}map/${filter}/${page}`,
  };
}

const urisOfComparison = (c: Correspondence) => compareUris(c.a.name, c.b.name);

export const MAP_FILTERS = ["all", "identical", "changed", "unmatched"] as const;
export type MapFilter = (typeof MAP_FILTERS)[number];
export const MAP_PAGE_ROWS = 100;
/** diff lines shown inline before pointing at the full side by side */
export const INLINE_DIFF_LINES = 40;

export type Confidence = "same code" | "strong" | "likely" | "weak";

/** How far to trust a match: seeds have the same code; proposals by agreement of neighbours and shared code. */
export function confidence(m: Match, similarity: number): Confidence {
  if (m.votes === 0) return "same code";
  if (similarity >= 0.6) return "strong";
  if (m.votes >= 2 || similarity >= 0.3) return "likely";
  return "weak";
}

const hex4 = (n: number) => n.toString(16).padStart(4, "0");
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** A node name or listing address in one game, as a function both trees can show. */
export function resolveFunction(c: Correspondence, w: Which, raw: string): { ok: true; id: string; note?: string } | { ok: false; error: string } {
  const r = c[w].graph.resolve(raw);
  if (!r.ok) return { ok: false, error: `${c[w].name}: ${r.error}` };
  if (!c.has(w, r.node.id)) return { ok: false, error: `${c[w].name}: ${r.node.id} is ${r.node.kind === "function" ? "a function without a readable listing or without instructions (a batch file)" : `not a function (kind: ${r.node.kind})`}, so there is nothing to compare.` };
  return r.note ? { ok: true, id: r.node.id, note: `${c[w].name}: ${r.note}` } : { ok: true, id: r.node.id };
}

function legend(c: Correspondence): string {
  return `Columns: ${c.a.name} offset, ${c.b.name} offset, instruction. \`-\` only in ${c.a.name}, \`+\` only in ${c.b.name}, \`~\` the same instruction with other addresses (${c.a.name} ⇄ ${c.b.name}), blank: identical.`;
}

function diffLines(d: PairDetail, rows: readonly Row[]): string[] {
  return rows.map((r) => {
    const x = r.a === undefined ? undefined : d.aInsns[r.a]!;
    const y = r.b === undefined ? undefined : d.bInsns[r.b]!;
    if (x && y) return x.text === y.text ? `  ${hex4(x.addr)} ${hex4(y.addr)}  ${x.text}` : `~ ${hex4(x.addr)} ${hex4(y.addr)}  ${x.text}  ⇄  ${y.text}`;
    return x ? `- ${hex4(x.addr)}       ${x.text}` : `+      ${hex4(y!.addr)}  ${y!.text}`;
  });
}

function sizes(c: Correspondence, d: PairDetail): string {
  return `${d.aInsns.length} instructions in ${c.a.name}, ${d.bInsns.length} in ${c.b.name}`;
}

/** One line on how alike two functions are. */
export function verdict(c: Correspondence, d: PairDetail): string {
  if (d.identical) return `Identical: the same instructions once addresses are renamed, and every callee is the other's counterpart (${sizes(c, d)}).`;
  if (d.sameCode) return `The same instructions once addresses are renamed, but not every callee is the other's counterpart (see Calls).`;
  return `Changed: ${percentDown(d.alignment.similarity)} of the instructions line up (${sizes(c, d)}${d.alignment.exact ? "" : "; too long to align exactly, the differing middle is shown as removed then added"}).`;
}

/** callee pairs listed inline; the full side by side lists them all */
const INLINE_CALLS = 8;

function callsText(c: Correspondence, d: PairDetail, limit = Number.POSITIVE_INFINITY): string {
  if (d.calls.length === 0) return "Calls: none to other functions.";
  const same = d.calls.filter((p) => p.state === "same").length;
  const lines = [`Calls: ${plural(d.calls.length, "callee")} at aligned places, ${same} of them each other's counterparts.`];
  const differ = d.calls.filter((p) => p.state !== "same");
  for (const p of differ.slice(0, limit)) {
    if (p.a && p.b) {
      const ma = c.counterpart("a", p.a);
      const mb = c.counterpart("b", p.b);
      const why = p.state === "open" ? "neither is matched yet" : [ma && `${p.a} is ${ma.b}'s counterpart`, mb && `${p.b} is ${mb.a}'s counterpart`].filter(Boolean).join("; ");
      lines.push(`- ${p.a} ⇄ ${p.b}: ${why}`);
    } else if (p.a) lines.push(`- only ${c.a.name} calls ${p.a} here${c.counterpart("a", p.a) ? ` (its counterpart is ${c.counterpart("a", p.a)!.b})` : ""}`);
    else lines.push(`- only ${c.b.name} calls ${p.b} here${c.counterpart("b", p.b!) ? ` (its counterpart is ${c.counterpart("b", p.b!)!.a})` : ""}`);
  }
  if (differ.length > limit) lines.push(`- … ${differ.length - limit} more in the full side by side`);
  return lines.join("\n");
}

/** one-sided runs longer than this are cut to their ends inline */
const LONG_RUN = 8;

function collapse(c: Correspondence, lines: string[]): string[] {
  const out: string[] = [];
  for (let k = 0; k < lines.length; ) {
    const mark = lines[k]![0];
    let e = k;
    while (e < lines.length && lines[e]![0] === mark) e++;
    if ((mark === "-" || mark === "+") && e - k > LONG_RUN) out.push(...lines.slice(k, k + 3), `${mark} … ${e - k - 5} more only in ${mark === "-" ? c.a.name : c.b.name}`, ...lines.slice(e - 2, e));
    else out.push(...lines.slice(k, e));
    k = e;
  }
  return out;
}

/** Changed stretches, up to `budget` lines; the rest is behind the pair URI. */
function inlineDiff(c: Correspondence, d: PairDetail, budget = INLINE_DIFF_LINES): string {
  if (d.sameCode) return "";
  const all = hunks(d.alignment.rows);
  const out: string[] = [];
  let shown = 0;
  for (const [start, end] of all) {
    const lines = collapse(c, diffLines(d, d.alignment.rows.slice(start, end)));
    if (out.length && out.length + lines.length > budget) break;
    out.push(`@@ rows ${start + 1}-${end} of ${d.alignment.rows.length}`, ...lines.slice(0, budget));
    if (lines.length > budget) out.push(`… this stretch goes on`);
    shown++;
  }
  const rest = all.length - shown;
  const title = `## Differences (${shown} of ${all.length} changed stretch${all.length === 1 ? "" : "es"})`;
  return [title, legend(c), "```", ...out, "```", rest ? `${rest} more: ${urisOfComparison(c).pair(d.a, d.b)}` : ""].filter(Boolean).join("\n");
}

function pairBody(c: Correspondence, d: PairDetail, match: Match | undefined): string {
  const lines = [verdict(c, d)];
  if (match) lines.push(`Paired because: ${match.how} (confidence: ${confidence(match, d.alignment.similarity)}).`);
  lines.push("", callsText(c, d, INLINE_CALLS));
  const diff = inlineDiff(c, d);
  if (diff) lines.push("", diff);
  lines.push("", `Full side by side: ${urisOfComparison(c).pair(d.a, d.b)}`);
  return lines.join("\n");
}

const pairText = (c: Correspondence, p: ProgramPair) =>
  `${programName(p.a, c.a.name)} ↔ ${programName(p.b, c.b.name)}, ${p.shared} of their ${p.union} distinct function bodies in both`;

/** A function's program and its partner, one line; none for two trees without a programs table (one program each). */
function programLine(c: Correspondence, w: Which, id: string): string[] {
  const p = c.programOf(w, id)!; // callers pass functions with a listing
  const pair = c.programs.pairs.find((x) => x[w] === p);
  if (pair) return pair.a === "" && pair.b === "" ? [] : [`Programs: ${pairText(c, pair)}.`];
  const why = c.programs.unpaired[w].find((u) => u.program === p)!.reason;
  return [`Program: ${programName(p, c[w].name)} has no partner in ${c[w === "a" ? "b" : "a"].name}: ${why}. Its functions are not paired (functions pair only within a program pair).`];
}

/** Every program pair and unpaired program, for the map; none for two trees without a programs table. */
function programsText(c: Correspondence): string[] {
  const { pairs, unpaired } = c.programs;
  if (pairs.length === 1 && pairs[0]!.a === "" && pairs[0]!.b === "") return [];
  return [
    "Programs (paired by the share of their code both have; functions are paired only within a program pair):",
    ...pairs.map((p) => `- ${pairText(c, p)}`),
    ...(["a", "b"] as const).flatMap((w) => unpaired[w].map((u) => `- ${programName(u.program, c[w].name)}: no partner, ${u.reason}`)),
    "",
  ];
}

/** `counterpart`: the function in the other game, or why there is none and where to look. */
export function renderCounterpart(c: Correspondence, w: Which, id: string, note?: string): string {
  const here = c[w].name;
  const there = c[w === "a" ? "b" : "a"].name;
  const head = note ? [note, ""] : [];
  const m = c.counterpart(w, id);
  if (m) {
    const d = c.detail(m.a, m.b);
    return [...head, `# ${m.a} (${c.a.name}) ↔ ${m.b} (${c.b.name})`, "", ...programLine(c, w, id), pairBody(c, d, m)].join("\n");
  }
  const lines = [...head, `# ${id} (${here}): no counterpart found in ${there}`, "", ...programLine(c, w, id)];
  const same = c.sameCode(w, id);
  if (same.length) {
    const program = c.programOf(w, id)!;
    const partner = c.partnerProgram(w, program);
    const why =
      partner === undefined
        ? "Its program has no partner, so none was picked"
        : same.some((x) => c.programOf(w === "a" ? "b" : "a", x) === partner)
          ? "Several functions share it, so none was picked"
          : `None of them is in ${programName(partner, there)}, the program paired with ${programName(program, here)}, so none was picked`;
    lines.push(`Same code in ${there}: ${same.slice(0, 8).join(", ")}${same.length > 8 ? ", …" : ""}. ${why}; \`compare\` any of them.`);
  }
  const cands = c.candidates(w, id);
  if (cands.length) {
    lines.push(`Candidates (matched neighbours point at them, but not unanimously):`);
    for (const p of cands.slice(0, 5)) lines.push(`- ${p.id}: ${plural(p.votes, "vote")}, ${p.how}`);
  }
  const callers = c.callers(w, id).flatMap((caller) => {
    const cm = c.counterpart(w, caller);
    return cm ? [`- ${caller} ↔ ${w === "a" ? cm.b : cm.a}`] : [];
  });
  if (callers.length) lines.push(`Matched callers (compare them to see what the ${there} side calls instead):`, ...callers.slice(0, 5), ...(callers.length > 5 ? [`- … ${callers.length - 5} more`] : []));
  if (!same.length && !cands.length && !callers.length) lines.push(`Nothing points at a counterpart: no function in ${there} has its code, and none of its callers or callees is matched.`);
  return lines.join("\n");
}

/** `compare`: any two functions side by side, with whether they are recorded counterparts. */
export function renderCompare(c: Correspondence, a: string, b: string, notes: string[] = []): string {
  const d = c.detail(a, b);
  const m = c.counterpart("a", a);
  const relation =
    m?.b === b
      ? undefined
      : [`Not recorded as counterparts.`, m ? `${a}'s counterpart is ${m.b}.` : `${a} has no counterpart.`, c.counterpart("b", b) ? `${b}'s counterpart is ${c.counterpart("b", b)!.a}.` : `${b} has no counterpart.`].join(" ");
  const programs = c.partnerProgram("a", c.programOf("a", a)!) === c.programOf("b", b) ? programLine(c, "a", a) : [...programLine(c, "a", a), ...programLine(c, "b", b)];
  return [...notes, ...(notes.length ? [""] : []), `# ${a} (${c.a.name}) vs ${b} (${c.b.name})`, "", ...(relation ? [relation, ""] : []), ...programs, pairBody(c, d, m?.b === b ? m : undefined)].join("\n");
}

/** The pair resource: every row of the side by side. */
export function renderPairFull(c: Correspondence, a: string, b: string): string {
  const d = c.detail(a, b);
  const m = c.counterpart("a", a);
  return [
    `# ${a} (${c.a.name}) vs ${b} (${c.b.name})`,
    "",
    verdict(c, d),
    ...(m?.b === b ? [`Paired because: ${m.how} (confidence: ${confidence(m, d.alignment.similarity)}).`] : [`Not recorded as counterparts.`]),
    "",
    callsText(c, d),
    "",
    legend(c),
    "```",
    ...diffLines(d, d.alignment.rows),
    "```",
  ].join("\n");
}

export interface MapRow {
  a?: string;
  b?: string;
  status: "identical" | "changed" | "only-a" | "only-b";
  similarity?: number;
  /** "changed" only in what it calls: the instructions are the same */
  sameCode?: boolean;
  confidence?: Confidence;
}

/** Every function of both games: A's in address order with their counterparts, then B's that have none. */
export function mapRows(c: Correspondence): MapRow[] {
  const rows: MapRow[] = c.functions("a").map((a) => {
    const m = c.counterpart("a", a);
    if (!m) return { a, status: "only-a" };
    const d = c.detail(m.a, m.b);
    return { a, b: m.b, status: d.identical ? "identical" : "changed", similarity: d.alignment.similarity, ...(d.sameCode && !d.identical ? { sameCode: true } : {}), confidence: confidence(m, d.alignment.similarity) };
  });
  for (const b of c.functions("b")) if (!c.counterpart("b", b)) rows.push({ b, status: "only-b" });
  return rows;
}

export function mapCounts(rows: readonly MapRow[]): Record<MapRow["status"], number> {
  const counts = { identical: 0, changed: 0, "only-a": 0, "only-b": 0 };
  for (const r of rows) counts[r.status]++;
  return counts;
}

const keep = (filter: MapFilter, r: MapRow) => filter === "all" || (filter === "unmatched" ? r.status === "only-a" || r.status === "only-b" : r.status === filter);

export function renderMap(c: Correspondence, filter: MapFilter, page: number): string {
  const rows = mapRows(c);
  const n = mapCounts(rows);
  const shown = rows.filter((r) => keep(filter, r));
  const pages = Math.max(1, Math.ceil(shown.length / MAP_PAGE_ROWS));
  if (!Number.isSafeInteger(page) || page < 1 || page > pages) throw new Error(`Page ${page} does not exist: ${filter} has ${pages} page${pages === 1 ? "" : "s"} (1-${pages}).`);
  const slice = shown.slice((page - 1) * MAP_PAGE_ROWS, page * MAP_PAGE_ROWS);
  const line = (r: MapRow) =>
    r.status === "only-a"
      ? `- ${r.a}: only in ${c.a.name}`
      : r.status === "only-b"
        ? `- ${r.b}: only in ${c.b.name}`
        : `- ${r.a} ↔ ${r.b}: ${r.status === "identical" ? "identical" : r.sameCode ? "same instructions, other callees" : `changed, ${percentDown(r.similarity!)} lines up`} (${r.confidence})`;
  return [
    `# ${c.a.name} ↔ ${c.b.name}: ${filter} functions, page ${page} of ${pages}`,
    "",
    `${n.identical} identical, ${n.changed} changed, ${n["only-a"]} only in ${c.a.name}, ${n["only-b"]} only in ${c.b.name}. Filters: ${MAP_FILTERS.map((f) => urisOfComparison(c).map(f, 1)).join(", ")}.`,
    "",
    ...programsText(c),
    ...slice.map(line),
    "",
    page < pages ? `Next page: ${urisOfComparison(c).map(filter, page + 1)}` : "Last page.",
  ].join("\n");
}
