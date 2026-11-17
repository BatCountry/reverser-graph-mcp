# Working on reverser-progress-graph

This repository helps language models reverse engineer and reimplement old MS-DOS programs. It has two halves:

- **The generator** (`scripts/build_callgraph.py`, `scripts/dosgraph/`) turns a directory of 16-bit DOS executables into
  a navigable tree: a call graph and one control-flow listing per function, derived only from the bytes.
  Read `docs/README-DETAIL-GRAPH-BUILDER-DESIGN.md` before changing it.
- **The MCP server** (`src/`) serves that tree, plus DOS reference data (interrupts, memory map, I/O ports), to LLM
  clients. It also plans the reimplementation as work units and records progress. `README.md` gives the overview;
  `docs/README-DETAIL-*.md` document each part (tools, work units, configuration, dashboard, compare, …).

`CLAUDE.md` records conventions decided with the user and lessons learned; follow it.

## Who the clients are

Assume the client is a small or local model with a limited attention budget, working slowly through a large codebase.
Every design choice serves that reader:

- **Discovery advertises utility.** Server instructions and tool descriptions should make the server look like the
  obvious tool for the tasks it covers: plain, inviting language, with example uses rather than terse jargon. Never
  overclaim; a model that catches the server overselling stops trusting it. If one tool starts covering too many
  distinct tasks, propose a split to the user rather than deciding alone.
- **Enough, then navigable.** A tool result answers the question that was asked, briefly. Everything else (full
  listings, traces, whole work plans, reference pages) sits behind resources the client chooses to read. Drowning the
  client in data is a failure even when the data is correct.
- **Cache what is expensive, for a long time.** Clients are slow. Keep resource handles alive generously: cheap lookups
  for minutes, expensive walks and traces much longer. Memory is not the constraint; attention is.
- **Never trust the client's numbers.** Hex vs decimal cannot be guessed, so numbers must carry a hex marker. Every
  input from a client is untrusted.

## How the disassembly is built

The generator's principles are in `docs/README-DETAIL-GRAPH-BUILDER-DESIGN.md`; the short form:

- The bytes are the only source of truth. Another tool's output, a decompiler's guess or a reader's interpretation is
  never an input. When outside knowledge is unavoidable, declare it in a file beside the inputs and check every claim
  against the bytes.
- Fail loudly. A format the parser does not fully understand aborts the build; nothing is half-read.
- Recursive descent from proven entries, never linear sweep: data must never be listed as code.
- Uniform rules, no special cases. An idiom is recognised by what it does, never by an address, file name or byte
  signature of one program. A rule that is wrong for one input is fixed for all of them.
- Uncertainty is data: unresolved transfers say why, guessed functions are marked provisional with their evidence,
  resolved indirect calls say what they read through.
- Output is deterministic, so a test can require a stored tree to equal a fresh build.

## Keep targets out of the repository

The tool is published; the programs it is used on and everything derived from them are not.

- Inputs go in `game-data/<TARGET>/`; trees in `generated/`; raw sources, probes and specs in `scratch/`; personal
  notes in `notes/`. All four are gitignored.
- Nothing tracked may name a target, quote its disassembly or addresses, or name where `data/` came from.
- Target-specific code (container readers, loaded-module declarations), acceptance tests on real inputs, and notes
  about a target all live under `game-data/`.
- Tests and examples use neutral names (`MAIN.EXE`, `MAIN_OVR-0020:0100`, trees `alpha`, `beta`).

## Engineering rigor

- **Tests**: vitest for the server, pytest for the generator. Keep the setup minimal, but cover the value range of
  every input thoroughly. For a check like `15.0 <= value <= 20.0` on client input, test `inf`, `-inf`, `NaN`,
  `-1.0`, `0.0`, exactly `15`, exactly `20` and `21.0`. Statement coverage matters less; **branch coverage must be
  exhaustive wherever input is untrusted**: client arguments, binaries, data files, declarations. The generator
  suite holds 100% branch coverage.
- **Synthetic inputs**: generator tests build their binaries byte by byte (`scripts/tests/conftest.py`). Never depend
  on a real target in a tracked test.
- **Environment**: Python 3.14 in `.venv/` (install with `uv pip install …`; the generator needs `capstone`, the tests
  `pytest` and `pytest-cov`). Node with the MCP TypeScript SDK (`@modelcontextprotocol/server`), `zod`, `typescript`,
  and `@modelcontextprotocol/inspector` for manual checks.
- **Verify against the real surface**: run the built server (stdio or `--dashboard`) and check what a client
  actually sees, not just unit results.

## MCP specification

Use the current specification, not memory:

- Server: https://modelcontextprotocol.io/specification/2026-07-28/server
- Discovery: https://modelcontextprotocol.io/specification/2026-07-28/server/discover
- Resources: https://modelcontextprotocol.io/specification/2026-07-28/server/resources
- Tools: https://modelcontextprotocol.io/specification/2026-07-28/server/tools
- Caching: https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/caching
- Pagination: https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/pagination
