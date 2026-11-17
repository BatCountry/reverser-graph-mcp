"""Code a program reads from a data file at run time and calls: sound drivers or overlays kept inside a container file.

The program builds the far pointer to such code from a heap block it filled from the file, so no constant pointer
leads to it and the generator cannot see the link by itself. A manifest (`loaded_modules.json`, by default in the
parent of the game directory, keyed by game directory name) declares it, one entry per far-pointer variable:

    {"program": "MAIN.EXE", "pointer": "ds:[59a6]", "file": "SOUND.PAK", "records": [1], "layout": "COM",
     "reader": "plugins/pak.py", "evidence": "<the loader, the setup and the calls, by node>"}

* `records`: the container records that can be behind the pointer (several = alternatives, the player's
  configuration picks one); omitted for a whole file.
* `reader`: required with `records`, forbidden without. A Python file, path relative to the manifest, defining
  `records(data: bytes, name: str) -> dict[int, bytes]` that unpacks every record of the container by id. The
  generator knows no container format itself; anything the reader raises, or a result that is not such a dict, is a
  FormatError naming the reader and the file.
* `layout`: "COM" when the program enters it at seg:0100 (the code is linked for 100h), "module" when at seg:0000.

Every claim is checked against the bytes: the program, the file and the records exist, the record decodes, and the
program has at least one far call through ds:[pointer]. Each such call then calls the module's entry, one edge per
record, in place of the unknown target it had.
"""

from __future__ import annotations

import importlib.util
import json
import re
from dataclasses import dataclass
from pathlib import Path

from . import pointers
from .binary import LAYOUTS, nid
from .emit import site_conditions
from .errors import FormatError

POINTER = re.compile(r"^ds:\[([0-9a-f]{1,4})\]$")
FIELDS = {"program", "pointer", "file", "records", "layout", "evidence", "reader"}


@dataclass(frozen=True)
class LoadedModule:
    program: str
    pointer: int
    file: str
    records: tuple[int, ...] | None
    layout: str
    evidence: str
    reader: Path | None = None


def parse(raw: object, game: str, base: Path = Path()) -> list[LoadedModule]:
    """The entries for `game` (a directory name) from the parsed JSON; anything malformed raises FormatError.
    `base`: the directory of the manifest, which a `reader` path is relative to."""
    if not isinstance(raw, dict):
        raise FormatError("loaded_modules.json: the top level must be an object keyed by game directory")
    entries = raw.get(game.upper(), [])
    if not isinstance(entries, list):
        raise FormatError(f"loaded_modules.json: {game.upper()} must be a list of entries")
    out = []
    for i, e in enumerate(entries):
        where = f"loaded_modules.json {game.upper()}[{i}]"
        if not isinstance(e, dict):
            raise FormatError(f"{where}: an entry must be an object")
        unknown = set(e) - FIELDS
        missing = FIELDS - {"records", "reader"} - set(e)
        if unknown or missing:
            raise FormatError(f"{where}: unknown fields {sorted(unknown)}, missing fields {sorted(missing)}")
        for key in ("program", "pointer", "file", "layout", "evidence"):
            if not isinstance(e[key], str) or not e[key].strip():
                raise FormatError(f"{where}: {key} must be a non-empty string")
        m = POINTER.match(e["pointer"].strip().lower())
        if not m:
            raise FormatError(f"{where}: pointer {e['pointer']!r} is not ds:[XXXX] (hex)")
        if e["layout"] not in LAYOUTS:
            raise FormatError(f"{where}: layout {e['layout']!r} is not one of {', '.join(LAYOUTS)}")
        recs = e.get("records")
        if recs is not None and (
            not isinstance(recs, list) or not recs
            or not all(isinstance(r, int) and not isinstance(r, bool) and 0 <= r <= 0xFF for r in recs)
            or len(set(recs)) != len(recs)
        ):
            raise FormatError(f"{where}: records must be a non-empty list of distinct record ids 0-255")
        reader = e.get("reader")
        if recs is None and reader is not None:
            raise FormatError(f"{where}: reader is for entries with records; a whole file needs none")
        if recs is not None and (not isinstance(reader, str) or not reader.strip()):
            raise FormatError(f"{where}: records need a reader (a Python file path relative to the manifest)")
        entry = LoadedModule(e["program"].strip().upper(), int(m.group(1), 16), e["file"].strip().upper(),
                             None if recs is None else tuple(recs), e["layout"], e["evidence"].strip(),
                             None if reader is None else base / reader.strip())
        if any((o.program, o.pointer) == (entry.program, entry.pointer) for o in out):
            raise FormatError(f"{where}: {entry.program} ds:[{entry.pointer:04x}] is declared twice")
        out.append(entry)
    return out


