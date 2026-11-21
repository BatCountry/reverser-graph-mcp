import { McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import { queryCache, TTL_SHORT_MS } from "./cache.js";
import { hexKey, parseHexKey } from "./hex.js";
import { getInterruptDb } from "./interrupts/db.js";
import { renderEntry, renderFunctionFamily, renderInterruptOverview, renderTopics, SCHEME } from "./interrupts/render.js";
import { MEMORY_DOC_IDS, renderMemoryDoc } from "./memory/lookup.js";
import { readFileSync } from "node:fs";
import { listingFor } from "./graph/files.js";
import { annotateCallTargets } from "./graph/listing-targets.js";
import { selectLines } from "./graph/line-range.js";
import { lookupDataReferences, renderDataReferencesText } from "./graph/datarefs.js";
import { disasmUris, renderModuleText, renderNeighbors, lookupModule, type Context } from "./graph/tools.js";
import { renderWorkPlan, renderWorkUnit, WORK_PLAN_ROWS } from "./tools/next_work.js";
import type { Correspondence } from "./compare/correspond.js";
import { compareUris, MAP_FILTERS, MAP_PAGE_ROWS, renderMap, renderPairFull, type MapFilter } from "./compare/render.js";
import { PORT_DOC_IDS, renderPortDoc } from "./ports/lookup.js";

type Variables = Record<string, string | string[]>;

const DAY_MS = 24 * 60 * 60_000;
/** Reference text is immutable for the life of the data build: let clients cache it for a day. */
const STATIC_HINT = { ttlMs: DAY_MS, cacheScope: "public" } as const;
/** Query handles expire server-side after TTL_SHORT_MS; do not let clients hold them longer. */
const QUERY_HINT = { ttlMs: TTL_SHORT_MS / 2, cacheScope: "private" } as const;

function one(v: Variables, key: string): string {
  const x = v[key];
  return Array.isArray(x) ? (x[0] ?? "") : (x ?? "");
}

function markdown(uri: URL, text: string) {
  return { contents: [{ uri: uri.href, mimeType: "text/markdown", text }] };
}

function intKey(raw: string): string {
  const p = parseHexKey(raw, 0xff, "interrupt");
  if (!p.ok) throw new Error(p.error);
  return hexKey(p.value);
}

function ahKey(raw: string): number {
  const p = parseHexKey(raw, 0xff, "function");
  if (!p.ok) throw new Error(p.error);
  return p.value;
}

/** `tree`: the disassembly root's directory name; every disasm:// URI starts with it (see disasmUris). */
export function registerResources(server: McpServer, graphContext: () => Context, tree: string): void {
  const uris = disasmUris(tree);
  const db = getInterruptDb();
  const covered = Object.values(db.data.interrupts).filter((i) => db.entriesFor(i.number).length > 0);

  server.registerResource(
    "interrupt-overview",
    new ResourceTemplate(`${SCHEME}interrupt/{int}`, {
      list: () => ({
        resources: covered.map((i) => ({
          uri: `${SCHEME}interrupt/${i.number}`,
          name: `int-${i.number}`,
          title: `INT ${i.number}h - ${i.name}`,
          description: `Every documented function of INT ${i.number}h, grouped by AH, with links to full entries.`,
          mimeType: "text/markdown",
        })),
      }),
    }),
    {
      title: "Interrupt function index",
      description: "All documented functions of one interrupt (BIOS/DOS/mouse/EMS), one line each, with links to deeper detail.",
      mimeType: "text/markdown",
      cacheHint: STATIC_HINT,
    },
    (uri, v) => {
      const int = intKey(one(v, "int"));
      if (!db.info(int) || db.entriesFor(int).length === 0) throw new Error(`INT ${int}h is not covered by the bundled references`);
      return markdown(uri, renderInterruptOverview(db, int));
    },
  );

  server.registerResource(
    "interrupt-function",
    new ResourceTemplate(`${SCHEME}function/{int}/{ah}`, { list: undefined }),
    {
      title: "All variants of one interrupt function (AH)",
      description: "Every documented variant of INT <int> with the given AH, including vendor-specific and undocumented ones.",
      mimeType: "text/markdown",
      cacheHint: STATIC_HINT,
    },
    (uri, v) => markdown(uri, renderFunctionFamily(db, intKey(one(v, "int")), ahKey(one(v, "ah")))),
  );

  server.registerResource(
    "interrupt-entry",
    new ResourceTemplate(`${SCHEME}entry/{id}`, { list: undefined }),
    {
      title: "Complete interrupt-list entry",
      description: "One interrupt entry in full: registers in/out, description, every note and referenced table.",
      mimeType: "text/markdown",
      cacheHint: STATIC_HINT,
    },
    (uri, v) => {
      const entry = db.byId.get(one(v, "id"));
      if (!entry) throw new Error(`No interrupt entry "${one(v, "id")}". Ids look like 213D or 330000; take them from tool results.`);
      return markdown(uri, renderEntry(entry));
    },
  );

  server.registerResource(
    "interrupt-notes",
    new ResourceTemplate(`${SCHEME}notes/{source}/{int}/{fn}`, { list: undefined }),
    {
      title: "Prose walkthrough for an interrupt function (walkthrough or assembler reference)",
      description: "source is `walkthrough` (concise, with bit diagrams) or `reference` (assembler reference: spec plus usage notes).",
      mimeType: "text/markdown",
      cacheHint: STATIC_HINT,
    },
    (uri, v) => {
      const int = intKey(one(v, "int"));
      const fn = one(v, "fn");
      const key = fn.split("-").map((part) => hexKey(ahKey(part))).join(":");
      const sup = db.supplement(`${int}:${key}`);
      const source = one(v, "source");
      if (source === "walkthrough" && sup?.walkthrough) return markdown(uri, `\`\`\`\n${sup.walkthrough}\n\`\`\``);
      if (source === "reference" && sup?.reference.length) return markdown(uri, renderTopics(sup.reference));
      throw new Error(`No ${source} notes for INT ${int}h function ${key.replace(":", " AL=")} (sources: walkthrough, reference)`);
    },
  );

  server.registerResource(
    "memory-map",
    new ResourceTemplate(`${SCHEME}memory/{region}`, {
      list: () => ({
        resources: MEMORY_DOC_IDS.map((id) => ({
          uri: `${SCHEME}memory/${id}`,
          name: `memory-${id}`,
          title: renderMemoryDoc(id)?.split("\n")[0]?.replace(/^# /, "") ?? id,
          mimeType: "text/markdown",
        })),
      }),
    }),
    {
      title: "MS-DOS memory map region or table",
      description: "Detail for a memory region (ivt, bda, ega-vga-graphics, cga-text-graphics, ...) or a table: bda (field list), psp (Program Segment Prefix), video-modes.",
      mimeType: "text/markdown",
      cacheHint: STATIC_HINT,
    },
    (uri, v) => {
      const text = renderMemoryDoc(one(v, "region"));
      if (!text) throw new Error(`Unknown memory document "${one(v, "region")}". Known: ${MEMORY_DOC_IDS.join(", ")}`);
      return markdown(uri, text);
    },
  );

  server.registerResource(
    "port-reference",
    new ResourceTemplate(`${SCHEME}port/{group}`, {
      list: () => ({
        resources: PORT_DOC_IDS.map((id) => ({
          uri: `${SCHEME}port/${id}`,
          name: `port-${id}`,
          title: renderPortDoc(id)?.split("\n")[0]?.replace(/^# /, "") ?? id,
          mimeType: "text/markdown",
        })),
      }),
    }),
    {
      title: "I/O port register family",
      description: "Full register tables for a hardware family: vga-sequencer, vga-graphics-controller, vga-crtc, vga-attribute, vga-dac, vga-external, cga-mda, tandy-pcjr-video, sn76496 (Tandy/PCjr sound), pit-speaker, pic, keyboard, game-port, cmos, adlib, or table (every port in the bundled table).",
      mimeType: "text/markdown",
      cacheHint: STATIC_HINT,
    },
    (uri, v) => {
      const text = renderPortDoc(one(v, "group"));
      if (!text) throw new Error(`Unknown port document "${one(v, "group")}". Known: ${PORT_DOC_IDS.join(", ")}`);
      return markdown(uri, text);
    },
  );

  const nodeId = (v: Variables) => decoded(one(v, "id"));

  server.registerResource(
    "disassembly-module",
    new ResourceTemplate(`${uris.base}module/{id}`, { list: undefined }),
    {
      title: "Module summary: listing, callers, callees, entrypoint traces",
      description: "What the `module` tool returns for this node. Callers and callees in tool results link here, so you can walk the call graph one hop at a time.",
      mimeType: "text/markdown",
      cacheHint: { ttlMs: 60_000, cacheScope: "private" },
    },
    (uri, v) => {
      const result = lookupModule(graphContext(), { module: nodeId(v) });
      if (!result.ok) throw new Error(result.error);
      return markdown(uri, renderModuleText(result.output));
    },
  );

  server.registerResource(
    "disassembly-neighbors",
    new ResourceTemplate(`${uris.base}neighbors/{id}`, { list: undefined }),
    {
      title: "All callers and callees with call sites and branch conditions",
      description: "The complete caller and callee lists (the module tool shows the first few), each with the call instruction, its offset and the conditions guarding it.",
      mimeType: "text/markdown",
      cacheHint: { ttlMs: 60_000, cacheScope: "private" },
    },
    (uri, v) => {
      const text = renderNeighbors(graphContext(), nodeId(v));
      if (!text) throw new Error(`No graph node "${nodeId(v)}"`);
      return markdown(uri, text);
    },
  );

  server.registerResource(
    "disassembly-listing",
    new ResourceTemplate(`${uris.base}listing/{id}`, { list: undefined }),
    {
      title: "A function's assembly listing",
      description: "Exactly this function's instructions, decoded from the binary by following its control flow. Calls and jumps to other functions end in `; → <node>`: pass that name to the module tool. For part of a long listing append a line range to the id: `:50-80`, `:50+30`, `:-20` (last 20 lines).",
      mimeType: "text/plain",
      cacheHint: { ttlMs: 5 * 60_000, cacheScope: "private" },
    },
    (uri, v) => {
      const ctx = graphContext();
      const id = nodeId(v);
      // "MAIN_OVR-0041:0a5c:50-80": the node id itself contains a colon, so a selector is only split off when the id
      // as a whole names no node and the part before its last colon does
      let node = ctx.graph.nodes.get(id);
      let selector: string | undefined;
      const cut = id.lastIndexOf(":");
      if (!node && cut > 0 && ctx.graph.nodes.has(id.slice(0, cut))) {
        node = ctx.graph.nodes.get(id.slice(0, cut));
        selector = id.slice(cut + 1);
      }
      if (!node) throw new Error(`No graph node "${id}"`);
      const file = listingFor(ctx.disassemblyRoot, node);
      if (!file) throw new Error(node.kind === "function" ? `${node.id} has no listing on disk.` : `${node.id} is not a function (kind: ${node.kind}), so it has no listing.`);
      const raw = readFileSync(file.absPath, "utf8");
      if (selector === undefined) return { contents: [{ uri: uri.href, mimeType: "text/plain", text: annotateCallTargets(ctx.graph, node, raw) }] };
      const lines = raw.replace(/\n$/, "").split("\n");
      const sel = selectLines(selector, lines.length);
      if (!sel.ok) throw new Error(`${node.id}: ${sel.error}. The whole listing is ${uris.listing(node.id)}`);
      const head = `; ${node.id}, lines ${sel.first}-${sel.last} of ${sel.total}${sel.clipped ? " (the listing ends there)" : ""}`;
      const text = `${head}\n${annotateCallTargets(ctx.graph, node, lines.slice(sel.first - 1, sel.last).join("\n"))}`;
      return { contents: [{ uri: uri.href, mimeType: "text/plain", text }] };
    },
  );

  server.registerResource(
    "disassembly-trace",
    new ResourceTemplate(`${uris.base}trace/{handle}`, { list: undefined }),
    {
      title: "Cached call traces",
      description: "Full traces behind a `module` or `trace` result, with every call site and branch condition. Handles live about an hour (renewed on each read); repeat the tool call after that.",
      mimeType: "text/markdown",
      cacheHint: { ttlMs: 5 * 60_000, cacheScope: "private" },
    },
    (uri, v) => {
      const doc = queryCache.get(one(v, "handle"));
      if (!doc) throw new Error("This trace handle has expired or never existed. Repeat the original module/trace call to get a fresh one.");
      return markdown(uri, doc.text);
    },
  );

  server.registerResource(
    "disassembly-data-references",
    new ResourceTemplate(`${uris.base}data-references/{address}`, { list: undefined }),
    {
      title: "Every instruction that names a data address",
      description: "What the `data_references` tool returns for this address (ds:4f2a, 0714h:0124, MAIN_OVR-0020:000f; URL-encoded), with every instruction listed instead of the first few.",
      mimeType: "text/markdown",
      cacheHint: { ttlMs: 5 * 60_000, cacheScope: "private" },
    },
    (uri, v) => {
      const result = lookupDataReferences(graphContext(), { address: decoded(one(v, "address")) }, true);
      if (!result.ok) throw new Error(result.error);
      return markdown(uri, renderDataReferencesText(result.output));
    },
  );

  /** Changes with every add_implementation: clients may reuse it only briefly. */
  const WORK_HINT = { ttlMs: 30_000, cacheScope: "private" } as const;

  server.registerResource(
    "work-plan",
    uris.workPlan,
    {
      title: "Work plan: what to implement next, ranked",
      description: `The ranked queue of incomplete work units (top ${WORK_PLAN_ROWS}), best first, with size, readiness and how many others each unblocks. next_work returns the top one in detail.`,
      mimeType: "text/markdown",
      cacheHint: WORK_HINT,
    },
    (uri) => markdown(uri, renderWorkPlan(graphContext())),
  );

  server.registerResource(
    "work-unit",
    new ResourceTemplate(`${uris.base}work-unit/{id}`, { list: undefined }),
    {
      title: "One work unit in full",
      description: "Every member (callees first, with listing links), every work unit it calls and that calls it, and how to record it. id is a work unit id such as work:MAIN_OVR-0020:33a0, URL-encoded.",
      mimeType: "text/markdown",
      cacheHint: WORK_HINT,
    },
    (uri, v) => markdown(uri, renderWorkUnit(graphContext(), nodeId(v))),
  );

  server.registerResource(
    "query-result",
    new ResourceTemplate(`${SCHEME}query/{handle}`, { list: undefined }),
    {
      title: "Cached query result (ranked candidates)",
      description: "Result set from an earlier `interrupts` call. Handles live ~10 minutes (renewed on each read), then must be regenerated by repeating the tool call.",
      mimeType: "text/markdown",
      cacheHint: QUERY_HINT,
    },
    (uri, v) => {
      const doc = queryCache.get(one(v, "handle"));
      if (!doc) {
        throw new Error("This query handle has expired or never existed. Repeat the original tool call to get a fresh one.");
      }
      return markdown(uri, doc.text);
    },
  );
}

/** A template variable as sent; ids are URL-encoded by convention, but a malformed encoding is taken literally. */
function decoded(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** Compare mode only (--compare): the full side by side of two functions and the map of every function's counterpart. */
export function registerCompareResources(server: McpServer, names: readonly [string, string], correspondence: () => Correspondence): void {
  const [a, b] = names;
  const uris = compareUris(a, b);
  /** fixed for the life of the two trees */
  const COMPARE_HINT = { ttlMs: 10 * 60_000, cacheScope: "private" } as const;

  server.registerResource(
    "compare-pair",
    new ResourceTemplate(`${uris.base}pair/{a}/{b}`, { list: undefined }),
    {
      title: `Two functions side by side (${a} vs ${b})`,
      description: `Every instruction of a ${a} function aligned with a ${b} function (ids URL-encoded), with the verdict and callee correspondence. The counterpart and compare tools show the changed stretches and link here for the rest.`,
      mimeType: "text/markdown",
      cacheHint: COMPARE_HINT,
    },
    (uri, v) => {
      const c = correspondence();
      const [ida, idb] = [decoded(one(v, "a")), decoded(one(v, "b"))];
      for (const [w, id] of [["a", ida], ["b", idb]] as const) if (!c.has(w, id)) throw new Error(`${c[w].name} has no function "${id}" with a listing. Take ids from counterpart/compare results.`);
      return markdown(uri, renderPairFull(c, ida, idb));
    },
  );

  server.registerResource(
    "compare-map",
    new ResourceTemplate(`${uris.base}map/{filter}/{page}`, {
      list: () => ({
        resources: MAP_FILTERS.map((f) => ({
          uri: uris.map(f, 1),
          name: `compare-map-${f}`,
          title: `${a} ↔ ${b}: ${f} functions`,
          mimeType: "text/markdown",
        })),
      }),
    }),
    {
      title: `Every function's counterpart (${a} ↔ ${b})`,
      description: `${MAP_FILTERS.join(" | ")} functions of both games, ${MAP_PAGE_ROWS} per page: each ${a} function with its ${b} counterpart, whether the code is identical or how much lines up, and how sure the pairing is. "changed" is where the games differ; "unmatched" lists functions with no counterpart.`,
      mimeType: "text/markdown",
      cacheHint: COMPARE_HINT,
    },
    (uri, v) => {
      const filter = one(v, "filter");
      if (!(MAP_FILTERS as readonly string[]).includes(filter)) throw new Error(`Unknown filter "${filter}". Filters: ${MAP_FILTERS.join(", ")}.`);
      const raw = one(v, "page");
      const page = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
      return markdown(uri, renderMap(correspondence(), filter as MapFilter, page));
    },
  );
}
