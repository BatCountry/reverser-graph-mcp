import { TTL_SHORT_MS, type TtlCache } from "../cache.js";
import { formatHex, hexKey, parseInterruptNumber } from "../hex.js";
import { RegisterFile, type RegisterInput } from "../registers.js";
import type { Entry, InterruptDb, Topic } from "./db.js";
import { matchEntries, type Match } from "./match.js";
import { clip, entryLabel, firstLine, uri } from "./render.js";

export interface RegisterInputDoc {
  register: string;
  value?: string;
  register_purpose: string;
}
export interface RegisterOutputDoc {
  register: string;
  value?: string;
  register_purpose: string;
}
export interface InterruptOutput {
  interrupt: string;
  register_inputs: RegisterInputDoc[];
  register_outputs: RegisterOutputDoc[];
  register_invocation_documentation: string;
  complete_documentation: string;
  tool_hint: string;
}

export type LookupResult = { ok: true; output: InterruptOutput } | { ok: false; error: string };

const SIMPLE_REG = /^(?:[A-D][XHL]|SI|DI|BP|SP|ES|DS|CS|SS)$/;
const LITERAL = /^[0-9A-F]{1,4}h?$/i;

/** "DOS 2+ - \"OPEN\" - OPEN EXISTING FILE" -> keep category-free readable tail */
function shortTitle(e: Entry): string {
  const parts = e.title.split(" - ");
  return parts[parts.length - 1]!.trim();
}

function referenceDescription(topics: readonly Topic[]): string | undefined {
  for (const t of topics) {
    if (t.kind !== "spec") continue;
    const m = /Description:[^\n]*\n\s*\n([\s\S]*?)\n\s*\n\s*Input/.exec(t.text);
    if (m?.[1]) return m[1].split("\n").map((l) => l.trim()).join(" ").trim();
  }
  return undefined;
}

function walkthroughBlurb(text: string): string | undefined {
  const body = text.split("\n").slice(1).join("\n").trim();
  const para = body.split(/\n\s*\n/)[0]?.trim();
  // The walkthroughs often open with a register listing ("AH = 3D ...") instead of prose; that is not a blurb.
  if (!para || /^[A-Z]{2}(?::[A-Z]{2})?\s*=/.test(para)) return undefined;
  return para.replace(/\s+/g, " ");
}

function describeInputs(m: Match, regs: RegisterFile): RegisterInputDoc[] {
  const e = m.entry;
  return e.regsIn.map((r) => {
    const doc: RegisterInputDoc = { register: r.register, register_purpose: clip(firstLine(r.text, 300), 300) };
    const known = SIMPLE_REG.test(r.register) ? regs.get(r.register) : undefined;
    const width = r.register.endsWith("X") || r.register.length === 2 && !/[HL]$/.test(r.register) ? 4 : 2;
    const isDiscriminator = m.matched.some((c) => c.register === r.register);
    if (LITERAL.test(firstLine(r.text)) && (isDiscriminator || known !== undefined)) {
      doc.register_purpose = "selects the operation";
    }
    if (known !== undefined) {
      doc.value = isDiscriminator
        ? `${formatHex(known, width)} matched: ${shortTitle(e)}`
        : `${formatHex(known, width)} (as supplied)`;
    } else if (isDiscriminator) {
      // AX-keyed entries are matched through AH/AL halves
      doc.value = `matched: ${shortTitle(e)}`;
    }
    return doc;
  });
}

function describeOutputs(e: Entry): RegisterOutputDoc[] {
  if (e.regsOut.length === 0 && e.ret) {
    return [{ register: "(none)", register_purpose: clip(e.ret.replace(/\s+/g, " "), 300) }];
  }
  return e.regsOut.map((r) => ({ register: r.register, register_purpose: clip(r.text.replace(/\n/g, "; "), 400) }));
}

function matchedSummary(m: Match): string {
  const ah = m.matched.find((c) => c.register === "AH");
  const al = m.matched.find((c) => c.register === "AL");
  const rest = m.matched.filter((c) => c !== ah && c !== al);
  const parts = ah && al
    ? [`AX=${formatHex((ah.value << 8) | al.value, 4)}`]
    : [ah, al].filter((c) => c !== undefined).map((c) => `${c.register}=${formatHex(c.value)}`);
  return [...parts, ...rest.map((c) => `${c.register}=${formatHex(c.value, 4)}`)].join(", ");
}

