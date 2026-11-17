// Parsing of untrusted numeric strings coming from an LLM client.
// Convention: every number from the client must be marked hex: `0x4C` or `4Ch`. Bare digits are rejected
// because a model cannot be trusted to mean decimal or hex when it writes "21" or "10".
// (Inside `SEGMENT:OFFSET` and far-call operands the parts are hex by universal convention.)

export type NumResult =
  | { ok: true; value: number; /** number of hex digits written, excluding the marker */ digits: number }
  | { ok: false; error: string };

/** More digits than any value we accept; guards against absurdly long inputs. */
const MAX_DIGITS = 12;
const HEX_PREFIXED = /^0x([0-9a-f]+)$/i;
const HEX_SUFFIXED = /^([0-9a-f]+)h$/i;
const HEX_DIGITS = /^[0-9a-f]+$/i;

export const NUMBER_FORMAT_HELP = "Numbers must be hex with a marker: 0x4C or 4Ch. No signs, fractions, NaN or Infinity.";

export function parseNumber(input: unknown, max: number, label = "value"): NumResult {
  if (typeof input !== "string") {
    return { ok: false, error: `${label}: expected a string such as "0x4C", "4Ch" or "76", got ${typeof input}` };
  }
  const s = input.trim().replace(/_/g, "");
  if (s === "") return { ok: false, error: `${label}: empty value` };

  const m = HEX_PREFIXED.exec(s) ?? HEX_SUFFIXED.exec(s);
  if (!m) {
    if (HEX_DIGITS.test(s)) {
      const kind = /^[0-9]+$/.test(s) ? "Bare digits are ambiguous (decimal or hex?) and are not accepted" : "Hex letters need a hex marker";
      return { ok: false, error: `${label}: "${input}" has no hex marker. ${kind}: write 0x${s.toUpperCase()} or ${s.toUpperCase()}h` };
    }
    return { ok: false, error: `${label}: "${input}" is not a number. ${NUMBER_FORMAT_HELP}` };
  }
  const digits = m[1]!;
  if (digits.length > MAX_DIGITS) return { ok: false, error: `${label}: "${input}" is too long` };
  const value = parseInt(digits, 16);
  if (!Number.isSafeInteger(value) || value > max) {
    return { ok: false, error: `${label}: ${input.trim()} is above the maximum ${formatHex(max, 0)}. ${NUMBER_FORMAT_HELP}` };
  }
  return { ok: true, value, digits: digits.length };
}

/**
 * Hex digits only, no marker: the key format inside dosref:// resource URIs and in SEGMENT:OFFSET.
 * Also tolerates an explicit 0x prefix or h suffix.
 */
export function parseHexKey(input: unknown, max: number, label = "value"): NumResult {
  if (typeof input !== "string") return { ok: false, error: `${label}: expected hex digits, got ${typeof input}` };
  const s = input.trim().replace(/_/g, "");
  const m = HEX_PREFIXED.exec(s) ?? HEX_SUFFIXED.exec(s);
  const digits = m ? m[1]! : s;
  if (!HEX_DIGITS.test(digits)) return { ok: false, error: `${label}: "${input}" is not hex digits` };
  if (digits.length > MAX_DIGITS) return { ok: false, error: `${label}: "${input}" is too long` };
  const value = parseInt(digits, 16);
  if (value > max) return { ok: false, error: `${label}: ${formatHex(value, 0)} is above the maximum ${formatHex(max, 0)}` };
  return { ok: true, value, digits: digits.length };
}

/** Accepts `0x21`, `21h`, `INT 0x21`, `int 21h`. Bare digits are rejected. Result is 0..255. */
export function parseInterruptNumber(input: unknown): NumResult {
  if (typeof input !== "string") {
    return { ok: false, error: `interrupt: expected a string such as "0x21", "21h" or "INT 21h"` };
  }
  return parseNumber(input.trim().replace(/^int(?:errupt)?\s*/i, ""), 0xff, "interrupt");
}

export function formatHex(n: number, width = 2): string {
  return `0x${n.toString(16).toUpperCase().padStart(width, "0")}`;
}

/** Hex without prefix, uppercase, zero padded: used in resource URIs. */
export function hexKey(n: number, width = 2): string {
  return n.toString(16).toUpperCase().padStart(width, "0");
}
