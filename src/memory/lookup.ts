import { readFileSync } from "node:fs";
import { formatHex, hexKey, parseHexKey, parseNumber } from "../hex.js";
import { uri } from "../interrupts/render.js";
import { LANDMARKS, REAL_MODE_MAX, REGIONS, type Region } from "./regions.js";

interface TableRow {
  seg: string;
  offset: string;
  size: string;
  text: string;
}
export interface MemoryTables {
  bda: TableRow[];
  psp: Array<{ offset: string; size: string; text: string }>;
  videoModes: string;
}

let tables: MemoryTables | undefined;
export function getMemoryTables(): MemoryTables {
  return (tables ??= JSON.parse(
    readFileSync(new URL("../../data/memory-tables.json", import.meta.url), "utf8"),
  ) as MemoryTables);
}

export interface MemoryOutput {
  offset: string;
  role: string;
  documentation: string;
  linear_address: string;
  interpretation: string;
  matched_range: string;
}
export type MemoryResult = { ok: true; output: MemoryOutput } | { ok: false; error: string };

interface Address {
  linear: number;
  interpretation: string;
  /** canonical SEGMENT:OFFSET to echo back when the caller gave one explicitly */
  shown?: string;
  /** set when a bare 16-bit number was read as a segment; carries the alternative reading */
  alternative?: number;
}

/**
 * Accepted forms (numbers need a hex marker; inside SEG:OFF both parts are hex and markers are optional):
 *  - `SSSS:OOOO`   segment:offset, each part 0..FFFF (`B800:0160`, `0xB800:0x160` also fine)
 *  - `0xA000` / `A000h`, up to 4 digits -> a SEGMENT (how games name video/BDA memory)
 *  - `0xB8000` written with 5+ digits (or any value above 0xFFFF) -> a LINEAR address (0..10FFEF)
 */
export function parseAddress(input: unknown): { ok: true; addr: Address } | { ok: false; error: string } {
  if (typeof input !== "string") return { ok: false, error: `offset: expected a string like "0xA000" or "A000:0010"` };
  const text = input.trim();
  if (text.includes(":")) {
    const parts = text.split(":");
    if (parts.length !== 2) return { ok: false, error: `offset: "${input}" must have exactly one ':' (segment:offset)` };
    const seg = parseHexKey(parts[0], 0xffff, "segment");
    if (!seg.ok) return seg;
    const off = parseHexKey(parts[1], 0xffff, "offset");
    if (!off.ok) return off;
    const linear = seg.value * 16 + off.value;
    if (linear > REAL_MODE_MAX) {
      return { ok: false, error: `offset: ${formatHex(seg.value, 4)}:${formatHex(off.value, 4)} is ${formatHex(linear, 6)}, past the real-mode limit ${formatHex(REAL_MODE_MAX, 6)} (FFFF:FFFF)` };
    }
    return {
      ok: true,
      addr: {
        linear,
        interpretation: `segment:offset ${hexKey(seg.value, 4)}:${hexKey(off.value, 4)} (both parts hex)`,
        shown: `${hexKey(seg.value, 4)}:${hexKey(off.value, 4)}`,
      },
    };
  }
  const v = parseNumber(text, REAL_MODE_MAX, "offset");
  if (!v.ok) return v;
  const written = formatHex(v.value, 0);
  if (v.value <= 0xffff && v.digits <= 4) {
    return {
      ok: true,
      addr: {
        linear: v.value * 16,
        interpretation: `${written} read as segment ${hexKey(v.value, 4)}:0000`,
        shown: `${hexKey(v.value, 4)}:0000`,
        alternative: v.value,
      },
    };
  }
  return { ok: true, addr: { linear: v.value, interpretation: `${written} read as linear (20-bit physical) address ${hexKey(v.value, 5)}` } };
}

function innermost(linear: number): Region | undefined {
  let best: Region | undefined;
  for (const r of REGIONS) {
    if (linear >= r.start && linear <= r.end && (!best || r.end - r.start < best.end - best.start)) best = r;
  }
  return best;
}

function fieldBytes(size: string): number | undefined {
  const m = /^(\d+)?\s*(byte|word|dword)s?$/i.exec(size.trim());
  if (!m) return undefined;
  return Number(m[1] ?? 1) * ({ byte: 1, word: 2, dword: 4 } as const)[m[2]!.toLowerCase() as "byte" | "word" | "dword"];
}

function bdaField(linear: number): string | undefined {
  const rows = getMemoryTables().bda
    .filter((r) => r.seg === "40" || r.seg === "50")
    .map((r) => ({ ...r, addr: parseInt(r.seg, 16) * 16 + parseInt(r.offset, 16) }))
    .sort((a, b) => a.addr - b.addr);
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]!;
    if (r.addr > linear) continue;
    const size = fieldBytes(r.size) ?? Math.max(1, (rows[i + 1]?.addr ?? r.addr + 1) - r.addr);
    if (linear < r.addr + size) {
      const within = linear - r.addr;
      return `${r.seg}:${r.offset.padStart(2, "0")} (${r.size || "?"}) ${r.text.split("\n")[0]}${within ? ` — you are ${within} byte(s) into this field` : ""}`;
    }
    return undefined;
  }
  return undefined;
}

