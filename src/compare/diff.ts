// Line alignment of two listings (longest common subsequence), for comparing a function with its counterpart.

/** One aligned row: a line of `a`, a line of `b`, or both when the two lines are equal. */
export interface Row {
  a?: number;
  b?: number;
}

export interface Alignment {
  rows: Row[];
  /** rows holding both sides */
  same: number;
  /** 2·same / (lines of a + lines of b); 1 for two empty listings */
  similarity: number;
  /** false when the differing middle was too big to align and is shown as all removed, then all added */
  exact: boolean;
}

/** DP cells (one u16 each) allowed for the differing middle: two 4000-line functions. */
export const MAX_CELLS = 16_000_000;

export function align(a: readonly string[], b: readonly string[], maxCells = MAX_CELLS): Alignment {
  const n = a.length;
  const m = b.length;
  let pre = 0;
  while (pre < n && pre < m && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < n - pre && suf < m - pre && a[n - 1 - suf] === b[m - 1 - suf]) suf++;
  const rows: Row[] = [];
  for (let i = 0; i < pre; i++) rows.push({ a: i, b: i });
  const n1 = n - pre - suf;
  const m1 = m - pre - suf;
  let exact = true;
  if (n1 > 0 && m1 > 0 && n1 * m1 <= maxCells) {
    // intern lines so the table compares numbers
    const ids = new Map<string, number>();
    const id = (s: string) => ids.get(s) ?? (ids.set(s, ids.size), ids.size - 1);
    const x = Int32Array.from({ length: n1 }, (_, i) => id(a[pre + i]!));
    const y = Int32Array.from({ length: m1 }, (_, j) => id(b[pre + j]!));
    const w = m1 + 1;
    // L[i][j] = LCS of x[i..] and y[j..]; at most min(n1, m1) <= 4000 fits u16
    const L = new Uint16Array((n1 + 1) * w);
    for (let i = n1 - 1; i >= 0; i--) {
      for (let j = m1 - 1; j >= 0; j--) {
        L[i * w + j] = x[i] === y[j] ? L[(i + 1) * w + j + 1]! + 1 : Math.max(L[(i + 1) * w + j]!, L[i * w + j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n1 || j < m1) {
      if (i < n1 && j < m1 && x[i] === y[j]) rows.push({ a: pre + i++, b: pre + j++ });
      else if (j >= m1 || (i < n1 && L[(i + 1) * w + j]! >= L[i * w + j + 1]!)) rows.push({ a: pre + i++ });
      else rows.push({ b: pre + j++ });
    }
  } else {
    exact = n1 === 0 || m1 === 0;
    for (let i = 0; i < n1; i++) rows.push({ a: pre + i });
    for (let j = 0; j < m1; j++) rows.push({ b: pre + j });
  }
  for (let k = 0; k < suf; k++) rows.push({ a: n - suf + k, b: m - suf + k });
  const same = rows.filter((r) => r.a !== undefined && r.b !== undefined).length;
  return { rows, same, similarity: n + m === 0 ? 1 : (2 * same) / (n + m), exact };
}

/** Row ranges [start, end) holding the changes plus `context` equal rows around each; overlapping ranges merge. */
export function hunks(rows: readonly Row[], context = 2): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  rows.forEach((r, k) => {
    if (r.a !== undefined && r.b !== undefined) return;
    const start = Math.max(0, k - context);
    const end = Math.min(rows.length, k + context + 1);
    const last = out[out.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  });
  return out;
}
