# CLAUDE.md

Working notes for agents on this repo. `AGENTS.md` is the brief (who the clients are, the generator's principles,
keeping targets out of the repository, testing rigor); `README.md` is the overview for humans and `docs/README-DETAIL-*.md`
document each part; `docs/README-DETAIL-GRAPH-BUILDER-DESIGN.md` explains the call-graph generator (principles,
pipeline, where it is specific to real-mode DOS and how to broaden it). Notes about particular targets live with
their inputs under `game-data/` (gitignored, local only). When behaviour changes, update the matching detail doc.

## Layout

- `src/index.ts`: server instructions, config, shared state, tool registration loop; stdio by default, `--dashboard` → `src/http/server.ts`.
- `src/tools/<tool>.ts`: one file per MCP tool (description, zod schemas, handler, tool-only helpers). `common.ts` holds `numberish`, `asText`, `ToolDeps`.
- Logic shared with resources/tests stays in its domain folder: `interrupts/`, `memory/`, `ports/`, `graph/` (call graph, paths, listings, work units, same code), `progress/` (progress.json, Implements-comment checks), `compare/` (two trees side by side, carrying progress). Tool files must not be imported by resources.
- `src/resources.ts`: all `dosref://` (reference) and `disasm://` (disassembly) resources.
- `--dashboard [--port n]`: `src/http/server.ts` serves `/mcp` (a fresh McpServer per request), the read-only dashboard API `/api/*` (`src/dashboard/api.ts`) and the static page in `web/` (vanilla JS, no build step). Every string from graph/progress reaches the DOM as text, never markup (annotations are model-written).
- `data/`: committed reference data (`interrupts.json.gz`, `memory-tables.json`) the server reads at run time. It is built outside this repository; treat it as an input.
- `scripts/build_callgraph.py` + `scripts/dosgraph/`: the generator (pytest in `scripts/tests/`, 100% branch coverage). Usage: `docs/README-DETAIL-GRAPH-BUILDER.md`; design: `docs/README-DETAIL-GRAPH-BUILDER-DESIGN.md`. Python packages: `venv-requirements.txt`.
- Local only, gitignored, never published: `game-data/` (inputs, one directory per target, plus target-specific plugins, declarations, acceptance tests and notes), `generated/` (trees built from them), `scratch/` (raw sources, data pipeline, probes, specs), `notes/`. Nothing tracked may name a target, quote its disassembly or name where `data/` came from.

## Conventions

- **Numbers from clients carry a hex marker** (`0x4C` or `4Ch`). Bare digits are rejected with the marked spelling to use: models cannot be trusted to mean decimal vs hex ("INT 21" silently became INT 15h under a decimal rule). `SEG:OFF` addresses, far calls and listing offsets are hex by definition.
- **Percentages round down** (`src/percent.ts` `percentDown`, same rule copied in `web/app.js`): only a complete value reads 100% and only zero reads 0%; one decimal near either end, more only for tiny nonzero values. Rounding to nearest showed 1196/1198 functions as "100%" and a unit waiting on 1 of 300 callees as "readiness 100%". Use it for every progress, readiness or similarity figure.
- **Graph tools take one `module` string**: a node id or an address pasted from a listing (`src/graph/addresses.ts`). Address frames are learned by voting over edge operands or declared in the graph's `frames`, never hard-coded. A call/jmp mnemonic means "function start"; a bare address may also be a site inside a function.
- **Node ids name the file the bytes are in**: space = file name upper-cased with `.` → `_` (`MAIN_EXE`), an overlay adds its stub segment, the number callers write in the far call (`MAIN_OVR-0020`), a container record its record number (`SOUND_PAK-0001`); after the colon the address the listing shows. Invented words (`root`, `module-XXXX` = segment × 16) confused small models into wrong arithmetic.
- **Work unit** ids are `work:<root node id>`. Never call them just "unit": `units/` means the tree's source-file directories.
- **Configuration**: `--disassembly-root` / `REVERSER_DISASSEMBLY_ROOT` is required; progress root, implementation root, work budget and trivial-line threshold are flags / `REVERSER_*` env. The tree name (the root's directory name) names the progress document, the required `tree` argument of `add_implementation`/`annotate`, and the `disasm://<tree>/…` URI prefix.
- **Writes name their tree**: with one server per tree, a worker talking to the wrong server must not mark another tree's functions, so `add_implementation` and `annotate` refuse any `tree` but their own (case and surrounding space ignored).
- **Resource URIs name their tree** (`disasm://<tree>/listing/…`, compare URIs `disasm://<tree>/compare/<other>/…`): MCP clients route a URI to the first server whose template matches, so identical paths across servers would all go to one of them.
- **Same-code groups stay whole**, empty procedures included: implementing one member covers the group (`src/graph/samecode.ts`).
- Tool results stay short; depth goes behind resources. Cache handles: cheap lookups ~10 min, traces/plans ~1 h (`src/cache.ts`).
- Tests: vitest and pytest; exhaustive branch coverage for untrusted input (empty, NaN, ±Infinity, negative, exact boundaries, one past). `npm test` builds first and includes a stdio end-to-end suite against the built server with a fixture tree (`test/fixture.ts`). Tests on real targets live under `game-data/tests/` and run locally only.
- **Delegated work goes to Orca workers** (skills `orchestration`, `orca-cli`), so the user can see and steer it.

## Work-unit planner (`src/graph/workunits.ts`, `next_work`)

The reasoning matters for future tuning:
- Partition = single-caller ownership: a function with exactly one caller belongs to it; rolling up stops at any function with 0 or ≥2 callers. Mutual recursion is collapsed first.
- Dominators were rejected as the basis: in a typical program the entry dominates most of the graph and absorbs it into one unit. Pure single-caller ownership can still produce one huge unit under a main dispatcher, hence the walk-back budget split.
- Nodes with nothing to write (unknown-target placeholders, address-only nodes) never root a unit; otherwise every unknown target with 2+ callers would become an empty unit counted complete from the start.
- Calls through stored pointers (edges with `through`) neither own nor order units: a dispatch table whose handlers call back into the dispatcher would otherwise fuse an interpreter into one unit. Link edges between programs are ignored too.
- Ranking (`compareWorkUnits`): fully ready → no calls through run-time addresses → most units unblocked → not oversized → fewest external callees → size closest to budget → id. Readiness is all-or-nothing.
- Workers misread units ("blocked by its callee" when the callee is a member listed callees-first); orchestrators should check `next_work` with `module` before accepting such claims.
- `add_implementation` accepts `work:<root>` for bulk completion; the source's `/* Implements: */` must name the unit id or every member.

## Environment / tooling lessons

- **Rebuild after every pull/merge**: clients run `build/`, which is untracked; a stale build once exposed only old stub tools.
- **Telemetry**: `src/telemetry.ts` (OTel MCP semconv spans + duration histogram, opt-in via `OTEL_EXPORTER_OTLP_*`). Local sink: `observability/` compose (collector → Jaeger, Prometheus, JSONL).
- MCP SDK 2.4 / spec 2026-07-28: input schemas must be objects; return `structuredContent` plus a text mirror; resource templates via `ResourceTemplate`; per-resource `cacheHint`.
- Some MCP clients route resource URIs by the template with the most literal characters, ties to the first server: keep per-server URI prefixes distinct.
