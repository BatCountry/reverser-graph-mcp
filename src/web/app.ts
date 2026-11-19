// Progress dashboard for reverser-progress-graph. TypeScript compiled by the normal build (npm run build) into
// build/web/app.js; no dependencies: plain DOM over the JSON API in src/dashboard/api.ts and src/dashboard/compare.ts.
// Every string from the graph or progress.json goes in as text, never as markup.

import type { CompareSummary, CounterpartView, PairRow, PairView } from "../dashboard/compare.js";
import type { FunctionStatus, ModuleDetail, ModuleRow, Neighbour, Summary, UnitRow } from "../dashboard/api.js";
import type { Confidence, MapRow } from "../compare/render.js";
import type { ListingLine } from "../graph/listing-targets.js";
import { formatAddress } from "../hex.js";
import { percentDown } from "../percent.js";

const app = document.getElementById("app")!;
const live = document.getElementById("live")!;
const foot = document.getElementById("foot")!;
const POLL_MS = 4000;

/** The module list as fetched for one dashboard version. */
interface ModuleCache {
  version: string | null;
  rows: ModuleRow[];
  ids: Set<string>;
  byId: Map<string, ModuleRow>;
}

type QueueFilter = "open" | "ready" | "complete" | "all";
type MapStatus = MapRow["status"];

const state: {
  version: string | null;
  modules: ModuleCache | null;
  /** compare mode: the /api/compare/summary; null otherwise */
  compare: CompareSummary | null;
  ui: {
    modules: { q: string; status: "all" | FunctionStatus; space: string; sort: string; asc: boolean };
    queue: { show: QueueFilter };
    compare: { q: string; status: "all" | MapStatus; sort: "address" | "similarity" };
    pair: { all: boolean };
  };
} = {
  version: null,
  modules: null,
  compare: null,
  ui: {
    modules: { q: "", status: "all", space: "", sort: "space", asc: true },
    queue: { show: "open" },
    compare: { q: "", status: "all", sort: "address" },
    pair: { all: false },
  },
};

// ------------------------------------------------------------------ helpers

const SVG_NS = "http://www.w3.org/2000/svg";

/** Anything `build` accepts as a child: nodes and text, with null/undefined/false skipped and arrays flattened. */
type Kid = Node | string | number | boolean | null | undefined | readonly Kid[];
type Props = Record<string, unknown>;

function append(el: Element, kid: Kid): void {
  if (kid === null || kid === undefined || kid === false) return;
  if (kid instanceof Node) el.append(kid);
  else if (Array.isArray(kid)) for (const k of kid as readonly Kid[]) append(el, k);
  else el.append(String(kid));
}

function build<T extends Element>(el: T, props: Props | null | undefined, kids: Kid[]): T {
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.setAttribute("class", String(v));
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v as EventListener);
    else if (k === "style" && typeof v === "object") Object.assign((el as unknown as HTMLElement).style, v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  append(el, kids);
  return el;
}
const h = <K extends keyof HTMLElementTagNameMap>(tag: K, props?: Props | null, ...kids: Kid[]): HTMLElementTagNameMap[K] => build(document.createElement(tag), props, kids);
const s = <K extends keyof SVGElementTagNameMap>(tag: K, props?: Props | null, ...kids: Kid[]): SVGElementTagNameMap[K] => build(document.createElementNS(SVG_NS, tag), props, kids);

const fmt = (n: number) => Number(n).toLocaleString("en-US");
const pct = (a: number, b: number) => (b > 0 ? (100 * a) / b : 0);
const pctText = (a: number, b: number) => (b > 0 ? percentDown(a / b) : "0%");
const moduleHref = (id: string) => `#/m/${encodeURIComponent(id)}`;
const modLink = (id: string, label = id) => h("a", { class: "mod", href: moduleHref(id) }, label);
const unitRoot = (unitId: string) => unitId.replace(/^work:/, "");

function ago(iso: string) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const sec = Math.max(0, (Date.now() - t) / 1000);
  if (sec < 60) return "just now";
  if (sec < 3600) return `${Math.floor(sec / 60)} min ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} h ago`;
  if (sec < 86400 * 30) return `${Math.floor(sec / 86400)} d ago`;
  return iso.slice(0, 10);
}

function bar(parts: Array<[number, number, string]>) {
  return h("div", { class: "bar" }, parts.map(([value, total, color]) => h("i", { style: { width: `${pct(value, total)}%`, background: color } })));
}

function badge(text: string, cls = text) {
  return h("span", { class: `badge ${cls}` }, text);
}

async function getJSON<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw Object.assign(new Error(body.error ?? `HTTP ${res.status}`), { status: res.status });
  return body;
}

async function modules(): Promise<ModuleCache> {
  if (state.modules && state.modules.version === state.version) return state.modules;
  const { modules: rows } = await getJSON<{ modules: ModuleRow[] }>("/api/modules");
  state.modules = { version: state.version, rows, ids: new Set(rows.map((r) => r.id)), byId: new Map(rows.map((r) => [r.id, r])) };
  return state.modules;
}

// ------------------------------------------------------------------ overview

function rings(fnDone: number, fnTotal: number, lnDone: number, lnTotal: number) {
  const ring = (r: number, w: number, p: number, color: string) => {
    const c = 2 * Math.PI * r;
    const arc = s("circle", { class: "arc", cx: 130, cy: 130, r, "stroke-width": w, stroke: color, "stroke-dasharray": c, "stroke-dashoffset": c });
    requestAnimationFrame(() => requestAnimationFrame(() => arc.setAttribute("stroke-dashoffset", String(c * (1 - p / 100)))));
    return [s("circle", { class: "track", cx: 130, cy: 130, r, "stroke-width": w }), arc];
  };
  return h(
    "div",
    { class: "rings" },
    s(
      "svg",
      { viewBox: "0 0 260 260" },
      s("defs", {}, s("linearGradient", { id: "g1", x1: 0, y1: 0, x2: 1, y2: 1 }, s("stop", { offset: "0", "stop-color": "#34d399" }), s("stop", { offset: "1", "stop-color": "#55ffff" }))),
      ring(116, 16, pct(fnDone, fnTotal), "url(#g1)"),
      ring(90, 10, pct(lnDone, lnTotal), "#ff55ff"),
    ),
    h("div", { class: "center" }, h("div", { class: "pct" }, pctText(fnDone, fnTotal)), h("div", { class: "sub" }, "functions done")),
  );
}