function bestDescription(db: InterruptDb, m: Match): string {
  const e = m.entry;
  const fn = db.supplementFn(e);
  const sup = fn ? db.supplement(`${e.int}:${fn.replace("-", ":")}`) : undefined;
  const lines: string[] = [];
  const desc = e.desc || referenceDescription(sup?.reference ?? []) || (sup?.walkthrough ? walkthroughBlurb(sup.walkthrough) : undefined);
  if (desc) lines.push(clip(desc, 700));
  if (e.notes) {
    const notes = e.notes.split(/\n\t(?=\S)/).map((n) => n.replace(/^\t/, "").replace(/\s+/g, " ").trim());
    for (const n of notes.slice(0, 3)) lines.push(`- ${clip(n, 280)}`);
    if (notes.length > 3) lines.push(`- (+${notes.length - 3} more notes in the full entry)`);
  }
  return lines.join("\n");
}

function signature(regs: RegisterFile): string {
  return regs.supplied.map((s) => `${s.register}${s.value.toString(16)}`).sort().join("-") || "none";
}

type Args = { interrupt: unknown; registers?: readonly RegisterInput[] | undefined };

export function lookupInterrupt(db: InterruptDb, cache: TtlCache, args: Args): LookupResult {
  const parsed = parseInterruptNumber(args.interrupt);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  return resolve(db, cache, args, parsed.value);
}

