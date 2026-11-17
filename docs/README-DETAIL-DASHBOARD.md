# Progress dashboard and HTTP mode

`npm run dashboard -- --disassembly-root <tree>` (`node build/index.js --dashboard`, add `--port 8765` or any other
flags) serves, on one port of `127.0.0.1` (printed on stderr: `dashboard at http://127.0.0.1:NNNNN/ …`):

- `/`: a dashboard. Overview: functions and listing lines implemented, work units complete / ready / partly done, a
  burn-up chart of `add_implementation` records by day, the next ten work units in `next_work` order, a map of every
  function by space (colour = implemented / ready / waiting, size = listing length) and recent activity. Modules:
  every function, filterable and sortable. Work queue: every work unit in rank order. A module page shows its work unit
  (members, the units it calls and is called from), how the program reaches it ("Reached from": the shortest call
  chain from each of the 10 nearest entrypoints, every call site with its branch conditions and what an indirect call
  went through, each function a link), implementations and annotations, callers and callees with call sites and branch
  conditions, and the listing with `; →` targets as links. The jump box takes anything `module` does
  (`lcall 0x41, 0x25`, `3a0:0112`, `work:…`). The page polls `/api/version` (progress document and callgraph.json
  change tokens) every 4 s and redraws when either changes.
- `/api/version`, `/api/summary`, `/api/modules`, `/api/modules/{id or address, URL-encoded}`, `/api/units`: the JSON
  behind it (read-only; other methods get 405).
- `/mcp`: the same MCP server over streamable HTTP (2026-07-28 per-request protocol, with the stateless fallback for
  2025-era clients). In an MCP client's config: `{"type": "http", "url": "http://127.0.0.1:<port>/mcp"}` (with a fixed
  `--port`).

stdio stays the default; the dashboard does not need the MCP clients to switch. Progress is re-read from the progress
document on every request, so a dashboard process and any number of stdio servers sharing one `--disassembly-root` /
`--progress-root` always agree; start one per workspace with that workspace's roots.

It only binds loopback, and every request must carry a localhost `Host` header, and a localhost `Origin` when a browser
sends one (403 otherwise): a web page that rebinds its own hostname to 127.0.0.1 (DNS rebinding) cannot read the
dashboard or call `add_implementation` / `annotate`.
