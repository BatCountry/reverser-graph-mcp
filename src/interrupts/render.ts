import { hexKey } from "../hex.js";
import { AX_KEYED_INTS, type Entry, type InterruptDb, type RegText, type Topic } from "./db.js";

export const SCHEME = "dosref://";

export const uri = {
  interrupt: (int: string) => `${SCHEME}interrupt/${int}`,
  fn: (int: string, ah: number) => `${SCHEME}function/${int}/${hexKey(ah)}`,
  entry: (id: string) => `${SCHEME}entry/${id}`,
  /** `fn` is the notes tail from InterruptDb.supplementFn: "3D", "44-02" */
  notes: (source: "walkthrough" | "reference", int: string, fn: string) => `${SCHEME}notes/${source}/${int}/${fn}`,
  query: (handle: string) => `${SCHEME}query/${handle}`,
  memory: (region: string) => `${SCHEME}memory/${region}`,
  port: (group: string) => `${SCHEME}port/${group}`,
};

export function firstLine(s: string, max = 200): string {
  const line = s.split("\n")[0]!.trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

/** "AH=3Dh" / "AX=4F02h" style label for an entry's discriminating registers. */
export function entryLabel(e: Entry): string {
  const hh = (n: number) => `${hexKey(n)}h`;
  const extras = e.extra.map((x) => `${x.slice(0, 2)}=${x.slice(2)}h`);
  let base = `INT ${e.int}h`;
  if (e.ah !== null && e.al !== null && AX_KEYED_INTS.has(e.int)) base += ` AX=${hexKey((e.ah << 8) | e.al, 4)}h`;
  else if (e.ah !== null && e.al !== null) base += ` AH=${hh(e.ah)} AL=${hh(e.al)}`;
  else if (e.ah !== null) base += ` AH=${hh(e.ah)}`;
  return [base, ...extras].join(" ");
}

function regList(title: string, regs: readonly RegText[]): string {
  if (regs.length === 0) return "";
  const lines = regs.map((r) => `- **${r.register}**: ${r.text.split("\n").join("\n  ")}`);
  return `**${title}**\n${lines.join("\n")}\n`;
}

export function renderEntry(e: Entry): string {
  const parts: string[] = [];
  const flagNote = e.flags
    ? ` _(flags: ${e.flags}; U = undocumented, u = partially documented, C = callout)_`
    : "";
  parts.push(`# ${entryLabel(e)} — ${e.title}${flagNote}`, "");
  parts.push(regList("Inputs", e.regsIn));
  parts.push(regList("Returns", e.regsOut));
  if (e.regsOut.length === 0 && e.ret) parts.push(`**Returns:** ${e.ret}\n`);
  if (e.desc) parts.push(`**Description:** ${e.desc}\n`);
  if (e.notes) parts.push(`**Notes**\n${e.notes.replace(/^\t/gm, "")}\n`);
  for (const [k, v] of Object.entries(e.sections)) parts.push(`**${k}**\n${v}\n`);
  if (e.seeAlso) parts.push(`**See also:** ${e.seeAlso.split("\n").join("; ")}\n`);
  if (e.tables) parts.push("**Referenced tables**", "```", e.tables, "```", "");
  parts.push(`_Entry ${e.id}._`);
  return parts.filter((p) => p !== "").join("\n");
}

export function renderTopics(topics: readonly Topic[]): string {
  return topics
    .map((t) => `## ${t.title} (${t.kind === "spec" ? "specification" : "usage notes"})\n\n\`\`\`\n${t.text}\n\`\`\``)
    .join("\n\n");
}

/** One row per function value (AH, or AX for mouse/multiplex/DPMI): the most important entry of each group. */
export function renderInterruptOverview(db: InterruptDb, int: string): string {
  const info = db.info(int);
  const ax = db.isAxKeyed(int);
  const groups = new Map<number, Entry[]>();
  const other: Entry[] = [];
  for (const e of db.entriesFor(int)) {
    if (e.ah === null) {
      other.push(e);
      continue;
    }
    const key = ax ? (e.ah << 8) | (e.al ?? 0) : e.ah;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(e);
  }
  const lines: string[] = [`# INT ${int}h — ${info?.name ?? "interrupt"}`, ""];
  if (info?.walkthrough) lines.push("```", info.walkthrough, "```", "");
  for (const t of info?.reference ?? []) lines.push(`## ${t.title}`, "", "```", t.text, "```", "");
  lines.push(
    `## Functions (grouped by ${ax ? "AX" : "AH"})`,
    "",
    "Each row links to the best entry; variants are vendor-specific, version-specific or undocumented alternatives sharing the same value.",
    "",
  );
  for (const [key, entries] of [...groups].sort((a, b) => a[0] - b[0])) {
    const best = entries.find((e) => e.flags === "" && !e.id.includes("_")) ?? entries[0]!;
    const more = entries.length > 1 ? ` (+${entries.length - 1} variants)` : "";
    const link = ax || entries.length === 1 ? uri.entry(best.id) : uri.fn(int, key);
    lines.push(`- ${ax ? "AX" : "AH"}=${hexKey(key, ax ? 4 : 2)}h: ${best.title}${more} — ${link}`);
  }
  if (other.length) {
    lines.push("", `## Entries without a function discriminator (${other.length})`, "");
    for (const e of other.slice(0, 60)) lines.push(`- ${e.title} — ${uri.entry(e.id)}`);
    if (other.length > 60) lines.push(`- … ${other.length - 60} more`);
  }
  return lines.join("\n");
}

export function renderFunctionFamily(db: InterruptDb, int: string, ah: number): string {
  const entries = db.entriesFor(int).filter((e) => e.ah === ah);
  const lines = [`# INT ${int}h AH=${hexKey(ah)}h — all documented variants (${entries.length})`, ""];
  const hh = hexKey(ah);
  const sup = db.supplement(`${int}:${hh}`);
  if (sup?.walkthrough) lines.push(`- Walkthrough: ${uri.notes("walkthrough", int, hh)}`);
  if (sup?.reference.length) lines.push(`- Assembler reference + notes: ${uri.notes("reference", int, hh)}`);
  lines.push("");
  for (const e of entries) {
    lines.push(`- ${entryLabel(e)} — ${e.title} — ${uri.entry(e.id)}`);
  }
  return lines.join("\n");
}
