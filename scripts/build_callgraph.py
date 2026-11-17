#!/usr/bin/env python3
"""Build one call graph, with per-function listings, from every program in a game directory.

    .venv/bin/python scripts/build_callgraph.py --game game-data/ALPHA --out generated/alpha

The directory's .EXE/.COM/.DRV files are its programs and each .OVR goes with the program whose overlay stubs it
fits (scripts/dosgraph/game.py); code the programs read from data files at run time comes from
loaded_modules.json (scripts/dosgraph/loaded.py). Everything is derived from the binaries; a layout this tool
cannot parse, or a declaration the bytes contradict, aborts the build with a message and writes nothing.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from dosgraph import game, loaded  # noqa: E402
from dosgraph.emit import write_tree  # noqa: E402
from dosgraph.errors import FormatError  # noqa: E402

MODULES_NAME = "loaded_modules.json"


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--game", required=True, type=Path, help="game directory (e.g. game-data/ALPHA)")
    ap.add_argument("--out", required=True, type=Path, help="tree to write (e.g. generated/alpha)")
    ap.add_argument("--modules", type=Path, default=None,
                    help=f"code read from data files at run time, keyed by game directory name "
                         f"(default: {MODULES_NAME} in the game directory's parent; a missing file declares nothing)")
    return ap.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if not args.game.is_dir():
        print(f"build_callgraph: {args.game} is not a directory", file=sys.stderr)
        return 2
    try:
        modules = args.modules or args.game.resolve().parent / MODULES_NAME
        g = game.build(args.game, tuple(loaded.load(modules, args.game.resolve().name)))
    except FormatError as e:
        print(f"build_callgraph: {args.game}: unsupported input: {e}", file=sys.stderr)
        return 2
    count, size = write_tree(args.out, g.programs, g.graph, g.diagnostics, tuple(g.scripts))
    c = g.graph["counts"]
    names = ", ".join([p.exe_name + (f" + {p.ovr_name}" if p.ovr_name else "") for p, _an in g.programs] + [s.name for s in g.scripts])
    print(f"wrote {args.out}/navigation/callgraph.json ({names}): {c['functions']} functions, {c['edges']} edges "
          f"({c['runs_edges']} runs, {c['loads_edges']} loads, {c['interrupt_edges']} interrupt), "
          f"{c['unknown_targets']} unknown targets; {count} listings ({size} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
