// Line selectors a client may append to a listing id, written the way omp's read tool documents them: `id:50-80`,
// `id:50+20` (20 lines from 50), `id:50` or `id:50-` (from line 50 on), `id:-20` (the last 20 lines). Lines are
// numbered from 1 in the listing file. Untrusted input: anything else is refused with the forms that work.

export type LineSelection =
  | { ok: true; first: number; last: number; total: number; /** the request ran past the end and was cut there */ clipped: boolean }
  | { ok: false; error: string };

const SELECTOR = /^(?:(\d{1,7})(?:([-+])(\d{0,7}))?|-(\d{1,7}))$/;
const FORMS = "use N-M (lines N to M), N+COUNT, N (from line N on) or -N (the last N lines), lines numbered from 1";

/** Resolve `selector` against a listing of `total` lines, clipping a range that runs past the end. */
export function selectLines(selector: string, total: number): LineSelection {
  const m = SELECTOR.exec(selector);
  if (!m) return { ok: false, error: `"${selector}" is not a line range: ${FORMS}` };
  if (total === 0) return { ok: false, error: "the listing is empty" };
  if (m[4] !== undefined) {
    const count = Number(m[4]);
    if (count === 0) return { ok: false, error: `"${selector}" asks for no lines: ${FORMS}` };
    return { ok: true, first: Math.max(1, total - count + 1), last: total, total, clipped: count > total };
  }
  const first = Number(m[1]);
  if (first === 0) return { ok: false, error: `"${selector}" starts at line 0: ${FORMS}` };
  if (first > total) return { ok: false, error: `"${selector}" starts past the end: the listing has ${total} lines` };
  const op = m[2];
  const rest = m[3] ?? "";
  if (op === undefined || (op === "-" && rest === "")) return { ok: true, first, last: total, total, clipped: false };
  if (rest === "") return { ok: false, error: `"${selector}" has no line count after "+": ${FORMS}` };
  const n = Number(rest);
  if (op === "+" && n === 0) return { ok: false, error: `"${selector}" asks for no lines: ${FORMS}` };
  if (op === "-" && n < first) return { ok: false, error: `"${selector}" ends before it starts: ${FORMS}` };
  const want = op === "+" ? first + n - 1 : n;
  return { ok: true, first, last: Math.min(want, total), total, clipped: want > total };
}
