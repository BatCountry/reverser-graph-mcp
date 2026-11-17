import { formatHex, parseNumber } from "./hex.js";

// x86 register file model for describing the state "immediately before an INT".
// Values are tracked per byte/word so `AX=0x4C0A`, `AH=0x4C` and `AH=4C, AL=0A` are equivalent.

const WORD_REGS = ["AX", "BX", "CX", "DX"] as const;
const PTR_REGS = ["SI", "DI", "BP", "SP", "ES", "DS", "CS", "SS"] as const;
const HALF: Record<string, [hi: string, lo: string]> = {
  AX: ["AH", "AL"], BX: ["BH", "BL"], CX: ["CH", "CL"], DX: ["DH", "DL"],
};
const HALF_OF: Record<string, { word: string; high: boolean }> = {};
for (const [w, [hi, lo]] of Object.entries(HALF)) {
  HALF_OF[hi] = { word: w, high: true };
  HALF_OF[lo] = { word: w, high: false };
}

export const KNOWN_REGISTERS: readonly string[] = [
  ...WORD_REGS, ...Object.keys(HALF_OF), ...PTR_REGS, ...WORD_REGS.map((r) => `E${r}`),
];

export interface RegisterInput {
  register: string;
  value?: string | undefined;
}

export class RegisterFile {
  /** known bytes keyed by canonical 8-bit name (AH, AL, ...) */
  private bytes = new Map<string, number>();
  /** known 16-bit values for the pointer/segment registers (SI, DI, ES, ...) */
  private words = new Map<string, number>();
  /** registers named by the caller with no value, in original order */
  readonly unvalued: string[] = [];
  /** registers with a value, as the caller provided, canonical name -> value */
  readonly supplied: Array<{ register: string; value: number; bits: 8 | 16 | 32 }> = [];

  static from(inputs: readonly RegisterInput[]): { ok: true; regs: RegisterFile } | { ok: false; errors: string[] } {
    const rf = new RegisterFile();
    const errors: string[] = [];
    for (const [i, item] of inputs.entries()) {
      const err = rf.set(item, i);
      if (err) errors.push(err);
    }
    return errors.length ? { ok: false, errors } : { ok: true, regs: rf };
  }

  private set(item: RegisterInput, index: number): string | undefined {
    const label = `registers[${index}]`;
    if (typeof item?.register !== "string") return `${label}.register: expected a register name`;
    const name = item.register.trim().toUpperCase();
    if (!KNOWN_REGISTERS.includes(name)) {
      return `${label}.register: unknown register "${item.register}". Known: ${KNOWN_REGISTERS.join(", ")}`;
    }
    if (item.value === undefined || (typeof item.value === "string" && item.value.trim() === "")) {
      this.unvalued.push(name);
      return undefined;
    }
    const half = HALF_OF[name];
    const is32 = name.startsWith("E") && name.length === 3;
    const bits = half ? 8 : is32 ? 32 : 16;
    const max = bits === 8 ? 0xff : bits === 16 ? 0xffff : 0xffffffff;
    const parsed = parseNumber(item.value, max, `${label}(${name}).value`);
    if (!parsed.ok) return parsed.error;
    this.supplied.push({ register: name, value: parsed.value, bits });
    if (half) return this.setByte(name, parsed.value);
    if (is32) {
      // only the low word participates in real-mode interrupt dispatch
      return this.setWord(name.slice(1), parsed.value & 0xffff);
    }
    return this.setWord(name, parsed.value);
  }

  private setByte(name: string, v: number): string | undefined {
    const prev = this.bytes.get(name);
    if (prev !== undefined && prev !== v) {
      return `${name} given as both ${formatHex(prev)} and ${formatHex(v)}`;
    }
    this.bytes.set(name, v);
    return undefined;
  }

  private setWord(name: string, v: number): string | undefined {
    const halves = HALF[name];
    if (halves) {
      return this.setByte(halves[0], v >> 8) ?? this.setByte(halves[1], v & 0xff);
    }
    const prev = this.words.get(name);
    if (prev !== undefined && prev !== v) {
      return `${name} given as both ${formatHex(prev, 4)} and ${formatHex(v, 4)}`;
    }
    this.words.set(name, v);
    return undefined;
  }

  /** Value of a register if fully known (8-bit, or 16-bit assembled from halves). */
  get(name: string): number | undefined {
    const half = HALF[name];
    if (half) {
      const hi = this.bytes.get(half[0]);
      const lo = this.bytes.get(half[1]);
      return hi !== undefined && lo !== undefined ? (hi << 8) | lo : undefined;
    }
    return this.bytes.get(name) ?? this.words.get(name);
  }

  has(name: string): boolean {
    return this.get(name) !== undefined;
  }
}
