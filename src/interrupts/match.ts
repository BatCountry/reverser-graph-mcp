import { RegisterFile } from "../registers.js";
import type { Entry, InterruptDb } from "./db.js";

export interface Cond {
  register: string;
  value: number;
}

export interface Match {
  entry: Entry;
  conds: Cond[];
  /** conditions satisfied by the caller's registers */
  matched: Cond[];
  /** conditions whose register the caller did not supply */
  open: Cond[];
  score: number;
}

const EXTRA_RE = /^([A-Z]{2})([0-9A-F]+)$/;

export function condsOf(e: Entry): Cond[] {
  const out: Cond[] = [];
  if (e.ah !== null && e.al !== null) {
    // AX-keyed ids carry both halves; AH-keyed ids carry only AH.
    out.push({ register: "AH", value: e.ah }, { register: "AL", value: e.al });
  } else if (e.ah !== null) {
    out.push({ register: "AH", value: e.ah });
  }
  for (const x of e.extra) {
    const m = EXTRA_RE.exec(x);
    if (m) out.push({ register: m[1]!, value: parseInt(m[2]!, 16) });
  }
  return out;
}

export function matchEntries(db: InterruptDb, int: string, regs: RegisterFile): Match[] {
  const out: Match[] = [];
  const all = db.entriesFor(int);
  const keyed = db.isFunctionKeyed(int);
  for (const entry of all) {
    const conds = condsOf(entry);
    const matched: Cond[] = [];
    const open: Cond[] = [];
    let contradicted = false;
    for (const c of conds) {
      const known = regs.get(c.register);
      if (known === undefined) open.push(c);
      else if (known === c.value) matched.push(c);
      else {
        contradicted = true;
        break;
      }
    }
    if (contradicted) continue;
    // Quality: discriminating matches dominate; undiscriminated generic leftovers rank last;
    // plain entries (no flags, no "_n" variant suffix) and curated coverage break ties.
    let score = matched.length * 100 - open.length * 5;
    if (entry.flags === "") score += 3;
    if (!entry.id.includes("_")) score += 2;
    if (db.supplementFn(entry) !== undefined) score += 4;
    score -= entry.extra.length;
    // On function-keyed interrupts, entries with no discriminator (vendor hooks, ...) are noise.
    if (keyed && conds.length === 0) score -= 500;
    // On single-service interrupts (INT 12h, ...) the plain entry is the answer; AH-keyed vendor hooks are not.
    if (!keyed && conds.length > 0) score -= 500;
    out.push({ entry, conds, matched, open, score });
  }
  out.sort((a, b) => b.score - a.score || a.entry.id.length - b.entry.id.length || a.entry.id.localeCompare(b.entry.id));
  return out;
}