function stat(label: string, value: number, total: number | undefined, accent: string, extra?: string) {
  return h(
    "div",
    { class: "stat", style: { "--accent": accent } },
    h("div", { class: "k" }, label),
    h("div", { class: "v" }, fmt(value), total === undefined ? null : h("small", {}, ` / ${fmt(total)}`)),
    total === undefined ? null : h("div", { class: "bar" }, h("i", { style: { width: `${pct(value, total)}%`, background: accent } })),
    extra ? h("div", { class: "k", style: { marginTop: "6px" } }, extra) : null,
  );
}

function burnup(timeline: Summary["timeline"], total: number) {
  if (timeline.length === 0) return h("div", { class: "empty" }, "No implementations recorded yet. Every add_implementation call lands here.");
  const day = 86400000;
  const pts = timeline.map((p) => ({ t: Date.parse(`${p.date}T00:00:00Z`), v: p.implemented }));
  pts.unshift({ t: pts[0].t - day, v: 0 });
  const today = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
  if (pts[pts.length - 1].t < today) pts.push({ t: today, v: pts[pts.length - 1].v });
  const W = 800, H = 200, L = 40, B = 22;
  const t0 = pts[0].t, t1 = Math.max(pts[pts.length - 1].t, t0 + day);
  const vmax = Math.max(4, Math.ceil(pts[pts.length - 1].v * 1.2));
  const x = (t: number) => L + ((t - t0) / (t1 - t0)) * (W - L - 8);
  const y = (v: number) => H - B - (v / vmax) * (H - B - 10);
  // step line: progress happens on the day it was recorded
  let d = `M${x(pts[0].t)},${y(pts[0].v)}`;
  for (let i = 1; i < pts.length; i++) d += ` H${x(pts[i].t)} V${y(pts[i].v)}`;
  const area = `${d} V${y(0)} H${x(pts[0].t)} Z`;
  const last = pts[pts.length - 1];
  return h(
    "div",
    { class: "chart" },
    s(
      "svg",
      { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none" },
      s("defs", {}, s("linearGradient", { id: "ga", x1: 0, y1: 0, x2: 0, y2: 1 }, s("stop", { offset: "0", "stop-color": "#55ffff", "stop-opacity": "0.35" }), s("stop", { offset: "1", "stop-color": "#55ffff", "stop-opacity": "0" }))),
      [0, 0.5, 1].map((f) => s("line", { class: "axis", x1: L, x2: W - 8, y1: y(vmax * f), y2: y(vmax * f), "stroke-dasharray": f ? "3 5" : null })),
      [0, 0.5, 1].map((f) => s("text", { x: L - 8, y: y(vmax * f) + 4, "text-anchor": "end" }, fmt(Math.round(vmax * f)))),
      s("path", { d: area, fill: "url(#ga)" }),
      s("path", { d, fill: "none", stroke: "#55ffff", "stroke-width": 2, "vector-effect": "non-scaling-stroke" }),
      s("circle", { class: "dot", cx: x(last.t), cy: y(last.v), r: 4 }),
      s("text", { x: L, y: H - 4 }, new Date(t0).toISOString().slice(0, 10)),
      s("text", { x: W - 8, y: H - 4, "text-anchor": "end" }, new Date(t1).toISOString().slice(0, 10)),
    ),
    h("div", { class: "legend", style: { justifyContent: "flex-start", marginTop: "6px" } }, `${fmt(last.v)} of ${fmt(total)} functions implemented`),
  );
}

function unitLine(u: UnitRow) {
  return h(
    "a",
    { class: "row", href: moduleHref(u.root) },
    h("span", { class: "rank" }, u.rank ?? "✓"),
    h("span", { class: "id" }, u.id),
    h(
      "span",
      { class: "meta" },
      `${fmt(u.lines)} lines · ${u.implemented}/${u.members} fn · unblocks ${u.unblocks} `,
      badge(u.state),
      u.oversized ? [" ", badge("oversized", "warn")] : null,
      u.indirect ? [" ", badge("indirect", "info")] : null,
    ),
  );
}

function spaceMap(rows: ModuleRow[], spaces: Summary["spaces"]) {
  const bySpace = new Map<string, ModuleRow[]>();
  for (const r of rows) {
    const k = r.space ?? "(no space)";
    if (!bySpace.has(k)) bySpace.set(k, []);
    bySpace.get(k)!.push(r);
  }
  return h(
    "div",
    { class: "spaces" },
    spaces.map((sp) =>
      h(
        "section",
        { class: "space" },
        h("header", {}, h("b", {}, sp.space), h("span", {}, `${sp.implemented}/${sp.functions} · ${fmt(sp.lines)} ln`)),
        bar([[sp.implementedLines, sp.lines, "var(--done)"]]),
        h(
          "div",
          { class: "cells" },
          (bySpace.get(sp.space) ?? []).map((r) =>
            h("a", { class: `cell ${r.status}${r.lines >= 300 ? " huge" : r.lines >= 80 ? " big" : ""}`, href: moduleHref(r.id), title: `${r.id} · ${r.lines} lines · ${r.status}${r.sameCodeAs ? ` (same code as ${r.sameCodeAs})` : ""}` }),
          ),
        ),
      ),
    ),
  );
}

async function overview() {
  const [sum, mods] = await Promise.all([getJSON<Summary>("/api/summary"), modules()]);
  const f = sum.functions;
  const u = sum.units;
  foot.textContent = `tree ${sum.disassemblyRoot} · progress ${sum.progressFile}`;
  return h(
    "div",
    { class: "grid overview" },
    h(
      "section",
      { class: "card hero" },
      sum.gameName ? h("h1", { class: "game-name" }, sum.gameName) : null,
      rings(f.implemented, f.total, f.implementedLines, f.lines),
      h(
        "div",
        { class: "legend" },
        h("span", {}, h("i", { class: "swatch", style: { background: "linear-gradient(90deg,#34d399,#55ffff)" } }), `functions ${pctText(f.implemented, f.total)}`),
        h("span", {}, h("i", { class: "swatch", style: { background: "#ff55ff" } }), `listing lines ${pctText(f.implementedLines, f.lines)}`),
      ),
    ),
    h(
      "section",
      { class: "card" },
      h("h2", {}, "Progress", h("span", { class: "aside" }, `${fmt(f.total - f.implemented)} functions to go`)),
      h(
        "div",
        { class: "stats" },
        stat("Functions implemented", f.implemented, f.total, "var(--done)", f.bySameCode ? `${fmt(f.bySameCode)} through same code elsewhere` : undefined),
        stat("Listing lines covered", f.implementedLines, f.lines, "var(--magenta)"),
        stat("Work units complete", u.complete, u.total, "var(--cyan)"),
        stat("Ready to start now", u.ready, undefined, "var(--ready)", `${fmt(u.waiting)} waiting on callees`),
        stat("Partly done units", u.partial, undefined, "var(--magenta)", `${fmt(u.oversized)} oversized · ${fmt(u.indirect)} with indirect calls`),
        stat("Annotations", sum.annotations, undefined, "#8ab4ff", "notes recorded with annotate"),
      ),
    ),
    h(
      "div",
      { class: "wide split" },
      h("section", { class: "card" }, h("h2", {}, "Burn-up"), burnup(sum.timeline, f.total)),
      h(
        "section",
        { class: "card" },
        h("h2", {}, "Next up", h("a", { class: "aside", href: "#/queue" }, "full queue →")),
        sum.next.length ? h("div", { class: "list" }, sum.next.map(unitLine)) : h("div", { class: "empty" }, "Nothing left. Every work unit is complete."),
      ),
    ),
    h(
      "section",
      { class: "card wide" },
      h(
        "h2",
        {},
        "Map",
        h(
          "span",
          { class: "aside legend" },
          h("span", {}, h("i", { class: "swatch", style: { background: "var(--done)" } }), "implemented"),
          h("span", {}, h("i", { class: "swatch", style: { background: "var(--ready)" } }), "ready"),
          h("span", {}, h("i", { class: "swatch", style: { background: "var(--wait)" } }), "waiting"),
          h("span", {}, "bigger square = longer listing"),
        ),
      ),
      spaceMap(mods.rows, sum.spaces),
    ),
    h(
      "section",
      { class: "card wide" },
      h("h2", {}, "Recent activity"),
      sum.recent.length
        ? h(
            "div",
            { class: "list feed" },
            sum.recent.map((a) =>
              h(
                "a",
                { class: "row", href: moduleHref(a.module) },
                h("span", { style: { color: a.kind === "implementation" ? "var(--done)" : "var(--magenta)" } }, a.kind === "implementation" ? "✓" : "✎"),
                h("span", { class: "id" }, h("span", { class: "mod" }, a.module), "  ", h("span", { class: "what" }, a.detail)),
                h("span", { class: "meta", title: a.at }, ago(a.at)),
              ),
            ),
          )
        : h("div", { class: "empty" }, "No progress recorded yet."),
    ),
  );
}

// ------------------------------------------------------------------ modules table

interface Column {
  key: string;
  label: string;
  num?: boolean;
  get: (r: ModuleRow) => string | number;
}

const MODULE_COLUMNS: Column[] = [
  { key: "id", label: "Module", get: (r) => r.id },
  { key: "space", label: "Space", get: (r) => `${r.space ?? ""}:${String(r.address ?? 0).padStart(6, "0")}` },
  { key: "status", label: "Status", get: (r) => ({ implemented: 0, ready: 1, waiting: 2 })[r.status] },
  { key: "lines", label: "Lines", num: true, get: (r) => r.lines },
  { key: "callers", label: "Callers", num: true, get: (r) => r.callers },
  { key: "callees", label: "Callees", num: true, get: (r) => r.callees },
  { key: "unit", label: "Work unit", get: (r) => r.unit ?? "" },
  { key: "annotations", label: "Notes", num: true, get: (r) => r.annotations },
];

async function modulesView() {
  const mods = await modules();
  const ui = state.ui.modules;
  const spaces = [...new Set(mods.rows.map((r) => r.space ?? ""))].sort();
  const counts: Record<"all" | FunctionStatus, number> = { all: mods.rows.length, implemented: 0, ready: 0, waiting: 0 };
  for (const r of mods.rows) counts[r.status]++;

  const tbody = h("tbody");
  const count = h("span", { class: "count" });
  const fill = () => {
    const q = ui.q.trim().toLowerCase();
    const col = MODULE_COLUMNS.find((c) => c.key === ui.sort) ?? MODULE_COLUMNS[1];
    const rows = mods.rows
      .filter((r) => (ui.status === "all" || r.status === ui.status) && (!ui.space || r.space === ui.space) && (!q || r.id.toLowerCase().includes(q) || (r.unit ?? "").toLowerCase().includes(q)))
      .sort((a, b) => {
        const x = col.get(a), y = col.get(b);
        return (x < y ? -1 : x > y ? 1 : 0) * (ui.asc ? 1 : -1);
      });
    count.textContent = `${fmt(rows.length)} of ${fmt(mods.rows.length)}`;
    tbody.replaceChildren(
      ...rows.map((r) =>
        h(
          "tr",
          { onclick: (e: Event) => { if (!(e.target instanceof HTMLAnchorElement)) location.hash = moduleHref(r.id); } },
          h("td", {}, modLink(r.id)),
          h("td", { class: "mono" }, r.space ?? "", h("span", { style: { color: "var(--faint)" } }, ` ${formatAddress(r.address)}`)),
          h("td", {}, badge(r.status), r.sameCodeAs ? h("span", { class: "mono", style: { color: "var(--dim)", marginLeft: "6px" }, title: "implemented through this function's record: same code" }, `= ${r.sameCodeAs}`) : null),
          h("td", { class: "num" }, fmt(r.lines)),
          h("td", { class: "num" }, r.callers),
          h("td", { class: "num" }, r.callees),
          h("td", { class: "mono", style: { color: "var(--dim)" } }, r.unit && unitRoot(r.unit) !== r.id ? r.unit : r.unit ? "root" : ""),
          h("td", { class: "num" }, r.annotations || ""),
        ),
      ),
    );
  };
  const head = h(
    "tr",
    {},
    MODULE_COLUMNS.map((c) =>
      h(
        "th",
        {
          class: `${c.num ? "num " : ""}${ui.sort === c.key ? `sorted${ui.asc ? " asc" : ""}` : ""}`,
          onclick: () => {
            ui.asc = ui.sort === c.key ? !ui.asc : !c.num;
            ui.sort = c.key;
            render();
          },
        },
        c.label,
      ),
    ),
  );
  let timer: number | undefined;
  const view = h(
    "section",
    { class: "card" },
    h(
      "div",
      { class: "toolbar" },
      h("input", { type: "search", placeholder: "Filter by module or work unit…", value: ui.q, spellcheck: "false", oninput: (e: Event) => { ui.q = (e.target as HTMLInputElement).value; clearTimeout(timer); timer = window.setTimeout(fill, 80); } }),
      h(
        "div",
        { class: "chips" },
        (["all", "implemented", "ready", "waiting"] as const).map((k) =>
          h("button", { class: `chip${ui.status === k ? " on" : ""}`, type: "button", onclick: () => { ui.status = k; render(); } }, k, h("span", { class: "n" }, fmt(counts[k]))),
        ),
      ),
      h(
        "select",
        { onchange: (e: Event) => { ui.space = (e.target as HTMLSelectElement).value; fill(); } },
        h("option", { value: "" }, `all spaces (${spaces.length})`),
        spaces.map((sp) => h("option", { value: sp, selected: sp === ui.space }, sp)),
      ),
      count,
    ),
    h("table", {}, h("thead", {}, head), tbody),
  );
  fill();
  return view;
}

// ------------------------------------------------------------------ work queue

async function queueView() {
  const { units } = await getJSON<{ units: UnitRow[] }>("/api/units");
  const ui = state.ui.queue;
  const filters: Record<QueueFilter, (u: UnitRow) => boolean> = { open: (u) => u.state !== "complete", ready: (u) => u.state === "ready", complete: (u) => u.state === "complete", all: () => true };
  const shown = units.filter(filters[ui.show]);
  return h(
    "section",
    { class: "card" },
    h(
      "div",
      { class: "toolbar" },
      h(
        "div",
        { class: "chips" },
        (Object.keys(filters) as QueueFilter[]).map((k) =>
          h("button", { class: `chip${ui.show === k ? " on" : ""}`, type: "button", onclick: () => { ui.show = k; render(); } }, k, h("span", { class: "n" }, fmt(units.filter(filters[k]).length))),
        ),
      ),
      h("span", { class: "count" }, "ranked the way next_work picks: ready first, then most unblocked"),
    ),
    h(
      "table",
      {},
      h("thead", {}, h("tr", {}, ["#", "Work unit", "Progress", "Lines", "State", "Unblocks", "Depends on", ""].map((t, i) => h("th", { class: [0, 3, 5, 6].includes(i) ? "num" : "" }, t)))),
      h(
        "tbody",
        {},
        shown.map((u) =>
          h(
            "tr",
            { onclick: () => { location.hash = moduleHref(u.root); } },
            h("td", { class: "num" }, u.rank ?? "✓"),
            h("td", {}, h("a", { class: "mod", href: moduleHref(u.root) }, u.id)),
            h("td", {}, h("span", { class: "mini" }, bar([[u.implemented, u.members, "var(--done)"]])), h("span", { class: "mono", style: { color: "var(--dim)", marginLeft: "8px" } }, `${u.implemented}/${u.members}`)),
            h("td", { class: "num" }, fmt(u.lines)),
            h("td", {}, badge(u.state)),
            h("td", { class: "num" }, u.unblocks),
            h("td", { class: "num" }, u.dependsOn),
            h("td", {}, u.oversized ? badge("oversized", "warn") : null, " ", u.indirect ? badge(`${u.indirect} indirect`, "info") : null),
          ),
        ),
      ),
    ),
  );
}

// ------------------------------------------------------------------ module detail

const TRANSFER_CLASS: Record<NonNullable<ListingLine["transfer"]>, string> = { call: " call", jmp: " jump", jcc: " jump", loop: " jump", ret: " ret" };

const nodeLink = (id: string) => h("a", { class: "t", href: moduleHref(id) }, id);

/** One listing line as the server annotated it: comments with the nodes they name as links, code in columns, notes. */
function asmLine(l: ListingLine) {
  const notes = l.notes.map((n) => [
    "  ",
    h("span", { class: "c" }, `; ${n.label} `),
    n.targets.map((t, i) => [i ? ", " : "", t === null ? h("span", { class: "t ind" }, n.unknown) : nodeLink(t)]),
    n.more ? h("span", { class: "c" }, `, … (+${n.more} more: see Callees)`) : null,
  ]);
  const cls = `l${l.notes.length ? " xfer" : ""}`;
  if (!l.code) return h("span", { class: cls }, h("span", { class: "c" }, (l.parts ?? [l.text]).map((p) => (typeof p === "string" ? p : nodeLink(p.node)))), notes);
  const space = l.code.code.indexOf(" ");
  const [mnemonic, operands] = space < 0 ? [l.code.code, ""] : [l.code.code.slice(0, space), l.code.code.slice(space)];
  return h(
    "span",
    { class: cls },
    h("span", { class: "a" }, formatAddress(l.code.addr).slice(2)),
    "  ",
    // the generator pads the bytes column to 12; a batch-file line has none
    h("span", { class: "b" }, l.code.bytes.padEnd(12)),
    "  ",
    h("span", { class: `m${l.transfer ? TRANSFER_CLASS[l.transfer] : ""}` }, mnemonic),
    h("span", { class: "o" }, operands),
    notes,
  );
}

function neighbourList(list: Neighbour[], title: string) {
  return h(
    "section",
    { class: "card" },
    h("h2", {}, title, h("span", { class: "aside" }, `${list.length}`)),
    list.length
      ? h(
          "div",
          { class: "nb" },
          list.map((n) =>
            h(
              "details",
              {},
              h(
                "summary",
                {},
                h("span", { class: `dotst ${n.status ?? "other"}`, title: n.sameCodeAs ? `implemented: same code as ${n.sameCodeAs}` : n.status ?? n.kind }),
                n.kind === "function" ? modLink(n.id) : h("span", { class: "mono", style: { color: "var(--magenta)" }, title: n.reason ?? "" }, n.kind === "unknown-target" ? "unresolved (indirect)" : `${n.id} (${n.kind})`),
                h("span", { class: "n" }, `${n.sites.length} site${n.sites.length === 1 ? "" : "s"}`),
              ),
              h(
                "div",
                { class: "sites" },
                n.reason ? h("div", { class: "cond" }, n.reason) : null,
                n.sites.map((st) =>
                  h("div", {}, st.text, st.conditions.length ? h("div", { class: "cond" }, `  when ${st.conditions.join("; ")}`) : null),
                ),
              ),
            ),
          ),
        )
      : h("div", { class: "empty" }, "None in the call graph."),
  );
}

/** How the program reaches this node: the shortest call chain from each of the nearest entrypoints. */
function tracesCard(d: ModuleDetail) {
  const t = d.traces;
  const aside = t.total > t.shown.length ? `${t.total} entrypoints, nearest ${t.shown.length}` : `${t.total} entrypoint${t.total === 1 ? "" : "s"}`;
  let body: HTMLElement;
  if (t.targetIsRoot) body = h("div", { class: "empty" }, "An entrypoint itself: nothing in the call graph calls it.");
  else if (t.total === 0) {
    body = h(
      "div",
      { class: "empty" },
      d.callers.length === 0
        ? "Nothing calls it: it is reached only through dispatch the graph could not trace."
        : "No entrypoint reaches it: its callers form a loop nothing outside enters (an untraced call, vector or callback leads in).",
    );
  } else {
    body = h(
      "div",
      { class: "nb traces" },
      t.shown.map((tr, i) =>
        h(
          "details",
          { open: i === 0 },
          h("summary", {}, modLink(tr.entry), h("span", { class: "n" }, `${tr.hops.length} call${tr.hops.length === 1 ? "" : "s"}`)),
          h(
            "ol",
            { class: "sites trace" },
            tr.hops.map((hop) =>
              h(
                "li",
                {},
                `${hop.text}${hop.otherSites ? `  (+${hop.otherSites} more site${hop.otherSites === 1 ? "" : "s"})` : ""}`,
                hop.conditions.length ? h("div", { class: "cond" }, `when ${hop.conditions.join("; ")}`) : null,
                h("div", {}, "→ ", hop.to === d.id ? h("b", {}, hop.to) : modLink(hop.to)),
              ),
            ),
          ),
        ),
      ),
    );
  }
  return h("section", { class: "card" }, h("h2", {}, "Reached from", h("span", { class: "aside" }, t.targetIsRoot ? "entrypoint" : aside)), body);
}

async function moduleView(id: string) {
  const [d, cp] = await Promise.all([
    getJSON<ModuleDetail>(`/api/modules/${encodeURIComponent(id)}`),
    state.compare ? getJSON<CounterpartView>(`/api/compare/counterpart/${encodeURIComponent(state.compare.a)}/${encodeURIComponent(id)}`).catch(() => null) : null,
  ]);
  if (d.id !== id) history.replaceState(null, "", moduleHref(d.id));
  const u = d.unit;
  // unresolved run-time targets have nothing to write and belong to no work unit
  const unitCard = u && h(
    "section",
    { class: "card" },
    h("h2", {}, "Work unit", h("span", { class: "aside" }, u.rank ? `#${u.rank} in queue` : "complete")),
    h("div", { class: "detail-head" }, h("span", { class: "mono" }, u.id), badge(u.state), u.oversized ? badge("oversized", "warn") : null),
    h("div", { style: { margin: "6px 0 10px" } }, bar([[u.implemented, u.members, "var(--done)"]])),
    h("div", { class: "facts", style: { marginBottom: "4px" } }, h("span", {}, h("b", {}, `${u.implemented}/${u.members}`), " functions"), h("span", {}, h("b", {}, fmt(u.lines)), " lines"), h("span", {}, "unblocks ", h("b", {}, u.unblocks))),
    h("div", { class: "sub" }, "Members"),
    h("div", { class: "members" }, u.memberList.map((m) => h("a", { class: `member ${m.implemented ? "implemented" : u.state === "ready" ? "ready" : ""}${m.id === d.id ? " here" : ""}`, href: moduleHref(m.id), title: m.sameCodeAs ? `implemented: same code as ${m.sameCodeAs}` : "" }, m.id, h("small", {}, m.lines)))),
    u.dependsOnList.length ? [h("div", { class: "sub" }, `Calls into (${u.dependsOnList.length})`), h("div", { class: "members" }, u.dependsOnList.map((x) => h("a", { class: `member ${x.state}`, href: moduleHref(unitRoot(x.id)) }, x.id)))] : null,
    u.dependents.length ? [h("div", { class: "sub" }, `Called from (${u.dependents.length})`), h("div", { class: "members" }, u.dependents.map((x) => h("a", { class: `member ${x.state}`, href: moduleHref(unitRoot(x.id)) }, x.id)))] : null,
    u.indirectCalls.length ? [h("div", { class: "sub" }, "Calls through run-time addresses"), h("div", { class: "nb sites mono" }, u.indirectCalls.map((c) => h("div", {}, c)))] : null,
  );

  const records = [
    ...d.implementations.map((r) => h("article", { class: "impl" }, h("time", { title: r.recordedAt }, `implemented · ${ago(r.recordedAt)}`), h("p", {}, h("b", { class: "mono" }, r.function), " in ", h("span", { class: "mono" }, r.file)))),
    // module references are node ids: annotate resolves them when it records the note
    ...d.annotations.map((r) => h("article", {}, h("time", { title: r.recordedAt }, `${r.annotation_type} · ${ago(r.recordedAt)}`), h("p", {}, r.description), r.references.length ? h("p", { style: { color: "var(--dim)", fontSize: "12px" } }, "refs: ", r.references.map((x, i) => [i ? ", " : "", x.reference_type === "module" ? modLink(x.reference_content) : x.reference_content])) : null)),
  ];

  // header comments, then the file's lines; its last newline ends the last line and is no empty line of its own
  const lines = d.listing ? [...d.listing.header.map((text): ListingLine => ({ text, notes: [] })), ...d.listing.lines.filter((l, i, all) => l.text !== "" || i < all.length - 1)] : [];
  return h(
    "div",
    {},
    h("div", { class: "crumbs" }, h("a", { href: "#/modules" }, "Modules"), d.space ? ` / ${d.space}` : ""),
    h(
      "div",
      { class: "detail-head" },
      h("h1", {}, d.id),
      d.status ? badge(d.status) : badge(d.kind, "info"),
      d.entrypoint ? h("span", { class: "badge plain", title: "program entry, overlay entry, interrupt handler, or code reached through a pointer" }, "entry") : null,
      d.provisional ? badge("provisional", "warn") : null,
    ),
    d.note ? h("div", { class: "note" }, d.note) : null,
    d.coveredBy
      ? h("div", { class: "note" }, "Same code as ", modLink(d.coveredBy.id), ", implemented there", d.coveredBy.implementations.map((r, i) => [i ? "; " : " as ", h("b", { class: "mono" }, r.function), " in ", h("span", { class: "mono" }, r.file)]), ": nothing to write here, call that implementation.")
      : d.sameCode.length
        ? h("div", { class: "note" }, "Same code as ", d.sameCode.slice(0, 8).map((p, i) => [i ? ", " : "", modLink(p)]), d.sameCode.length > 8 ? ` and ${d.sameCode.length - 8} more` : "", d.implementations.length ? ": implemented through this function's record too." : ": implement it once and it counts for all of them.")
        : null,
    d.reason ? h("div", { class: "note" }, `Unresolved: ${d.reason}.`) : null,
    d.provisional ? h("div", { class: "note" }, "No call or jump to it is proven: it is listed because the code builds its address and it decodes as a procedure. Callers marked possible match only by record field offset.") : null,
    d.evidence.length ? h("ul", { class: "note evidence" }, d.evidence.map((l) => h("li", { class: "mono" }, l))) : null,
    h(
      "div",
      { class: "facts" },
      h("span", {}, "space ", h("b", {}, d.space ?? "—")),
      h("span", {}, "address ", h("b", {}, formatAddress(d.address))),
      h("span", {}, "file offset ", h("b", {}, formatAddress(d.fileOffset, 6))),
      h("span", {}, "in ", h("b", {}, d.sourceFile ?? "—")),
      h("span", {}, h("b", {}, fmt(d.lines)), " lines"),
      h("span", {}, h("b", {}, d.callers.length), " callers"),
      h("span", {}, h("b", {}, d.callees.length), " callees"),
    ),
    h(
      "div",
      { class: "grid detail" },
      h(
        "div",
        { class: "side" },
        cp ? counterpartCard(cp) : null,
        unitCard,
        tracesCard(d),
        h("section", { class: "card" }, h("h2", {}, "Implementation & notes"), records.length ? h("div", { class: "notes" }, records) : h("div", { class: "empty" }, "Nothing recorded yet.")),
        neighbourList(d.callers, "Callers"),
        neighbourList(d.callees, "Callees"),
      ),
      h(
        "section",
        { class: "card listing" },
        h("h2", {}, "Listing", h("span", { class: "aside" }, d.listing ? `${fmt(lines.length)} lines · ${d.listingUri}` : "")),
        d.listing ? h("pre", { class: "asm" }, lines.map(asmLine)) : h("div", { class: "empty", style: { padding: "0 20px 18px" } }, "No listing on disk for this node."),
      ),
    ),
  );
}

// ------------------------------------------------------------------ compare (only with --compare)

const pairHref = (a: string, b: string) => `#/c/${encodeURIComponent(a)}/${encodeURIComponent(b)}`;
const leadsHref = (game: string, id: string) => `#/cp/${encodeURIComponent(game)}/${encodeURIComponent(id)}`;
/** a function of game A opens its module page; one of game B its counterpart page (the dashboard tracks A) */
const gameLink = (game: string, id: string) => h("a", { class: "mod", href: game === state.compare!.a ? moduleHref(id) : leadsHref(game, id) }, id);
const STATUS_LABEL = (): Record<MapStatus, string> => ({ identical: "identical", changed: "changed", "only-a": `only in ${state.compare!.a}`, "only-b": `only in ${state.compare!.b}` });
const simText = percentDown;

function statusBadge(status: MapStatus, sameCode?: boolean) {
  if (sameCode) return badge("other callees", "ready");
  return badge(STATUS_LABEL()[status], status === "identical" ? "complete" : status === "changed" ? "ready" : "waiting");
}

function confidenceBadge(c?: Confidence) {
  return c ? badge(c, c === "weak" ? "warn" : c === "likely" ? "plain" : "info") : null;
}

/** On a module page: where this function went in the other game. */
function counterpartCard(cp: CounterpartView) {
  const { b } = state.compare!;
  return h(
    "section",
    { class: "card" },
    h("h2", {}, `Counterpart in ${b}`),
    cp.a && cp.b
      ? h("div", { class: "detail-head" }, h("a", { class: "mod", href: pairHref(cp.a, cp.b) }, cp.b), h("a", { class: "chip", href: pairHref(cp.a, cp.b) }, "side by side"))
      : h("div", {}, h("span", { class: "empty" }, "None found. "), h("a", { class: "mod", href: leadsHref(cp.game, cp.id) }, "leads")),
  );
}

/** Program pairs and unpaired programs with the reason; nothing for two trees without a programs table. */
function programsList(a: string, b: string, { pairs, unpaired }: CompareSummary["programs"]) {
  if (pairs.length === 1 && pairs[0].a === "" && pairs[0].b === "") return null;
  const name = (program: string, game: string) => `${program || "the whole tree"} (${game})`;
  return h(
    "ul",
    { class: "note" },
    pairs.map((p) => h("li", {}, `${name(p.a, a)} ↔ ${name(p.b, b)}, ${p.shared} of their ${p.union} distinct function bodies in both`)),
    [...unpaired.a.map((u) => [u, a] as const), ...unpaired.b.map((u) => [u, b] as const)].map(([u, game]) => h("li", {}, `${name(u.program, game)}: no partner, ${u.reason}`)),
  );
}

async function compareView() {
  const { rows } = await getJSON<{ rows: MapRow[] }>("/api/compare/map");
  const { a, b, counts, functions, programs } = state.compare!;
  const ui = state.ui.compare;
  const filters: Record<"all" | MapStatus, (r: MapRow) => boolean> = { all: () => true, identical: (r) => r.status === "identical", changed: (r) => r.status === "changed", "only-a": (r) => r.status === "only-a", "only-b": (r) => r.status === "only-b" };
  const tbody = h("tbody");
  const count = h("span", { class: "count" });
  const fill = () => {
    const q = ui.q.trim().toLowerCase();
    const shown = rows
      .filter((r) => filters[ui.status](r) && (!q || (r.a ?? "").toLowerCase().includes(q) || (r.b ?? "").toLowerCase().includes(q)))
      .sort((x, y) => (ui.sort === "similarity" ? (x.similarity ?? 2) - (y.similarity ?? 2) : 0));
    count.textContent = `${fmt(shown.length)} of ${fmt(rows.length)}`;
    tbody.replaceChildren(
      ...shown.map((r) => {
        const href = r.a && r.b ? pairHref(r.a, r.b) : r.a ? leadsHref(a, r.a) : leadsHref(b, r.b!);
        return h(
          "tr",
          { onclick: (e: Event) => { if (!(e.target instanceof HTMLAnchorElement)) location.hash = href; } },
          h("td", {}, r.a ? h("a", { class: "mod", href }, r.a) : ""),
          h("td", {}, r.b ? h("a", { class: "mod", href }, r.b) : ""),
          h("td", {}, statusBadge(r.status, r.sameCode)),
          h("td", {}, r.similarity === undefined ? "" : [h("span", { class: "mini" }, bar([[r.similarity, 1, r.status === "identical" ? "var(--done)" : "var(--ready)"]])), h("span", { class: "mono", style: { color: "var(--dim)", marginLeft: "8px" } }, simText(r.similarity))]),
          h("td", {}, confidenceBadge(r.confidence)),
        );
      }),
    );
  };
  let timer: number | undefined;
  const matched = counts.identical + counts.changed;
  const view = h(
    "div",
    { class: "grid" },
    h(
      "section",
      { class: "card" },
      h("h2", {}, `${a} ↔ ${b}`, h("span", { class: "aside" }, "programs paired by shared code; functions within each pair by identical code first, then through the calls of each pair")),
      h(
        "div",
        { class: "stats", style: { gridTemplateColumns: "repeat(4, 1fr)" } },
        stat("identical", counts.identical, matched, "var(--done)"),
        stat("changed", counts.changed, matched, "var(--ready)"),
        stat(`only in ${a}`, counts["only-a"], functions.a, "var(--wait)"),
        stat(`only in ${b}`, counts["only-b"], functions.b, "var(--wait)"),
      ),
      programsList(a, b, programs),
    ),
    h(
      "section",
      { class: "card" },
      h(
        "div",
        { class: "toolbar" },
        h("input", { type: "search", placeholder: `Filter by ${a} or ${b} function…`, value: ui.q, spellcheck: "false", oninput: (e: Event) => { ui.q = (e.target as HTMLInputElement).value; clearTimeout(timer); timer = window.setTimeout(fill, 80); } }),
        h(
          "div",
          { class: "chips" },
          (Object.keys(filters) as Array<"all" | MapStatus>).map((k) =>
            h("button", { class: `chip${ui.status === k ? " on" : ""}`, type: "button", onclick: () => { ui.status = k; render(); } }, k === "all" ? "all" : STATUS_LABEL()[k], h("span", { class: "n" }, fmt(rows.filter(filters[k]).length))),
          ),
        ),
        h(
          "select",
          { onchange: (e: Event) => { ui.sort = (e.target as HTMLSelectElement).value as typeof ui.sort; fill(); } },
          h("option", { value: "address", selected: ui.sort === "address" }, `${a} address order`),
          h("option", { value: "similarity", selected: ui.sort === "similarity" }, "least alike first"),
        ),
        count,
      ),
      h("table", {}, h("thead", {}, h("tr", {}, [a, b, "Status", "Lines up", "Confidence"].map((t) => h("th", {}, t)))), tbody),
    ),
  );
  fill();
  return view;
}

function pairRows(rows: PairRow[], all: boolean) {
  // changes plus 3 rows of context, unless everything was asked for
  const keep = rows.map(() => all);
  if (!all) rows.forEach((r, i) => { if (r.kind === "a" || r.kind === "b") for (let k = Math.max(0, i - 3); k <= Math.min(rows.length - 1, i + 3); k++) keep[k] = true; });
  const out: HTMLElement[] = [];
  for (let i = 0; i < rows.length; ) {
    if (keep[i]) {
      const r = rows[i++];
      out.push(
        h(
          "tr",
          { class: `k-${r.kind}` },
          h("td", { class: "ad" }, r.a ? formatAddress(r.a.addr).slice(2) : ""),
          h("td", { class: "tx" }, r.a ? r.a.text : ""),
          h("td", { class: "ad" }, r.b ? formatAddress(r.b.addr).slice(2) : ""),
          h("td", { class: "tx" }, r.b ? r.b.text : ""),
        ),
      );
      continue;
    }
    let e = i;
    while (e < rows.length && !keep[e]) e++;
    out.push(h("tr", { class: "gap" }, h("td", { colspan: 4 }, `… ${e - i} rows that line up`)));
    i = e;
  }
  return out;
}

function callPairList(p: PairView) {
  const { a, b } = state.compare!;
  if (!p.calls.length) return h("div", { class: "empty" }, "No calls to other functions.");
  return h(
    "div",
    { class: "nb" },
    p.calls.map((c) =>
      h(
        "div",
        { class: "callpair" },
        h("span", { class: `dotst ${c.state === "same" ? "implemented" : c.state === "other" ? "other" : ""}`, title: { same: "each other's counterparts", other: "matched elsewhere", open: "not matched" }[c.state] }),
        c.a ? gameLink(a, c.a) : h("span", { class: "empty" }, "—"),
        c.a && c.b ? h("a", { class: "chip", href: pairHref(c.a, c.b), title: "side by side" }, "⇄") : h("span", {}, " "),
        c.b ? gameLink(b, c.b) : h("span", { class: "empty" }, "—"),
      ),
    ),
  );
}

async function pairView(ida: string, idb: string): Promise<HTMLElement> {
  const p = await getJSON<PairView>(`/api/compare/pair/${encodeURIComponent(ida)}/${encodeURIComponent(idb)}`);
  const { a, b } = state.compare!;
  const ui = state.ui.pair;
  const changes = p.rows.filter((r) => r.kind === "a" || r.kind === "b").length;
  return h(
    "div",
    {},
    h("div", { class: "crumbs" }, h("a", { href: "#/compare" }, "Compare"), ` / ${a} ↔ ${b}`),
    h("div", { class: "detail-head" }, h("h1", {}, p.a, h("span", { style: { color: "var(--faint)" } }, " ↔ "), p.b), badge(p.identical ? "identical" : "changed", p.identical ? "complete" : "ready"), confidenceBadge(p.confidence)),
    h("div", { class: "note" }, p.verdict, p.matched ? ` Paired because ${p.how}.` : ""),
    p.matched
      ? null
      : h(
          "div",
          { class: "note" },
          "Not recorded as counterparts. ",
          p.aCounterpart ? [`${p.a}'s counterpart is `, h("a", { class: "mod", href: pairHref(p.a, p.aCounterpart) }, p.aCounterpart), ". "] : `${p.a} has none. `,
          p.bCounterpart ? [`${p.b}'s counterpart is `, h("a", { class: "mod", href: pairHref(p.bCounterpart, p.b) }, p.bCounterpart), "."] : `${p.b} has none.`,
        ),
    h(
      "div",
      { class: "grid detail" },
      h(
        "div",
        { class: "side" },
        h("section", { class: "card" }, h("h2", {}, "Calls", h("span", { class: "aside" }, `${a} ⇄ ${b}`)), callPairList(p)),
        h("section", { class: "card" }, h("h2", {}, "Open"), h("div", { class: "list" }, h("div", {}, modLink(p.a), h("span", { class: "empty" }, ` module page in ${a}`)))),
      ),
      h(
        "section",
        { class: "card listing" },
        h(
          "h2",
          {},
          "Side by side",
          h("span", { class: "aside" }, `${fmt(changes)} of ${fmt(p.rows.length)} rows on one side only · `, h("button", { class: `chip${ui.all ? " on" : ""}`, type: "button", onclick: () => { ui.all = !ui.all; render(); } }, ui.all ? "showing everything" : "changes only")),
        ),
        h("div", { class: "sbs-wrap" }, h("table", { class: "sbs" }, h("thead", {}, h("tr", {}, h("th", {}, ""), h("th", {}, a), h("th", {}, ""), h("th", {}, b))), h("tbody", {}, pairRows(p.rows, ui.all)))),
      ),
    ),
  );
}

async function counterpartPage(game: string, id: string): Promise<HTMLElement> {
  const v = await getJSON<CounterpartView>(`/api/compare/counterpart/${encodeURIComponent(game)}/${encodeURIComponent(id)}`);
  if (v.a && v.b) {
    history.replaceState(null, "", pairHref(v.a, v.b));
    return pairView(v.a, v.b);
  }
  const there = game === state.compare!.a ? state.compare!.b : state.compare!.a;
  const pairOf = (x: string, y: string) => (game === state.compare!.a ? pairHref(x, y) : pairHref(y, x));
  const lead = (title: string, items: HTMLElement[]) => h("section", { class: "card" }, h("h2", {}, title, h("span", { class: "aside" }, items.length)), items.length ? h("div", { class: "list" }, items) : h("div", { class: "empty" }, "None."));
  return h(
    "div",
    {},
    h("div", { class: "crumbs" }, h("a", { href: "#/compare" }, "Compare"), ` / ${game}`),
    h("div", { class: "detail-head" }, h("h1", {}, v.id), badge(`only in ${game}`, "waiting"), game === state.compare!.a ? modLink(v.id, "module page") : null),
    v.note ? h("div", { class: "note" }, v.note) : null,
    h("div", { class: "note" }, `No counterpart found in ${there}. These are the leads:`),
    h(
      "div",
      { class: "grid detail" },
      h(
        "div",
        { class: "side" },
        lead(`Same code in ${there}`, v.sameCode.map((x) => h("div", {}, h("a", { class: "mod", href: pairOf(v.id, x) }, x)))),
        lead("Candidates", v.candidates.map((c) => h("div", {}, h("a", { class: "mod", href: pairOf(v.id, c.id) }, c.id), h("span", { class: "empty" }, ` ${c.votes} vote${c.votes === 1 ? "" : "s"}: ${c.how}`)))),
        lead("Matched callers", v.callers.map((c) => h("div", {}, h("a", { class: "mod", href: pairOf(c.here, c.there) }, `${c.here} ⇄ ${c.there}`)))),
      ),
      h(
        "section",
        { class: "card listing" },
        h("h2", {}, "Listing", h("span", { class: "aside" }, `${fmt(v.listing.length)} instructions in ${game}`)),
        h("pre", { class: "asm" }, v.listing.map((x) => h("span", { class: "l" }, h("span", { class: "a" }, formatAddress(x.addr).slice(2)), "  ", x.text))),
      ),
    ),
  );
}

// ------------------------------------------------------------------ routing

let renderToken = 0;

/** `navigated`: a new page was opened (scroll to its top); otherwise a live refresh keeps the scroll position. */
async function render(navigated = false) {
  const token = ++renderToken;
  const hash = location.hash.replace(/^#/, "") || "/";
  const [, top = "", ...rest] = hash.split("/");
  const tabOf: Record<string, string> = { "": "overview", modules: "modules", m: "modules", queue: "queue", compare: "compare", c: "compare", cp: "compare" };
  for (const a of document.querySelectorAll<HTMLAnchorElement>(".tabs a")) a.classList.toggle("on", a.dataset.tab === tabOf[top]);
  if (!app.firstChild) app.replaceChildren(h("div", { class: "loading" }, "Loading…"));
  let view: HTMLElement;
  let title = "reverser progress graph";
  try {
    if (top === "") view = await overview();
    else if (top === "modules") view = await modulesView();
    else if (top === "queue") view = await queueView();
    else if (top === "m") {
      const id = decodeURIComponent(rest.join("/"));
      title = `${id} · ${title}`;
      view = await moduleView(id);
    } else if (top === "compare" && state.compare) view = await compareView();
    else if (top === "c" && state.compare && rest.length === 2) {
      const [a, b] = rest.map(decodeURIComponent);
      title = `${a} ↔ ${b} · ${title}`;
      view = await pairView(a, b);
    } else if (top === "cp" && state.compare && rest.length === 2) {
      const [game, id] = rest.map(decodeURIComponent);
      title = `${id} (${game}) · ${title}`;
      view = await counterpartPage(game, id);
    } else view = h("div", { class: "error" }, `Unknown page "${hash}".`);
  } catch (error) {
    view = h("div", { class: "error" }, error instanceof Error ? error.message : String(error));
  }
  if (token !== renderToken) return;
  app.replaceChildren(view);
  if (navigated) window.scrollTo(0, 0);
  document.title = title;
}

async function poll() {
  try {
    const { version } = await getJSON<{ version: string }>("/api/version");
    live.classList.remove("down");
    live.title = "Live: refreshes when progress.json or the call graph changes";
    if (state.version !== null && version !== state.version) {
      state.version = version;
      live.classList.add("flash");
      setTimeout(() => live.classList.remove("flash"), 900);
      // never yank the page away from someone typing in a filter
      if (!(document.activeElement instanceof HTMLInputElement)) await render();
    }
    state.version = version;
  } catch (error) {
    live.classList.add("down");
    live.title = `Not reachable: ${error instanceof Error ? error.message : String(error)}`;
  }
}

// any address the module tool accepts: the detail page shows how it was read, or the graph's explanation of a miss
document.getElementById("jump")!.addEventListener("submit", (e: Event) => {
  e.preventDefault();
  const input = document.getElementById("jump-input") as HTMLInputElement;
  const q = input.value.trim();
  if (!q) return;
  input.value = "";
  input.blur();
  location.hash = moduleHref(q);
});

window.addEventListener("hashchange", () => render(true));
// compare mode is fixed for the life of the server: ask once
state.compare = await getJSON<CompareSummary>("/api/compare/summary").catch(() => null);
(document.getElementById("compare-tab") as HTMLElement).hidden = !state.compare;
await poll();
await render();
setInterval(poll, POLL_MS);
