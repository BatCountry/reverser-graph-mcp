import type { GraphEdge, GraphNode } from "./model.js";

// Addresses as the listings and the code print them, mapped back to graph nodes.
//
// The same byte can be written several ways: a far call names it by its unrelocated segment:offset (`lcall 0x5cd, 0x634`,
// or through an overlay stub, `lcall 0x41, 0x25`), a listing line or near call by its offset in the space (`5c10`,
// `call 0x34f`). Rather than hard-coding those bases, they are learned from the call graph itself: every edge pairs an
// operand as written with the node it reaches, so `written linear address - node address` votes for a frame (form,
// source file, base). The graph file may also declare frames.

/** How addresses are written: `seg` = segment:offset, `flat` = a bare offset. */
export type AddressForm = "seg" | "flat";

/** One way of writing addresses of a source file: node address = written linear address - base. Learned from edges or declared. */
export interface Frame {
  form: AddressForm;
  file: string;
  base: number;
  /** distinct targets that agreed on this base (0: declared by the graph file, not observed) */
  votes: number;
  /** what writes addresses this way, when the graph file says (e.g. "unrelocated segment:offset") */
  label?: string;
}

/** `transfer`: the text was a call/jmp operand, so it names a target (a function start), not an instruction inside one. */
export type ParsedAddress =
  | { form: "name"; space: string; offset: number; transfer: boolean }
  | { form: "seg"; segment: number; offset: number; transfer: boolean }
  | { form: "flat"; offset: number; transfer: boolean }
  | { form: "invalid"; reason: string; /** unmarked hex that is not a 4-digit listing address */ bareHex: boolean };

/** What sits at an address: a node starting there, an overlay stub standing for a node, or an instruction inside a node. */
export interface Hit {
  id: string;
  how: "node" | "stub" | "site";
  space: string;
  address: number;
}

/** A frame needs this many distinct targets agreeing on its base: stray operands (data, jump tables) never reach it. */
export const MIN_FRAME_VOTES = 3;

const MNEMONIC = /^(?:l?call[fn]?|l?jmp[fn]?|j[a-z]{1,4}|loop[a-z]{0,2})\s+/;
const SIZE_WORDS = /\b(?:dword|word|far|near|ptr)\s+/g;
const NAME = /^([a-z][\w-]*):(?:0x)?([0-9a-f]{1,8})h?$/;
const SEG_OFF = /^(?:0x)?([0-9a-f]{1,4})h?\s*[:,]\s*(?:0x)?([0-9a-f]{1,4})h?$/;
const FLAT_MARKED = /^(?:0x([0-9a-f]{1,8})|([0-9a-f]{1,8})h)$/;
/** unmarked offsets only in the width listing lines print: 1a2c */
const FLAT_LISTING = /^([0-9a-f]{4})$/;

/**
 * Parse an address the way a model copies it out of a listing: an optional call/jmp mnemonic, size words, `0x` prefixes or
 * `h` suffixes, `seg:off` or capstone's `seg, off`, node names (MAIN_OVR-0020:1a2c). Hex throughout: listings never print
 * decimal addresses.
 */
export function parseAddress(text: string): ParsedAddress {
  const lower = text.trim().toLowerCase();
  const transfer = MNEMONIC.test(lower);
  const s = lower.replace(MNEMONIC, "").replace(SIZE_WORDS, "").trim();
  if (!s) return { form: "invalid", reason: "empty", bareHex: false };
  const name = NAME.exec(s);
  // a "space" that is itself 1-4 hex digits is a segment (b800:0010), not a name
  if (name && !/^[0-9a-f]{1,4}$/.test(name[1]!)) return { form: "name", space: name[1]!, offset: parseInt(name[2]!, 16), transfer };
  const seg = SEG_OFF.exec(s);
  if (seg) return { form: "seg", segment: parseInt(seg[1]!, 16), offset: parseInt(seg[2]!, 16), transfer };
  const flat = FLAT_MARKED.exec(s) ?? FLAT_LISTING.exec(s);
  if (flat) return { form: "flat", offset: parseInt(flat[1] ?? flat[2]!, 16), transfer };
  if (/^[0-9a-f]+$/.test(s)) return { form: "invalid", reason: `"${text.trim()}" has no 0x or h marker and is not a 4-digit listing address: write it as 0x${s} (with the segment if the listing shows one)`, bareHex: true };
  return { form: "invalid", reason: `"${text.trim()}" is not a node name or an address`, bareHex: false };
}

