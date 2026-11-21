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
- `--dashboard [--port n]`: `src/http/server.ts` serves `/mcp` (a fresh McpServer per request), the read-only dashboard API `/api/*` (`src/dashboard/api.ts`) and the page: `web/index.html` and `web/app.css` as files, the script compiled by the normal `tsc` build from `src/web/app.ts` (served from `build/` as `/app.js`, with the modules it imports at run time, `/percent.js` and `/hex.js`; add each new one to `STATIC` in `server.ts`). The app imports the API's response types directly, so a renamed field fails the build; anything it imports at run time must not import Node modules. Editing the page needs `npm run build` and a reload. Every string from graph/progress reaches the DOM as text, never markup (annotations are model-written).
- **The server owns wording and parsing; the page only renders**: every code branch in the page is a decision made a second time. The listing reaches the page structured (`annotateListing` in `src/graph/listing-targets.ts`: parsed code lines, transfer family, notes with target ids, comment lines split at the nodes they name); the MCP's text is `listingText` of the same structure, so the two cannot drift. `parseCodeLine` is the only reader of the listing line format (also used by `compare/fingerprint.ts`). Call sites and trace hops go out as `siteText` sentences, conditions as `conditionText`. Before adding logic to `src/web/app.ts`, check whether the server already computes it.
- `data/`: committed reference data (`interrupts.json.gz`, `memory-tables.json`) the server reads at run time. It is built outside this repository; treat it as an input.
- `scripts/build_callgraph.py` + `scripts/dosgraph/`: the generator (pytest in `scripts/tests/`, 100% branch coverage). Usage: `docs/README-DETAIL-GRAPH-BUILDER.md`; design: `docs/README-DETAIL-GRAPH-BUILDER-DESIGN.md`. Python packages: `venv-requirements.txt`.
- Local only, gitignored, never published: `game-data/` (inputs, one directory per target, plus target-specific plugins, declarations, acceptance tests and notes), `generated/` (trees built from them), `scratch/` (raw sources, data pipeline, probes, specs), `notes/`. Nothing tracked may name a target, quote its disassembly or name where `data/` came from.

## Conventions

- **Numbers from clients carry a hex marker** (`0x4C` or `4Ch`). Bare digits are rejected with the marked spelling to use: a model writing `21` may mean decimal or hex. `SEG:OFF` addresses, far calls and listing offsets are hex by definition.
- **Percentages round down** (`src/percent.ts` `percentDown`, used by the server and the dashboard page): only a complete value reads 100% and only zero reads 0%; one decimal near either end, more only for tiny nonzero values. Use it for every progress, readiness or similarity figure.
- **Graph tools take one `module` string**: a node id or an address pasted from a listing (`src/graph/addresses.ts`). Address frames are learned by voting over edge operands or declared in the graph's `frames`, never hard-coded. A call/jmp mnemonic means "function start"; a bare address may also be a site inside a function.
- **Node ids name the file the bytes are in**: space = file name upper-cased with `.` → `_` (`MAIN_EXE`), an overlay adds its stub segment, the number callers write in the far call (`MAIN_OVR-0020`), an overlay appended to the EXE its section or overlay number (`MAIN_EXE-0002`), a container record its record number (`SOUND_PAK-0001`); after the colon the address the listing shows. An id holds no invented word and nothing the reader must compute.
- **A far pointer in the load image is read only where the bytes mark it** (`scripts/dosgraph/pointers.py`, `flow._pointer_guesses`): a relocated segment word behind an offset word is a pointer when a call reads it (proof) or when it lies in a segment with no decoded instruction (guess). In a segment that holds code the same bytes are usually the operand of a far call not reached yet, so they are skipped.
- **A listing holds everything its function executes** (`scripts/dosgraph/tables.py`): jump-table cases are part of it, with the values a value search compares. Segment bases are only known from relocations and are approximate; do not reject a jump or table target for lying past one.
- **Facts about the code come from the decoder, not from listing text**: what a consumer needs to know about a function or an address is recorded by the generator (`navigation/data_references.json`, `frame_references.json`, `control_flow.json`, `return_offset` on call edges) and, where a model asks it directly, answered by a tool (`data_references`, `src/graph/datarefs.ts`). The server has no bulk export of listings and no text search over them.
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
- Not dominators: the entry dominates most of a program and would absorb it into one unit. Single-caller ownership can still produce one huge unit under a main dispatcher, hence the walk-back budget split.
- Nodes with nothing to write (unknown-target placeholders, address-only nodes) never root a unit; otherwise every unknown target with 2+ callers would become an empty unit counted complete from the start.
- Calls through stored pointers (edges with `through`) never own units: a dispatch table whose handlers call back into the dispatcher would otherwise fuse an interpreter into one unit. They do order units: such a call is a dependency unless the target's unit already waits on the caller's (`callsBack`); without that exception, handlers that reach their dispatcher again would never become ready. Link edges between programs are ignored.
- A function called through a stored pointer is the one thing a finished-looking translation can silently lack (no call names it, so nothing fails to build): `next_work` and `module` tell the client to register it and to test a path through the pointer (`POINTER_TARGET_ADVICE`).
- Ranking (`compareWorkUnits`): fully ready → no calls through run-time addresses → most units unblocked → not oversized → fewest external callees → size closest to budget → id. Readiness is all-or-nothing.
- A unit lists its members callees first; a member never blocks its own unit.
- `add_implementation` accepts `work:<root>` for bulk completion; the source's `/* Implements: */` must name the unit id or every member.

## Environment / tooling lessons

- **Rebuild after every pull/merge**: clients run `build/`, which is untracked.
- **Telemetry**: `src/telemetry.ts` (OTel MCP semconv spans + duration histogram, opt-in via `OTEL_EXPORTER_OTLP_*`). Local sink: `observability/` compose (collector → Jaeger, Prometheus, JSONL).
- MCP SDK 2.4 / spec 2026-07-28: input schemas must be objects; return `structuredContent` plus a text mirror; resource templates via `ResourceTemplate`; per-resource `cacheHint`.
- Some MCP clients route resource URIs by the template with the most literal characters, ties to the first server: keep per-server URI prefixes distinct.
