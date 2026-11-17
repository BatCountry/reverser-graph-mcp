import { readFileSync } from "node:fs";
import path from "node:path";
import { AddressIndex, parseAddress, type Hit } from "./addresses.js";

// Shape of <disassembly_root>/navigation/callgraph.json (see its README.md).

export interface GraphNode {
  id: string;
  kind: "function" | "address" | "unknown-target" | string;
  space: string | null;
  address: number | null;
  file_offset: number | null;
  source_file: string | null;
  /** best single listing the graph generator knew; path starts at or below ".../units/" */
  listing: string | null;
  entrypoint: boolean;
  /** function: nothing known calls or jumps here; it is listed because its address is built in the code */
  provisional?: boolean;
  /** function: the transfers that prove it and where its address is built (capped; analysis.json has all) */
  evidence?: string[];
  /** unknown-target: why the site has no (complete) function target */
  reason?: string;
}

export interface EdgeCondition {
  direction: string;
  expression: string;
  offset: string;
}

export interface GraphEdge {
  source: string;
  target: string;
  /** instruction text at the transfer site, e.g. "lcall 0x41, 0x25" */
  instruction: string;
  /** node-space identity of the transfer site, e.g. "MAIN_OVR-0020:37a2" */
  instruction_offset: string;
  returns: boolean;
  conditions: EdgeCondition[];
  /** indirect transfer: the memory or register its target was read through, e.g. "ds:[6a78]"; on a link, how the link is made */
  through?: string;
  /** true when the target matches by record field offset only (on a link: the handler is known only from a hook record): possible, not proven */
  provisional?: boolean;
  /** set when the edge leaves the program (see EdgeLink); absent on calls, jumps and indirect transfers */
  link?: EdgeLink;
}

/**
 * How a link edge reaches another program, or a batch file line a program: `runs` is a DOS exec or a batch line,
 * `loads` opens another program's file to read it, `interrupt` is an `int n` answered by the handler a resident
 * program installs. A link is the other program's interface, never a function call.
 */
export type EdgeLink = "runs" | "loads" | "interrupt";
const LINK_WORDS: Record<EdgeLink, true> = { runs: true, loads: true, interrupt: true };

/**
 * The edge as the rest of the server may trust it. Untrusted input: a `link` that is not one of the EdgeLink words
 * (another string, a number, null) is dropped, so the edge reads as a plain call or jump, the way it would in a tree
 * written before links existed; the rest of the edge is kept.
 */
function normalizeEdge(edge: GraphEdge): GraphEdge {
  if (!("link" in edge) || (typeof edge.link === "string" && Object.hasOwn(LINK_WORDS, edge.link))) return edge;
  const { link: _dropped, ...plain } = edge;
  return plain;
}

interface GraphFile {
  nodes: Record<string, GraphNode>;
  edges: GraphEdge[];
  /** "far call segment:offset" -> node id */
  aliases: Record<string, string>;
  /** optional declared address frames (validated by AddressIndex): [{form, file, base, label}] */
  frames?: unknown;
  /** optional program file -> the files its code comes from (validated by programTable) */
  programs?: unknown;
}

/**
 * source file -> program file, from the graph file's `programs` table. Untrusted input: entries that are not a list
 * of strings are dropped, and a file a second program also claims stays with the first.
 */
export function programTable(raw: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  for (const [program, files] of Object.entries(raw)) {
    if (!Array.isArray(files)) continue;
    for (const f of files) if (typeof f === "string" && !out.has(f)) out.set(f, program);
  }
  return out;
}

/** `note` explains how an address (not a node name) was read, for the reply. */
export type Resolved = { ok: true; node: GraphNode; note?: string } | { ok: false; error: string };

const hex4 = (n: number) => n.toString(16).padStart(4, "0");
/** an alias written as unrelocated `segment:offset` (a stub-table entry), not `<space>:<offset>` */
const SEG_ALIAS = /^([0-9a-f]{4}):([0-9a-f]{4})$/;

function describeHit(h: Hit): string {
  const at = `${h.space}:${hex4(h.address)}`;
  if (h.how === "node") return h.id;
  if (h.how === "stub") return `${h.id} (through the overlay stub at ${at})`;
  return `${h.id} (the call or branch at ${at} is inside it)`;
}

export class CallGraph {
  readonly nodes: ReadonlyMap<string, GraphNode>;
  readonly edges: readonly GraphEdge[];
  /** node id -> edges leaving / entering it */
  readonly out = new Map<string, GraphEdge[]>();
  readonly into = new Map<string, GraphEdge[]>();
  /** lowercased call-site id ("main_ovr-0020:1a4b") -> edges leaving from that instruction */
  readonly bySite = new Map<string, GraphEdge[]>();
  /** lowercased id -> canonical id */
  private readonly byLower = new Map<string, string>();
  private readonly aliases = new Map<string, string>();
  readonly addresses: AddressIndex;
  /** space -> function nodes in that space, ascending address */
  readonly bySpace = new Map<string, GraphNode[]>();
  private readonly programByFile: Map<string, string>;
  private readonly fileBySpace = new Map<string, string>();

