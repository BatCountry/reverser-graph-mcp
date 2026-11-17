# The graph builder (`scripts/build_callgraph.py`)

`scripts/build_callgraph.py` builds a tree (call graph JSON, per-function listings, README) from every program in a
directory of 16-bit MS-DOS executables; the analysis lives in `scripts/dosgraph/`, and
[README-DETAIL-GRAPH-BUILDER-DESIGN.md](README-DETAIL-GRAPH-BUILDER-DESIGN.md) explains its principles, its pipeline,
where it is specific to real-mode DOS and Turbo Pascal-era toolchains, and how to broaden it. Needs the packages in
`venv-requirements.txt` installed in `.venv`.

```
.venv/bin/python scripts/build_callgraph.py --game game-data/ALPHA --out generated/alpha [--modules FILE]
cd scripts && ../.venv/bin/python -m pytest tests -q --cov=dosgraph --cov-branch
```

Inputs go under `game-data/` and trees under `generated/`; both are gitignored, so nothing built from a target is ever
committed. Tests that need a real target live with it under `game-data/tests/`.

`dosgraph/game.py` takes the inventory: `.EXE`/`.COM`/`.DRV` files are programs (`binary.load_executable`: MZ by
header, EXEPACK unpacked by `exepack.py`; `.COM` at 100h; anything else a module at offset 0 with its leading `jmp`
table as entries), each `.OVR` (Turbo Pascal 5 `TPOV` or 6 `FBOV`) goes with the one program whose INT 3Fh stub chain
it tiles; an RTLink/Plus program's appended sections are parsed from its loader's section table
(`binary.parse_rtlink`). Each program is analysed on its own and the parts are merged into one tree.
`dosgraph/links.py` then links the programs: `interrupt` (an `int n` site to the handlers resident programs install
for n), `runs` / `loads` (a function naming another program in a string constant and reaching DOS exec / open), and
each `.BAT` as a node whose lines `run` programs (method: step 6 of the tree's `navigation/README.md`).
`dosgraph/pointers.py` follows constant far pointers from where the code builds them to the calls and jumps through
them; a dataflow that never settles is a bug and aborts the build. The graph's `frames` table records how the code
writes addresses (unrelocated far calls, offsets within a space).

## Code loaded from data files

Code a program reads from a data file into a heap block and far-calls through a pointer it computes at run time cannot
be found by the dataflow: no constant leads there. It is declared in `loaded_modules.json`, by default the file beside
the game directory (`<game dir>/../loaded_modules.json`; `--modules` names another; a missing file declares nothing),
keyed by game directory name, one entry per far-pointer variable:

```json
{"ALPHA": [{"program": "MAIN.EXE", "pointer": "ds:[1234]", "file": "SOUND.PAK", "records": [1],
            "reader": "plugins/pak.py", "layout": "COM", "evidence": "<the loader, the setup and the calls, by node>"}]}
```

* `records`: the container records that can be behind the pointer (several = alternatives, e.g. one per sound card);
  omit for a whole file. `reader` (with `records` only): a Python file, relative to the manifest, defining
  `records(data: bytes, name: str) -> dict[int, bytes]` that unpacks the container. No container format is built in.
* `layout`: `COM` when the program enters the code at seg:0100 (linked for 100h), `module` when at seg:0000 with its
  `jmp` table.

Each record becomes a program `SOUND.PAK-0001` (space `SOUND_PAK-0001`, no file offsets since the bytes are unpacked),
and every far call through the declared pointer calls its entry instead of an unknown target (`dosgraph/loaded.py`).
Every claim is checked against the bytes: the program, the file, the reader and the records exist, the records
decode, and the program has a far call through the pointer. A declaration the bytes contradict aborts the build.

A directory that does not fit these layouts (an overlay file no program claims, a section table that does not tile)
aborts with `unsupported input: ...` (exit 2) and writes nothing.