function resolve(db: InterruptDb, cache: TtlCache, args: Args, number: number): LookupResult {
  const int = hexKey(number);
  const rf = RegisterFile.from(args.registers ?? []);
  if (!rf.ok) return { ok: false, error: rf.errors.join("\n") };
  const regs = rf.regs;

  const info = db.info(int);
  const entries = db.entriesFor(int);
  const name = `Interrupt ${int}h - ${info?.name ?? "not covered by the bundled references"}`;
  if (!info || entries.length === 0) {
    return {
      ok: true,
      output: {
        interrupt: name,
        register_inputs: [],
        register_outputs: [],
        register_invocation_documentation:
          `INT ${int}h is outside the bundled BIOS/DOS/mouse/EMS/DPMI references (INT 00h-2Fh, 31h, 33h, 67h). ` +
          `Vectors 60h-67h and anything not listed are typically program- or driver-defined (a game's own handler, sound driver, EMS, ...).`,
        complete_documentation: `Complete documentation available by category:\n- All covered interrupts: ${uri.interrupt("21")} (change the number; covered: 00-2F, 31, 33, 67)`,
        tool_hint:
          "- Find who installs this vector: look for writes to the IVT (0000:vector*4) or INT 21h AH=25h (set vector) in the module you are reading.\n" +
          "- Use the dos_memory_offset tool with 0000:" + hexKey(number * 4, 4) + " to see the IVT slot for this vector.",
      },
    };
  }

  const matches = matchEntries(db, int, regs);
  const keyed = db.isFunctionKeyed(int);
  const axKeyed = db.isAxKeyed(int);
  const top = matches[0];
  const specific = top !== undefined && top.open.length === 0 && (top.conds.length > 0 || !keyed);

  // Ranked alternatives become a cached resource handle.
  let queryUri: string | undefined;
  if (matches.length > 1) {
    const rows = matches.slice(0, 60).map(
      (m, i) => `${i + 1}. ${entryLabel(m.entry)} — ${m.entry.title}${m.matched.length ? ` [matched ${matchedSummary(m)}]` : ""} — ${uri.entry(m.entry.id)}`,
    );
    const handle = cache.put(
      {
        title: `Ranked candidates: INT ${int}h ${signature(regs)}`,
        description: `All ${matches.length} documented variants consistent with the registers you supplied, best first.`,
        mimeType: "text/markdown",
        text: `# INT ${int}h candidates for ${signature(regs)}\n\n${rows.join("\n")}${matches.length > 60 ? `\n\n… ${matches.length - 60} lower-ranked entries omitted` : ""}`,
      },
      TTL_SHORT_MS,
      `int${int}-${signature(regs)}`,
    );
    queryUri = uri.query(handle);
  }

  if (specific) {
    const e = top.entry;
    const fn = db.supplementFn(e);
    const sup = fn ? db.supplement(`${int}:${fn.replace("-", ":")}`) : undefined;
    const doc = [
      `${entryLabel(e)} — ${e.title}`,
      top.matched.length ? `Matched from your registers: ${matchedSummary(top)}.` : "",
      bestDescription(db, top),
    ].filter(Boolean).join("\n");

    const docs: string[] = [`- Full entry (every note, table and vendor quirk): ${uri.entry(e.id)}`];
    if (fn) {
      if (sup?.walkthrough) docs.push(`- Walkthrough (concise, with bit diagrams): ${uri.notes("walkthrough", int, fn)}`);
      if (sup?.reference.length) docs.push(`- Assembler reference and usage notes: ${uri.notes("reference", int, fn)}`);
    }
    if (e.ah !== null && !axKeyed) docs.push(`- Every variant of INT ${int}h AH=${hexKey(e.ah)}h: ${uri.fn(int, e.ah)}`);
    if (queryUri) docs.push(`- Other candidates consistent with your registers (ranked): ${queryUri}`);
    docs.push(`- Everything in INT ${int}h: ${uri.interrupt(int)}`);

    const hints: string[] = [];
    if (top.entry.ah !== null && top.entry.al === null && !axKeyed) {
      const siblings = matches.filter((m) => m.entry.ah === top.entry.ah && m.entry.id !== top.entry.id);
      if (siblings.length) {
        hints.push(`- ${siblings.length} other documented variant(s) share AH=${hexKey(top.entry.ah)}h (vendor/OS-version specific); see ${queryUri ?? uri.fn(int, top.entry.ah)}.`);
      }
    }
    if (e.regsOut.length) hints.push(`- After the call, check ${e.regsOut.map((r) => r.register).join(" / ")} (documented in register_outputs).`);
    const used = new Set(e.regsIn.flatMap((r) => r.register.split(/[:,]/)));
    const unused = regs.supplied.map((s) => s.register).filter((r) => !used.has(r) && !(r === "AX" && (used.has("AH") || used.has("AL"))));
    if (unused.length) hints.push(`- ${[...new Set(unused)].join(", ")} not documented as input for this call; fine if it is incidental, otherwise re-check the call site.`);

    return {
      ok: true,
      output: {
        interrupt: name,
        register_inputs: describeInputs(top, regs),
        register_outputs: describeOutputs(e),
        register_invocation_documentation: doc,
        complete_documentation: `Complete documentation available by category:\n${docs.join("\n")}`,
        tool_hint: hints.join("\n") || "- Nothing further needed to identify this call.",
      },
    };
  }

  // Family level: not enough (or contradicting) register context to pin one function.
  const disc = axKeyed ? "AX" : keyed ? "AH" : undefined;
  const fnValue = (e: Entry) => (axKeyed ? (e.ah! << 8) | (e.al ?? 0) : e.ah!);
  const groups = new Map<number, Match>();
  for (const m of matches) if (m.entry.ah !== null && !groups.has(fnValue(m.entry))) groups.set(fnValue(m.entry), m);
  const shown = [...groups.entries()].sort((a, b) => a[0] - b[0]).slice(0, 14);

  const none = keyed && groups.size === 0;
  const generic = entries.find((e) => e.ah === null);
  const intro = none
    ? `No documented INT ${int}h function is consistent with the registers you gave (${regs.supplied.map((s) => `${s.register}=${formatHex(s.value, s.bits === 8 ? 2 : 4)}`).join(", ")}). ` +
      `Either the value is outside the documented set, or the register holds a different meaning at this call site.`
    : `INT ${int}h is ${info.name}. ${disc ? `Which operation runs is selected by ${disc}; ` : ""}${groups.size} documented function(s) fit what you supplied.`;
  const documentation = [intro, !disc && generic ? bestDescription(db, { entry: generic, conds: [], matched: [], open: [], score: 0 }) : ""]
    .filter(Boolean)
    .join("\n");

  const docs = [`- Every function of INT ${int}h grouped by ${disc ?? "entry"}: ${uri.interrupt(int)}`];
  if (queryUri) docs.push(`- Ranked candidates for your registers: ${queryUri}`);

  const hints: string[] = [];
  if (disc) {
    const example = shown[0] ? hexKey(shown[0][0], axKeyed ? 4 : 2) : "00";
    hints.push(`- ${disc}: selects the operation. Provide its value at the call site (e.g. \`{"register":"${disc}","value":"0x${example}"}\`).`);
    if (shown.length) {
      hints.push(`- Documented values (${groups.size} total, first ${shown.length}):`);
      for (const [value, m] of shown) hints.push(`  - ${disc}=0x${hexKey(value, axKeyed ? 4 : 2)}: ${shortTitle(m.entry)}`);
    }
  }
  if (!disc && !generic) hints.push("- This interrupt has no register-selected functions in the bundled references.");

  return {
    ok: true,
    output: {
      interrupt: name,
      register_inputs: disc
        ? [{ register: disc, register_purpose: `selects the INT ${int}h operation; supply its value to get specific documentation` }]
        : [],
      register_outputs: [],
      register_invocation_documentation: documentation,
      complete_documentation: `Complete documentation available by category:\n${docs.join("\n")}`,
      tool_hint: hints.join("\n") || "- Supply the register values loaded just before the INT to narrow the result.",
    },
  };
}
