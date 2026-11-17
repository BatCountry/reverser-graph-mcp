# Configuration, trees and progress

| Setting | Flag | Environment | Default |
| --- | --- | --- | --- |
| `disassembly_root` | `--disassembly-root` | `REVERSER_DISASSEMBLY_ROOT` | required: the generated tree to serve |
| `progress_root` | `--progress-root` | `REVERSER_PROGRESS_ROOT` | `<disassembly_root>/../reimplementation/progress` |
| `implementation_root` | `--implementation-root` | `REVERSER_IMPLEMENTATION_ROOT` | parent of `progress_root` |
| `work_budget_lines` | `--work-budget-lines` | `REVERSER_WORK_BUDGET_LINES` | `600` (split work units larger than this) |
| `work_trivial_lines` | `--work-trivial-lines` | `REVERSER_WORK_TRIVIAL_LINES` | `20` (leaf callees below this stay with their caller) |
| `dashboard` | `--dashboard` | | off: stdio. On: serve the dashboard and MCP over HTTP on `127.0.0.1` instead ([dashboard](README-DETAIL-DASHBOARD.md)) |
| `port` | `--port` | | a free port (only with `--dashboard`; decimal 0-65535, `0` = any free port) |
| `compare` | `--compare` | `REVERSER_COMPARE_ROOT` | off. A second generated tree (another program or build): adds the compare tools, resources and dashboard page ([comparing two trees](README-DETAIL-COMPARE.md)). Its directory name must differ from `disassembly_root`'s |
| `game_name` | `--game-name` | `REVERSER_GAME_NAME` | none. A title for the dashboard's Overview card (`--game-name "Example Game"`), shown above the completion rings; trimmed, at most 120 characters, an empty value stops startup |

Work unit sizes are decimal positive whole numbers; anything else stops the server at startup with a message naming the
setting.

## Trees

The call graph is `<disassembly_root>/navigation/callgraph.json`; listing paths inside it are resolved from their
`units/` suffix, so the root may live under any directory name (e.g. `reversing/disassembly`).

**Inputs and the trees built from them stay out of the repository.** Put each target's original files in its own
directory under `game-data/` (`game-data/ALPHA/`, …); trees are built into `generated/<dir, lower case>/`. Both
directories are gitignored. A new target is a new directory under `game-data/`.

A tree is built from the original binaries by `scripts/build_callgraph.py`
([graph builder](README-DETAIL-GRAPH-BUILDER.md), its [design](README-DETAIL-GRAPH-BUILDER-DESIGN.md), and the tree's
own `navigation/README.md`): every program of the directory in one tree (each `.EXE`/`.COM`/`.DRV`, EXEPACK unpacked,
each Turbo Pascal 5/6 `.OVR` with the program whose overlay stubs it fits, RTLink/Plus overlay sections appended to an
EXE), recursive descent per program, one control-flow listing per function, call edges only (no string bytes decoded
as jumps):

```
.venv/bin/python scripts/build_callgraph.py --game game-data/ALPHA --out generated/alpha
node build/index.js --disassembly-root generated/alpha
```

Programs of one directory are linked by edges carrying `link`: `runs` (a batch-file line or DOS exec starts another
program), `loads` (a program reads another program's file, e.g. a loader reading its drivers), `interrupt` (an `int n`
to each resident program's handler for n); each `.BAT` is a node whose listing is its lines. Code a program reads from
a data file and far-calls can be declared in a `loaded_modules.json` beside the inputs; it is checked against the
bytes and becomes a program of its own (`SOUND_PAK-0001:0100`) whose entry the far call reaches
([graph builder](README-DETAIL-GRAPH-BUILDER.md)).

## Progress

Progress lives in `<progress_root>/<disassembly_root dir name>.progress.json` (`alpha.progress.json`,
`beta.progress.json`): node ids such as `MAIN_EXE:…` and `MAIN_OVR-0020:…` repeat across trees, so two trees sharing a
progress root must never share a document. The server prints the path on startup.

`add_implementation` only accepts a file under `implementation_root` containing a `/* Implements: <module> */` block
comment naming the module (or work unit) and mentioning the function. Both `add_implementation` and `annotate` take a
required `tree`: the tree the work is for, as its directory name (`alpha`; case and surrounding space ignored). A
server refuses any other tree and records nothing, so a worker talking to the wrong server (one per tree, same tool
names) cannot mark another tree's functions; `next_work` names the tree to pass.