export class AddressIndex {
  readonly frames: readonly Frame[];
  /** lowercase space -> canonical space */
  private readonly spaceNames = new Map<string, string>();
  private readonly spaceFile = new Map<string, string>();
  /** source file -> address -> hits */
  private readonly places = new Map<string, Map<number, Hit[]>>();
  /** source file -> highest address anything is known at */
  private readonly highest = new Map<string, number>();
  private readonly functions = new Set<string>();

  constructor(nodes: ReadonlyMap<string, GraphNode>, edges: readonly GraphEdge[], aliases: Readonly<Record<string, string>>, declared: unknown = undefined) {
    for (const n of nodes.values()) {
      if (!n.space || !n.source_file) continue;
      this.spaceNames.set(n.space.toLowerCase(), n.space);
      this.spaceFile.set(n.space, n.source_file);
      if (n.kind === "function") this.functions.add(n.id);
      if (n.address !== null) this.add(n.space, n.address, { id: n.id, how: "node" });
    }
    /** node id -> stubs (space, address) that stand for it */
    const stubs = new Map<string, Array<{ space: string; address: number }>>();
    for (const [key, target] of Object.entries(aliases)) {
      const p = this.placeOf(key);
      if (!p || !nodes.has(target)) continue;
      this.add(p.space, p.address, { id: target, how: "stub" });
      (stubs.get(target) ?? stubs.set(target, []).get(target)!).push(p);
    }
    for (const e of edges) {
      const sites = [e.instruction_offset, ...e.conditions.map((c) => c.offset)];
      for (const site of sites) {
        const p = this.placeOf(site);
        if (p) this.add(p.space, p.address, { id: e.source, how: "site" });
      }
    }
    this.frames = mergeFrames(learnFrames(nodes, edges, stubs, this.spaceFile), declaredFrames(declared));
    for (const [file, byAddr] of this.places) this.highest.set(file, Math.max(...byAddr.keys()));
  }

  canonicalSpace(space: string): string | undefined {
    return this.spaceNames.get(space.toLowerCase());
  }

  /** Every hit an address could mean, and the (file, address) readings tried; readings past a file's last known address are skipped. */
  lookup(p: ParsedAddress): { hits: Hit[]; tried: Array<{ file: string; address: number }> } {
    const tried: Array<{ file: string; address: number }> = [];
    if (p.form === "invalid") return { hits: [], tried };
    if (p.form === "name") {
      const space = this.canonicalSpace(p.space);
      const file = space && this.spaceFile.get(space);
      if (!space || !file) return { hits: [], tried };
      tried.push({ file, address: p.offset });
      return { hits: (this.places.get(file)?.get(p.offset) ?? []).filter((h) => h.space === space), tried };
    }
    const written = p.form === "seg" ? p.segment * 16 + p.offset : p.offset;
    const hits: Hit[] = [];
    for (const f of this.frames) {
      if (f.form !== p.form || written < f.base) continue;
      const address = written - f.base;
      if (address > (this.highest.get(f.file) ?? -1)) continue;
      tried.push({ file: f.file, address });
      hits.push(...(this.places.get(f.file)?.get(address) ?? []));
    }
    return { hits, tried };
  }

  /** Per space of `file`, the node starting nearest at or below `address`: what an address mid-function probably sits in. Nearest first. */
  containersOf(file: string, address: number, limit: number): Hit[] {
    const best = new Map<string, Hit>();
    for (const [addr, hits] of this.places.get(file) ?? []) {
      if (addr > address) continue;
      for (const h of hits) if (h.how === "node" && this.functions.has(h.id) && addr > (best.get(h.space)?.address ?? -1)) best.set(h.space, h);
    }
    return [...best.values()].sort((a, b) => b.address - a.address).slice(0, limit);
  }