def load(path: Path, game: str) -> list[LoadedModule]:
    """The entries for `game` from a loaded_modules.json file; a missing file declares nothing."""
    if not path.exists():
        return []
    try:
        raw = json.loads(path.read_text())
    except json.JSONDecodeError as error:
        raise FormatError(f"{path}: not JSON ({error})") from error
    return parse(raw, game, path.parent)


def read_records(reader: Path, data: bytes, name: str) -> dict[int, bytes]:
    """Unpack the container `name` with the reader plugin; every failure is a FormatError naming reader and file."""
    if not reader.is_file():
        raise FormatError(f"loaded_modules.json: reader {reader} for {name} is not a file")
    try:
        spec = importlib.util.spec_from_file_location(f"_reader_{reader.stem}", reader)
        if spec is None:
            raise ImportError("it is not a Python source file (.py)")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        func = getattr(module, "records", None)
        if not callable(func):
            raise TypeError("it defines no records(data, name) function")
        result = func(data, name)
    except Exception as error:  # a plugin may raise anything
        raise FormatError(f"{name}: reader {reader} failed: {error}") from error
    if not isinstance(result, dict) or not all(
        isinstance(k, int) and not isinstance(k, bool) and isinstance(v, bytes) for k, v in result.items()
    ):
        raise FormatError(f"{name}: reader {reader} must return a dict of int -> bytes, not {type(result).__name__}")
    return result


def module_name(file: str, record: int | None) -> str:
    """`SOUND.PAK-0001` (space SOUND_PAK-0001) for a record; the file name for a whole file."""
    return file if record is None else f"{file}-{record:04X}"


def modules(directory: Path, entries: list[LoadedModule], programs: set[str]) -> list[tuple[str, bytes, str, bool, str]]:
    """(module name, bytes, layout, in_file, description) for every declared record; checks program, file and records."""
    files = {p.name.upper(): p for p in directory.iterdir() if p.is_file()}
    out = []
    seen: dict[str, str] = {}
    for e in entries:
        if e.program not in programs:
            raise FormatError(f"loaded_modules.json: {e.program} is not a program of {directory.name}")
        if e.file not in files:
            raise FormatError(f"loaded_modules.json: {directory.name} has no file {e.file}")
        data = files[e.file].read_bytes()
        if e.records is None:
            parts = [(None, data)]
        else:
            recs = read_records(e.reader, data, e.file)
            absent = [r for r in e.records if r not in recs]
            if absent:
                raise FormatError(f"loaded_modules.json: {e.file} has no record {', '.join(map(str, absent))} (it has {', '.join(map(str, sorted(recs)))})")
            parts = [(r, recs[r]) for r in e.records]
        for r, blob in parts:
            name = module_name(e.file, r)
            if name in programs:
                raise FormatError(f"loaded_modules.json: {name} is already a program of {directory.name}")
            if name in seen:
                if seen[name] != e.layout:
                    raise FormatError(f"loaded_modules.json: {name} is declared with layouts {seen[name]} and {e.layout}")
                continue
            seen[name] = e.layout
            what = e.file if r is None else f"record {r} of {e.file}"
            out.append((name, blob, e.layout, r is None, f"{what}, which {e.program} reads and calls through ds:[{e.pointer:04x}]"))
    return out


def resolve(parts: list, entries: list[LoadedModule], graph: dict) -> None:
    """Turn each far call through a declared pointer into calls of the module entries (parts: links.Part)."""
    by_name = {p.prog.exe_name: p for p in parts}
    for e in entries:
        part = by_name[e.program]
        records = e.records or (None,)
        sites = [r for r in part.an.resolved if r.use.far and r.use.where == ("abs", pointers.DGROUP, e.pointer)]
        if not sites:
            raise FormatError(f"loaded_modules.json: {e.program} has no far call through ds:[{e.pointer:04x}]")
        for r in sites:
            ins, fid = r.use.ins, r.use.fid
            site = nid(ins.space, ins.addr)
            graph["edges"] = [x for x in graph["edges"] if not (x["source"] == fid and x["instruction_offset"] == site and x["target"].startswith("unknown:"))]
            alternatives = (f" (one of records {', '.join(map(str, records))}: the player's configuration picks which is loaded)"
                            if len(records) > 1 else "")
            conditions = site_conditions(part.dec, part.an.descents[fid], ins.addr)
            for rec in records:
                target = by_name[module_name(e.file, rec)].prog
                what = e.file if rec is None else f"{e.file} record {rec}"
                graph["edges"].append({
                    "conditions": conditions,
                    "instruction": ins.text,
                    "instruction_offset": site,
                    "returns": True,
                    "source": fid,
                    "target": target.entry_id,
                    "through": f"{r.use.through}: the far pointer to {what} ({target.root}), read from the file at run time{alternatives}; "
                               f"declared in loaded_modules.json: {e.evidence}",
                })
    used = {x["target"] for x in graph["edges"]}
    graph["nodes"] = {k: v for k, v in graph["nodes"].items() if v["kind"] != "unknown-target" or k in used}
