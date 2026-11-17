"""A game directory as one tree: which files are programs, which overlay file belongs to which program, the batch
files that run them, and the merged graph of all of them with the links between them (links.py).

Programs are the files DOS can run (`.EXE`, `.COM`) and the code modules programs read into memory (`.DRV`); each is
loaded as binary.load_executable says. An `.OVR` belongs to the one program whose INT 3Fh stub chain it tiles
(parse_overlays checks the chain, sizes and offsets strictly, so a wrong pairing never parses). Code a program reads
from a data file (a record of a container) is a program too when loaded_modules.json declares it (loaded.py). Anything
ambiguous or left over raises FormatError: a game is built whole or not at all.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from pathlib import Path

from .binary import Program, find_stub_segments, load_executable, parse_overlays
from .emit import build_graph, combine, diagnostics, frames
from .errors import FormatError
from . import loaded
from .flow import Analysis, analyze
from .links import Part, Script, link
from .x86 import Decoder

PROGRAM_SUFFIXES = (".EXE", ".COM", ".DRV")
OVERLAY_SUFFIX = ".OVR"
SCRIPT_SUFFIX = ".BAT"


@dataclass
class Game:
    programs: list[tuple[Program, Analysis]]
    graph: dict
    diagnostics: dict
    scripts: list[Script]


def inventory(directory: Path) -> list[tuple[str, bytes, str | None, bytes | None]]:
    """(program name, bytes, overlay name or None, overlay bytes or None) for every program of the game, by name."""
    files: dict[str, bytes] = {}
    for path in sorted(directory.iterdir()):
        name = path.name.upper()
        if not path.is_file() or not name.endswith((*PROGRAM_SUFFIXES, OVERLAY_SUFFIX)):
            continue
        if name in files:
            raise FormatError(f"{directory}: two files are named {name} apart from letter case")
        files[name] = path.read_bytes()
    programs = sorted(n for n in files if n.endswith(PROGRAM_SUFFIXES))
    overlays = sorted(n for n in files if n.endswith(OVERLAY_SUFFIX))
    if not programs:
        raise FormatError(f"{directory}: no .EXE, .COM or .DRV files")
    claimed: dict[str, str] = {}
    out = []
    for name in programs:
        image = load_executable(files[name], name)
        if not (image.layout.startswith("MZ") and find_stub_segments(image.image)):
            out.append((name, files[name], None, None))
            continue
        fits = []
        for ovr in overlays:
            try:
                parse_overlays(image, files[ovr], ovr)
            except FormatError:
                continue
            fits.append(ovr)
        if len(fits) != 1:
            seen = ", ".join(fits) if fits else (f"none of {', '.join(overlays)}" if overlays else "the directory has no .OVR file")
            raise FormatError(f"{name} has INT 3Fh overlay stubs; {len(fits)} overlay files fit its stub chain ({seen}), need exactly one")
        if fits[0] in claimed:
            raise FormatError(f"{fits[0]} fits the stub chains of both {claimed[fits[0]]} and {name}")
        claimed[fits[0]] = name
        out.append((name, files[name], fits[0], files[fits[0]]))
    unclaimed = [o for o in overlays if o not in claimed]
    if unclaimed:
        raise FormatError(f"{', '.join(unclaimed)}: no program's overlay stub chain fits")
    return out


def scripts(directory: Path) -> list[Script]:
    """The game's batch files, by name."""
    out: dict[str, Script] = {}
    for path in sorted(directory.iterdir()):
        name = path.name.upper()
        if not path.is_file() or not name.endswith(SCRIPT_SUFFIX):
            continue
        if name in out:
            raise FormatError(f"{directory}: two files are named {name} apart from letter case")
        out[name] = Script(name, path.read_bytes())
    return [out[n] for n in sorted(out)]


def build(directory: Path, modules: tuple[loaded.LoadedModule, ...] = ()) -> Game:
    """`modules`: this game's entries of loaded_modules.json (loaded.load)."""
    parts: list[Part] = []
    graph_parts, frame_list = [], []
    hashes: dict[str, str] = {}
    diag: dict[str, dict] = {}
    programs = [(name, exe, ovr_name, ovr, {}) for name, exe, ovr_name, ovr in inventory(directory)]
    for name, blob, layout, in_file, note in loaded.modules(directory, list(modules), {p[0] for p in programs}):
        programs.append((name, blob, None, None, {"layout": layout, "in_file": in_file, "loaded_from": note}))
    for name, exe, ovr_name, ovr, how in programs:
        prog = Program(exe, ovr, name, ovr_name, **how)
        dec = Decoder(prog)
        an = analyze(prog, dec, stop_on_fallthrough=True)
        parts.append(Part(prog, dec, an))
        graph_parts.append(build_graph(prog, dec, an))
        frame_list += frames(prog)
        hashes[name] = hashlib.sha256(exe).hexdigest()
        if ovr_name:
            hashes[ovr_name] = hashlib.sha256(ovr).hexdigest()
        diag[name] = diagnostics(prog, an)
    batch = scripts(directory)
    for s in batch:
        hashes[s.name] = hashlib.sha256(s.data).hexdigest()
    files_of = {p.prog.exe_name: [p.prog.exe_name] + ([p.prog.ovr_name] if p.prog.ovr_name else []) for p in parts}
    files_of.update({s.name: [s.name] for s in batch})
    graph = combine(graph_parts, hashes, frame_list, files_of)
    loaded.resolve(parts, list(modules), graph)
    link(parts, batch, graph)
    return Game([(p.prog, p.an) for p in parts], graph, diag, batch)