  constructor(file: GraphFile) {
    this.nodes = new Map(Object.entries(file.nodes));
    this.edges = file.edges.map(normalizeEdge);
    for (const [id, node] of this.nodes) {
      this.byLower.set(id.toLowerCase(), id);
      if (node.space && node.kind === "function") {
        let list = this.bySpace.get(node.space);
        if (!list) this.bySpace.set(node.space, (list = []));
        list.push(node);
      }
      if (node.space && node.source_file) this.fileBySpace.set(node.space, node.source_file);
    }
    this.programByFile = programTable(file.programs);
    for (const list of this.bySpace.values()) list.sort((a, b) => (a.address ?? 0) - (b.address ?? 0));
    for (const e of this.edges) {
      (this.out.get(e.source) ?? this.out.set(e.source, []).get(e.source)!).push(e);
      (this.into.get(e.target) ?? this.into.set(e.target, []).get(e.target)!).push(e);
      const site = e.instruction_offset.toLowerCase();
      (this.bySite.get(site) ?? this.bySite.set(site, []).get(site)!).push(e);
    }
    for (const [k, v] of Object.entries(file.aliases)) this.aliases.set(k.toLowerCase(), v);
    this.addresses = new AddressIndex(this.nodes, this.edges, file.aliases, file.frames);
  }

  static load(disassemblyRoot: string): CallGraph {
    const file = path.join(disassemblyRoot, "navigation", "callgraph.json");
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (error) {
      throw new Error(`Cannot read the call graph at ${file}. Set --disassembly-root / REVERSER_DISASSEMBLY_ROOT to the directory containing navigation/callgraph.json. (${String(error)})`);
    }
    // callgraph.json is a generated artifact with a documented shape (navigation/README.md).
    const parsed: GraphFile = JSON.parse(text);
    return new CallGraph(parsed);
  }

  /** Callers, deduplicated per caller. */
  callersOf(id: string): Array<{ node: string; edges: GraphEdge[] }> {
    return group(this.into.get(id) ?? [], (e) => e.source);
  }

  calleesOf(id: string): Array<{ node: string; edges: GraphEdge[] }> {
    return group(this.out.get(id) ?? [], (e) => e.target);
  }

  /** Nodes nothing calls that call something: where execution (or an untraced dispatch) can start. */
  isRoot(id: string): boolean {
    return (this.into.get(id)?.length ?? 0) === 0 && (this.out.get(id)?.length ?? 0) > 0;
  }

  /**
   * The far calls other code writes to reach `id` through a stub table (`lcall 0xa5, 0x25` for alias "00a5:0025"):
   * the segment names the overlay, the offset picks a stub-table entry that jumps to `id`; that offset is no address
   * inside the overlay. Sorted; empty for code reached only directly.
   */
  stubCallsTo(id: string): string[] {
    const out: string[] = [];
    for (const [key, target] of this.aliases) {
      const m = SEG_ALIAS.exec(key);
      if (m && target === id) out.push(`lcall 0x${parseInt(m[1]!, 16).toString(16)}, 0x${parseInt(m[2]!, 16).toString(16)}`);
    }
    return out.sort();
  }

  /**
   * The program `id`'s code belongs to (its executable's file name; overlay code belongs to the program it overlays),
   * for an unknown target the program of the space it was found in. A tree without a `programs` table is one program
   * (""); undefined for an id in no known file.
   */
  programOf(id: string): string | undefined {
    const file = this.nodes.get(id)?.source_file ?? (id.startsWith("unknown:") ? this.fileBySpace.get(id.split(":")[1]!) : undefined);
    if (!file) return undefined;
    return this.programByFile.get(file) ?? (this.programByFile.size ? undefined : "");
  }