  private placeOf(key: string): { space: string; address: number } | undefined {
    const i = key.lastIndexOf(":");
    if (i < 0) return undefined;
    const space = this.canonicalSpace(key.slice(0, i));
    const address = parseInt(key.slice(i + 1), 16);
    return space && Number.isFinite(address) ? { space, address } : undefined;
  }

  private add(space: string, address: number, hit: Omit<Hit, "space" | "address">): void {
    const file = this.spaceFile.get(space);
    if (!file) return;
    let byAddr = this.places.get(file);
    if (!byAddr) this.places.set(file, (byAddr = new Map()));
    let list = byAddr.get(address);
    if (!list) byAddr.set(address, (list = []));
    if (!list.some((h) => h.id === hit.id && h.how === hit.how && h.space === space)) list.push({ ...hit, space, address });
  }
}

function learnFrames(
  nodes: ReadonlyMap<string, GraphNode>,
  edges: readonly GraphEdge[],
  stubs: ReadonlyMap<string, ReadonlyArray<{ space: string; address: number }>>,
  spaceFile: ReadonlyMap<string, string>,
): Frame[] {
  const votes = new Map<string, { form: AddressForm; file: string; base: number; targets: Set<string> }>();
  const vote = (form: AddressForm, file: string, base: number, target: string) => {
    const key = `${form}|${file}|${base}`;
    let v = votes.get(key);
    if (!v) votes.set(key, (v = { form, file, base, targets: new Set() }));
    v.targets.add(target);
  };
  for (const e of edges) {
    // a link's instruction (`int 0x66`, a batch line) never writes its target's address
    if (e.link !== undefined) continue;
    const operand = parseAddress(e.instruction);
    if (operand.form !== "seg" && operand.form !== "flat") continue;
    const written = operand.form === "seg" ? operand.segment * 16 + operand.offset : operand.offset;
    const t = nodes.get(e.target);
    if (t?.source_file && t.address !== null) vote(operand.form, t.source_file, written - t.address, t.id);
    for (const s of stubs.get(e.target) ?? []) {
      const file = spaceFile.get(s.space);
      if (file) vote(operand.form, file, written - s.address, `stub:${s.space}:${s.address}`);
    }
  }
  return [...votes.values()]
    .filter((v) => v.base >= 0 && v.base % 16 === 0 && v.targets.size >= MIN_FRAME_VOTES)
    .map((v) => ({ form: v.form, file: v.file, base: v.base, votes: v.targets.size }))
    .sort((a, b) => b.votes - a.votes);
}

/**
 * Frames the graph file declares (`frames: [{form, file, base, label}]`), e.g. how the code writes far addresses:
 * conventions no edge in the graph demonstrates. The file is untrusted input: malformed entries are dropped.
 */
export function declaredFrames(raw: unknown): Frame[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((f: unknown): Frame[] => {
    if (typeof f !== "object" || f === null) return [];
    const { form, file, base, label } = f as Record<string, unknown>;
    if ((form !== "seg" && form !== "flat") || typeof file !== "string" || !file) return [];
    if (typeof base !== "number" || !Number.isSafeInteger(base) || base < 0 || base % 16 !== 0) return [];
    return [{ form, file, base, votes: 0, ...(typeof label === "string" && label ? { label } : {}) }];
  });
}

/** Learned frames first (by votes); a declared frame adds its label to the learned one it matches, or is appended. */
function mergeFrames(learned: Frame[], declared: Frame[]): Frame[] {
  const key = (f: Frame) => `${f.form}|${f.file}|${f.base}`;
  const byKey = new Map(learned.map((f) => [key(f), f]));
  for (const d of declared) {
    const known = byKey.get(key(d));
    if (known) byKey.set(key(d), { ...known, ...(d.label ? { label: d.label } : {}) });
    else byKey.set(key(d), d);
  }
  return [...byKey.values()];
}