/** SEGMENT:OFFSET using `base` (a region start) as the segment origin when the offset fits in 16 bits. */
function segOff(linear: number, base = linear): string {
  let seg = Math.min(base >> 4, 0xffff);
  if (linear - seg * 16 > 0xffff) seg = Math.min(linear >> 4, 0xffff);
  return `${hexKey(seg, 4)}:${hexKey(linear - seg * 16, 4)}`;
}

export function lookupMemory(input: unknown): MemoryResult {
  const parsed = parseAddress(input);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const { linear, interpretation, alternative, shown } = parsed.addr;
  const region = innermost(linear);
  const landmark = LANDMARKS.find((l) => linear >= l.start && linear <= l.end);
  const lines: string[] = [];

  if (!region) {
    return {
      ok: true,
      output: {
        offset: shown ?? segOff(linear),
        role: "Not mapped in the real-mode PC memory map",
        documentation: "Addresses must be 0..10FFEF in real mode. Nothing documented here.",
        linear_address: hexKey(linear, 5),
        interpretation,
        matched_range: "none",
      },
    };
  }

  const offsetInRegion = linear - region.start;
  lines.push(region.summary);
  if (landmark) lines.push(`**Landmark:** ${landmark.name} — ${landmark.note}`);

  if (region.id === "ivt") {
    const vec = linear >> 2;
    const part = linear & 3;
    const partName = part < 2 ? "offset (IP) word" : "segment (CS) word";
    lines.push(
      `**This slot:** vector ${hexKey(vec)}h (INT ${hexKey(vec)}h), byte ${part} of the entry (${partName}). Look it up with the interrupts tool using interrupt "0x${hexKey(vec)}".`,
    );
  }
  if (region.id === "bda" || region.id === "dos-comm") {
    const f = bdaField(linear);
    lines.push(f ? `**Field:** ${f}` : "**Field:** not a field named in the bundled BDA table (reserved or machine-specific).");
  }
  if (region.id === "ega-vga-graphics" || region.id === "cga-text-graphics" || region.id === "mda-hercules") {
    lines.push(`**Position:** offset ${formatHex(offsetInRegion, 4)} (${offsetInRegion}) from ${hexKey(region.start >> 4, 4)}:0000.`);
  }
  if (alternative !== undefined && alternative < 0x1000) {
    const alt = innermost(alternative);
    if (alt && alt.id !== region.id) {
      lines.push(
        `**Also possible:** if you meant ${formatHex(alternative, 4)} as an offset in segment 0000h (a linear address), it falls in ${alt.name}: ${uri.memory(alt.id)}.`,
      );
    }
  }
  lines.push(
    `\nMore: ${uri.memory(region.id)} (full detail)` +
      (region.id === "bda" || region.id === "dos-comm" ? `, ${uri.memory("bda")} (field table)` : "") +
      (region.id === "ega-vga-graphics" || region.id === "cga-text-graphics" || region.id === "mda-hercules" ? `, ${uri.memory("video-modes")} (video modes)` : "") +
      (region.id === "conventional" ? `, ${uri.memory("psp")} (Program Segment Prefix layout)` : ""),
  );

  return {
    ok: true,
    output: {
      offset: shown ?? segOff(linear, region.start),
      role: region.role,
      documentation: lines.join("\n"),
      linear_address: hexKey(linear, 5),
      interpretation,
      matched_range: `${segOff(region.start)} - ${segOff(region.end, region.start)} (${region.name})`,
    },
  };
}

export const MEMORY_DOC_IDS = [...REGIONS.map((r) => r.id), "bda", "psp", "video-modes"] as const;

export function renderMemoryDoc(id: string): string | undefined {
  const t = getMemoryTables();
  const region = REGIONS.find((r) => r.id === id);
  if (id === "bda") {
    const rows = t.bda
      .filter((r) => r.seg === "40" || r.seg === "50")
      .map((r) => `${r.seg}:${r.offset.padStart(2, "0")}\t${r.size || "-"}\t${r.text.replace(/\n/g, " / ")}`);
    return `# BIOS data area (0040:xxxx) and DOS communication area (0050:xxxx) fields\n\nAddress, size, description.\n\n\`\`\`\n${rows.join("\n")}\n\`\`\``;
  }
  if (id === "psp") {
    const rows = t.psp.map((r) => `${r.offset.padStart(2, "0")}\t${r.size}\t${r.text.replace(/\n/g, " / ")}`);
    return `# Program Segment Prefix (PSP) — first 256 bytes of every DOS program\n\nOffset, size, description. The PSP segment is in DS/ES at .EXE entry and CS at .COM entry; INT 21h AH=62h returns it in BX.\n\n\`\`\`\n${rows.join("\n")}\n\`\`\``;
  }
  if (id === "video-modes") {
    return `# Standard BIOS video modes 00h-13h\n\nSet with INT 10h AH=00h AL=mode; read back from 0040:0049. Columns: text/graphics, text grid, character box, pixel resolution, colours, display pages, video segment, adapters.\n\n\`\`\`\n${t.videoModes}\n\`\`\``;
  }
  return region ? region.detail : undefined;
}