  /**
   * Resolve a graph node id ("MAIN_OVR-0020:1a2c", case-insensitive) or any address as a listing prints it (`lcall 0x41, 0x25`,
   * `5cd:0634`, `5c10`), far-call aliases (0016:0020), or a call/branch site inside a function.
   */
  resolve(raw: string | undefined): Resolved {
    const text = raw?.trim() ?? "";
    if (!text) return { ok: false, error: "Pass a module: a node name such as MAIN_OVR-0020:1a2c, or an address copied from a listing such as lcall 0x41, 0x25 or 5cd:0634." };
    const id = this.byLower.get(text.toLowerCase());
    if (id) return { ok: true, node: this.nodes.get(id)! };

    const parsed = parseAddress(text);
    if (parsed.form === "invalid") return { ok: false, error: parsed.bareHex ? `${parsed.reason}.` : `${parsed.reason}. ${this.unknownNode(text)}` };
    if (parsed.form === "seg") {
      const alias = this.aliases.get(`${hex4(parsed.segment)}:${hex4(parsed.offset)}`);
      if (alias) return { ok: true, node: this.nodes.get(alias)!, note: `"${text}" is the far-call alias of ${alias}.` };
    }
    if (parsed.form === "name" && !this.addresses.canonicalSpace(parsed.space)) return { ok: false, error: this.unknownNode(text) };

    const { hits, tried } = this.addresses.lookup(parsed);
    // a call/jmp operand names a function start; a bare address may equally be a line inside a function
    const strong = hits.filter((h) => h.how !== "site");
    const pool = parsed.transfer && strong.length > 0 ? strong : hits;
    const distinct = [...new Map(pool.map((h) => [h.id, h])).values()];
    if (distinct.length === 1) {
      const hit = distinct[0]!;
      return { ok: true, node: this.nodes.get(hit.id)!, note: hit.how === "node" && parsed.form === "name" ? undefined : `"${text}" read as ${describeHit(hit)}.` };
    }
    if (distinct.length > 1) {
      const shown = distinct.slice(0, 8).map(describeHit).join("; ");
      return { ok: false, error: `"${text}" could mean ${distinct.length} different functions: ${shown}${distinct.length > 8 ? "; …" : ""}. Overlays share one address range, so pick the one in the overlay whose listing you are reading and pass its node name.` };
    }
    if (parsed.form === "name") return { ok: false, error: this.unknownNode(`${this.addresses.canonicalSpace(parsed.space)}:${hex4(parsed.offset)}`) };
    if (tried.length === 0) return { ok: false, error: `"${text}" does not match how any listing in this tree writes addresses. Pass a node name such as MAIN_OVR-0020:1a2c.` };
    const below = tried
      .flatMap((t) => this.addresses.containersOf(t.file, t.address, 5).map((h) => ({ h, gap: t.address - h.address })))
      .sort((a, b) => a.gap - b.gap)
      .slice(0, 5)
      .map(({ h, gap }) => `${h.id} (+0x${gap.toString(16)})`);
    const readings = tried.map((t) => `${t.file} offset 0x${t.address.toString(16)}`).join(", ");
    return {
      ok: false,
      error: `No function, overlay stub or call site at "${text}" (read as ${readings}).` + (below.length ? ` If it is an address inside a function, the nearest function starts below it are: ${below.join(", ")}.` : ""),
    };
  }

  /** A helpful error: which spaces exist, and near misses in the requested space. */
  private unknownNode(name: string): string {
    const space = name.includes(":") ? name.slice(0, name.indexOf(":")) : name;
    const inSpace = this.bySpace.get(this.byLower.get(space.toLowerCase()) ?? space) ?? [...this.bySpace].find(([k]) => k.toLowerCase() === space.toLowerCase())?.[1];
    if (inSpace) {
      const target = name.includes(":") ? parseInt(name.slice(name.indexOf(":") + 1), 16) : Number.NaN;
      const nearby = Number.isNaN(target) ? inSpace.slice(0, 6) : [...inSpace].sort((a, b) => Math.abs((a.address ?? 0) - target) - Math.abs((b.address ?? 0) - target)).slice(0, 6);
      return `No graph node "${name}". Nearest functions in ${inSpace[0]!.space}: ${nearby.map((n) => n.id).join(", ")} (${inSpace.length} functions in that space).`;
    }
    const spaces = [...this.bySpace.keys()];
    return `No graph node "${name}". Names look like MAIN_OVR-0020:1a2c or MAIN_EXE:4f20 (the file the code is in, then the address its listing shows). Known spaces: ${spaces.slice(0, 8).join(", ")}${spaces.length > 8 ? `, ... (${spaces.length} total)` : ""}.`;
  }
}

function group(edges: readonly GraphEdge[], key: (e: GraphEdge) => string): Array<{ node: string; edges: GraphEdge[] }> {
  const m = new Map<string, GraphEdge[]>();
  for (const e of edges) (m.get(key(e)) ?? m.set(key(e), []).get(key(e))!).push(e);
  return [...m].map(([node, list]) => ({ node, edges: list }));
}

let shared: { root: string; graph: CallGraph } | undefined;
/** Process-wide graph keyed by root so tests and relocations get a fresh load. */
export function getCallGraph(disassemblyRoot: string): CallGraph {
  if (shared?.root !== disassemblyRoot) shared = { root: disassemblyRoot, graph: CallGraph.load(disassemblyRoot) };
  return shared.graph;
}
