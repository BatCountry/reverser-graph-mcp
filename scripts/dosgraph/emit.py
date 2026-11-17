"""Call-graph JSON, per-function listings and README for a generated tree."""

from __future__ import annotations

import collections
import datetime as _dt
from pathlib import Path

from . import pointers
from .binary import Program, file_space, nid, split_id
from .errors import FormatError
from .flow import Analysis, Descent, control_dependence, flag_setter, straight_preds
from .x86 import Decoder, Insn

GENERATOR = "scripts/build_callgraph.py"
SCOPE = (
    "functions found by recursive descent from every program's entry point (and a loaded module's entry table), every INT 3Fh overlay entry, every direct "
    "call target, cross-space jump targets, the targets of indirect transfers resolved through the constant "
    "pointers the code stores, installed interrupt handlers and validated pointer guesses (provisional); edges "
    "are calls, tail jumps to other functions and indirect transfers, decoded from the original binaries, plus links "
    "between programs (runs, loads, interrupt) and the game's batch files"
)
MAX_EVIDENCE = 4  # evidence lines kept on a node; analysis.json has them all


def unit_dir(source_file: str) -> str:
    """Listing directory of a source file: units/main_exe, units/main_ovr (one per file, so PLAY.EXE and
    MAIN.OVR in one game do not share a directory)."""
    return file_space(source_file).lower()


def listing_path(prog: Program, fid: str) -> str:
    space, _ = split_id(fid)
    return f"units/{unit_dir(prog.spaces[space].source_file)}/functions/{fid.replace(':', '_')}.asm"


def unknown_id(ins: Insn) -> str:
    return f"unknown:{ins.space}:{ins.addr:04x}"


ENTRY_KINDS = {"program-entry", "overlay-entry", "module-entry", "address-taken", "interrupt-vector", "pointer-target"}


def _evidence(an: Analysis, fid: str) -> list[str]:
    """Why a function exists beyond a direct call: the transfers that prove it, then where its address is built."""
    lines = list(dict.fromkeys(an.proof.get(fid, []) + an.address_taken.get(fid, [])))
    if len(lines) > MAX_EVIDENCE:
        return lines[:MAX_EVIDENCE] + [f"({len(lines) - MAX_EVIDENCE} more in navigation/analysis.json)"]
    return lines


def _unknown_reason(d: Descent, ins: Insn, r: pointers.Resolved) -> str:
    """Why (part of) an indirect transfer has no function target."""
    if ins.kind == "ijmp" and ins.addr in d.why and not r.targets and (r.use.where is None or r.use.where[0] == "indexed"):
        return f"jump table not followed: {d.why[ins.addr]}"
    if r.reason:
        return r.reason
    return "the stored pointers lead to no decoded function: " + ", ".join(t.node for t in r.targets)


MAX_SHARERS = 5


def instruction_owners(an: Analysis) -> dict[tuple[str, int], set[str]]:
    """(space, address) -> functions whose reachable code contains that instruction."""
    owners: dict[tuple[str, int], set[str]] = collections.defaultdict(set)
    for fid, d in an.descents.items():
        space = split_id(fid)[0]
        for a in d.insns:
            owners[(space, a)].add(fid)
    return owners


def _chunks(d: Descent) -> list[list[Insn]]:
    """Runs of instructions in address order; a new run starts at a gap or an overlapping start."""
    chunks: list[list[Insn]] = []
    end = None
    for a in sorted(d.insns):
        ins = d.insns[a]
        if end is None or a != end:
            chunks.append([])
        chunks[-1].append(ins)
        end = max(end or 0, ins.end)
    return chunks


def render_listing(fid: str, d: Descent, owners: dict[tuple[str, int], set[str]] | None = None) -> str:
    """Function listing: the chunk starting at the entry first, then the other chunks in address order.
    `; ...` separates non-contiguous chunks; chunks other functions also reach get a `; shared with` line."""
    _space, entry = split_id(fid)
    chunks = _chunks(d)
    first: list[Insn] = []
    rest: list[list[Insn]] = []
    for c in chunks:
        if any(i.addr == entry for i in c):
            first = [i for i in c if i.addr >= entry]
            below = [i for i in c if i.addr < entry]
            if below:
                rest.append(below)
        else:
            rest.append(c)
    ordered = ([first] if first else []) + sorted(rest, key=lambda c: c[0].addr)
    lines = [f"; {fid}"]
    prev: list[Insn] | None = None
    for c in ordered:
        if prev is not None:
            prev_end = max(i.end for i in prev)
            overlap = prev[0].addr < c[0].addr < prev_end
            lines.append("; overlap: next instruction starts inside the previous one" if overlap else "; ...")
        if owners is not None:
            sharers = sorted(set().union(*(owners.get((i.space, i.addr), set()) for i in c)) - {fid})
            if sharers:
                more = len(sharers) - MAX_SHARERS
                lines.append("; shared with " + ", ".join(sharers[:MAX_SHARERS]) + (f" ({more} more)" if more > 0 else ""))
        for i in c:
            lines.append(f"{i.addr:04x}  {i.raw.hex():<12}  {i.text}")
            if i.addr in d.tables:
                lines.append(f"; {d.tables[i.addr].describe()}")
        prev = c
    return "\n".join(lines) + "\n"


def _condition(dec: Decoder, d: Descent, preds, jcc_addr: int, direction: str) -> dict:
    jcc = d.insns[jcc_addr]
    setter = flag_setter(dec, d, jcc, preds)
    expr = jcc.text + (f" after {setter.text}" if setter else "")
    return {"direction": direction, "expression": expr, "offset": nid(jcc.space, jcc.addr)}


def site_conditions(dec: Decoder, d: Descent, addr: int, cd: dict | None = None, preds: dict | None = None) -> list[dict]:
    """The branches deciding whether the instruction at `addr` runs (`cd`/`preds`: precomputed for `d`)."""
    cd = control_dependence(d) if cd is None else cd
    preds = straight_preds(d) if preds is None else preds
    return [_condition(dec, d, preds, j, lab) for j, lab in cd.get(addr, [])]


def build_graph(prog: Program, dec: Decoder, an: Analysis) -> dict:
    """One program's part of a tree: nodes, edges, aliases and counts (combine() merges the parts of a game)."""
    nodes: dict[str, dict] = {}
    edges: list[dict] = []
    functions = sorted(an.descents)
    for fid in functions:
        space, addr = split_id(fid)
        sp = prog.spaces[space]
        kinds = an.root_kinds.get(fid, set())
        nodes[fid] = {
            "id": fid,
            "kind": "function",
            "space": space,
            "address": addr,
            "file_offset": None if sp.file_base is None else sp.file_base + addr,
            "source_file": sp.source_file,
            "listing": listing_path(prog, fid),
            "entrypoint": bool(kinds & ENTRY_KINDS),
            "provisional": an.provisional(fid),
            "evidence": _evidence(an, fid),
        }
    resolved = {(r.use.fid, r.use.ins.addr): r for r in an.resolved}
    for fid in functions:
        d = an.descents[fid]
        cd = control_dependence(d)
        preds = straight_preds(d)
        rows: dict[tuple[int, str], dict] = {}

        def add(ins: Insn, target: str, returns: bool, extra: dict | None = None) -> None:
            if (ins.addr, target) in rows:
                return
            if target.startswith("unknown:") and target not in nodes:
                nodes[target] = {"id": target, "kind": "unknown-target", "space": None, "address": None,
                                 "file_offset": None, "source_file": None, "listing": None, "entrypoint": False,
                                 "reason": (extra or {}).pop("reason", None) or "not traced"}
            rows[(ins.addr, target)] = {
                "conditions": site_conditions(dec, d, ins.addr, cd, preds),
                "instruction": ins.text,
                "instruction_offset": nid(ins.space, ins.addr),
                "returns": returns,
                "source": fid,
                "target": target,
                **{k: v for k, v in (extra or {}).items() if k != "reason"},
            }

        def function_or_unknown(ins: Insn, tgt: str | None) -> str:
            return tgt if tgt in nodes and nodes[tgt]["kind"] == "function" else unknown_id(ins)

        for ins, tgt, _how in d.calls:
            target = function_or_unknown(ins, tgt)
            add(ins, target, target not in an.noreturn)
        # tail jumps, and falling off the end of the code into another function's start (the site is
        # then the last instruction executed before the boundary)
        for ins, tgt, _how in d.tails:
            add(ins, function_or_unknown(ins, tgt), False)
        for ins in d.indirect:
            r = resolved[(fid, ins.addr)]  # pointers.collect walks every instruction of every function
            back = ins.kind == "icall" or ins.addr in d.cont
            hit = False
            for t in r.targets:
                if t.node in nodes and nodes[t.node]["kind"] == "function":
                    extra = {"through": r.use.through, **({"provisional": True} if t.provisional else {})}
                    add(ins, t.node, back and t.node not in an.noreturn, extra)
                    hit = True
            if not hit or r.reason:
                add(ins, unknown_id(ins), back, {"reason": _unknown_reason(d, ins, r), "through": r.use.through})
        edges.extend(rows[k] for k in sorted(rows))
    unknown = sum(1 for n in nodes.values() if n["kind"] == "unknown-target")
    counts = {
        "nodes": len(nodes),
        "edges": len(edges),
        "functions": len(functions),
        "unknown_targets": unknown,
        "overlay_entries": len(prog.overlay_entry_ids()),
        "address_taken_functions": sum(1 for f in functions if "address-taken" in an.root_kinds.get(f, set())),
        "pointer_target_functions": sum(1 for f in functions if "pointer-target" in an.root_kinds.get(f, set())),
        "provisional_functions": sum(1 for f in functions if an.provisional(f)),
        "indirect_sites": len({e["instruction_offset"] for e in edges if "through" in e or e["target"].startswith("unknown:")}),
        "resolved_indirect_sites": len({e["instruction_offset"] for e in edges if "through" in e and not e["target"].startswith("unknown:")}),
        "entrypoints": sum(1 for n in nodes.values() if n["entrypoint"]),
        "conditional_edges": sum(1 for e in edges if e["conditions"]),
        "returning_edges": sum(1 for e in edges if e["returns"]),
        "nonreturning_edges": sum(1 for e in edges if not e["returns"]),
        "noreturn_functions": len(an.noreturn),
    }
    return {
        "counts": counts,
        "nodes": nodes,
        "edges": edges,
        "aliases": prog.aliases(),
    }


def frames(prog: Program) -> list[dict]:
    """How the code itself writes addresses of each file: unrelocated far calls (MZ only) and offsets in a space."""
    exe = prog.exe_name
    out = {
        "MZ": [{"form": "seg", "file": exe, "base": 0, "label": "unrelocated segment:offset (far calls as the code writes them)"},
               {"form": "flat", "file": exe, "base": 0, "label": "offset in load image"}],
        "COM": [{"form": "flat", "file": exe, "base": 0, "label": "offset in the .COM's segment (the file starts at 100h)"}],
        "module": [{"form": "flat", "file": exe, "base": 0, "label": "offset in the loaded module"}],
    }[prog.mz.layout.split(" ")[0]]
    if prog.ovr_name:
        out.append({"form": "flat", "file": prog.ovr_name, "base": 0, "label": "offset in overlay"})
    return out


def combine(parts: list[dict], files: dict[str, str], frame_list: list[dict], programs: dict[str, list[str]]) -> dict:
    """A game's tree from its programs' parts. Space names are file names, so ids cannot collide; two programs
    giving one far-call alias different targets would make the alias meaningless, so that aborts. `programs` maps
    each program file to the files its code comes from (itself and its overlay file)."""
    nodes: dict[str, dict] = {}
    edges: list[dict] = []
    aliases: dict[str, str] = {}
    counts: collections.Counter = collections.Counter()
    for part in parts:
        nodes.update(part["nodes"])
        edges.extend(part["edges"])
        counts.update(part["counts"])
        for k, v in part["aliases"].items():
            if aliases.setdefault(k, v) != v:
                raise FormatError(f"far-call alias {k} means {aliases[k]} in one program and {v} in another")
    return {
        "scope": SCOPE,
        "provenance": {
            "generator": GENERATOR,
            "generated_at": _dt.datetime.now(_dt.timezone.utc).replace(microsecond=0).isoformat(),
            "files": dict(sorted(files.items())),
        },
        "frames": frame_list,
        "programs": programs,
        "counts": dict(counts),
        "nodes": dict(sorted(nodes.items())),
        "edges": edges,
        "aliases": dict(sorted(aliases.items())),
    }


def diagnostics(prog: Program, an: Analysis) -> dict:
    hazards = []
    seen = set()
    for d in an.descents.values():
        for h in d.hazards:
            key = (h["kind"], h["space"], h["addr"])
            if key not in seen:
                seen.add(key)
                hazards.append({**h, "addr": f"{h['addr']:04x}"})
    return {
        "noreturn_functions": sorted(an.noreturn),
        "root_kinds": {k: sorted(v) for k, v in sorted(an.root_kinds.items()) if k in an.descents},
        "address_taken_evidence": {k: v for k, v in sorted(an.address_taken.items())},
        "pointer_proof": {k: v for k, v in sorted(an.proof.items())},
        "rejected_pointer_candidates": {k: v for k, v in sorted(an.rejected_pointers.items())},
        "pointer_loads": sorted(f"{pointers.describe_load(p)} -> {p.target or 'outside the program'}" for p in an.loads),
        "indirect_transfers": {
            f"{r.use.fid} @ {nid(r.use.ins.space, r.use.ins.addr)}": {
                "instruction": r.use.ins.text,
                "through": r.use.through,
                "targets": [{"node": t.node, "evidence": t.evidence, "provisional": t.provisional} for t in r.targets],
                "unknown": r.reason,
            }
            for r in sorted(an.resolved, key=lambda r: (r.use.fid, r.use.ins.addr))
        },
        "sentinel_stubs": sorted(nid(prog.root, s) for s in prog.sentinel_stubs),
        "jump_tables": {nid(split_id(fid)[0], site): t.describe() for fid, d in sorted(an.descents.items()) for site, t in sorted(d.tables.items())},
        "hazard_counts": dict(collections.Counter(h["kind"] for h in hazards)),
        "hazards": hazards,
    }


README = """\
# Generated call graph

Built by `{generator}` from the original binaries only (no names, no interpretation): every program of the
game directory in one tree.

| File | Loaded as | SHA-256 |
| --- | --- | --- |
{files}

## Method

0. **Inventory.** Every `.EXE`, `.COM` and `.DRV` in the game directory is a program, loaded the way DOS (or
   the program reading it) loads it: a file starting `MZ` by its MZ header (an EXEPACK-packed image is
   unpacked first; its code then has no file offset); any other `.COM` at offset 100h of its segment,
   entry 100h; anything else (`.DRV`) as a module read into memory at offset 0, whose entries are offset 0
   and every slot of a leading run of `jmp near` instructions. Each `.OVR` belongs to the one program whose
   overlay stub chain it tiles. Bytes after an MZ load image are data the program may read (listed above),
   not code, unless they are RTLink/Plus overlay sections (step 1). A layout this tool cannot parse aborts the build.
1. **Address spaces.** Every space is named after the file its bytes come from (`MAIN.EXE` →
   `MAIN_EXE`; `MAIN_EXE:XXXX` = offset in the loaded image). The MZ header gives the load image, its
   relocation table and the entry point. Every paragraph of the image that starts with an INT 3Fh
   stub-segment header (`CD 3F 00 00`, 16 zero bytes at +10h) is an overlay stub segment; the
   backward-linked chain of those headers must tile the `.OVR` file (Turbo Pascal 5: signature `TPOV`;
   Turbo Pascal 6: `FBOV` and a dword size of the rest; then each overlay's code and fixup words in chain
   order). Each overlay is a space `MAIN_OVR-SSSS`, ids
   `MAIN_OVR-SSSS:YYYY`: SSSS is the overlay's stub segment, the segment other code writes in its far
   calls (`lcall 0xSSSS, <stub entry>`), and YYYY the offset in the overlay's code, as its listing lines
   and jumps show it. The stub entry in such a call selects a slot of the stub table, which jumps to the
   function; it is not an address in the overlay (`aliases` maps each entry to its function). Any
   deviation from this layout aborts the build. An RTLink/Plus program (`.RTLink` in its image) appends its
   overlay sections to the EXE: the loader's section table (count, then 18-byte entries: load segment, file
   paragraph, flags, size, fixups, parent) must tile the appended data; each code section is a space
   `TOOL_EXE-NNNN` (NNNN = the section index its stubs carry; offsets from its load segment, so a section with
   several segments counts across them), reached through the 10-byte stubs `call <manager>; jmp far seg:off;
   dw section` in the resident image; the data section (DGROUP) is not code. A far call from section code
   means its own section, then its ancestors (loaded with it), then the resident image. Code a program reads from
   a data file and calls (step 7) is a program too. Each program is analysed on its own (steps 2-5); step 6 links
   the programs.
2. **Functions.** Recursive descent (capstone, 16-bit) from each program's entry and module entries, every overlay entry
   (stub payload; `FFFF` sentinel stubs ignored), every direct call target (far calls through stubs
   resolved to the module entry), every far/cross-space jump target, every target of a resolved indirect
   transfer and every installed interrupt handler (step 3), and validated pointer guesses (step 3).
   Conditional and unconditional jumps are followed; descent stops at `ret`/`retf`/`iret`, DOS exits,
   indirect jumps, jumps to another function's start (tail jumps) and at falling through into another
   function's start. `push cs; push x3; retf` is treated as an indirect call. A jump target that is not a
   call target is part of every function that jumps to it (shared tails appear in each such listing). A
   near jump through a word table (`jmp word ptr cs:[bx + T]`, or DS-relative where that segment's own
   code loads DS with it) is followed into every entry when the straight-line path before it bounds the
   index (unsigned `cmp` + `jcc` guards and the usual index arithmetic, on a path nothing else enters);
   the cases are part of the function. Other indirect jumps stay unresolved (`analysis.json` says why).
3. **Pointers.** Each function is walked as dataflow (per-path states up to 8 ways into a point, joined at
   loop heads) tracking constants, segments (relocated words, CS, DGROUP = the DS the startup code loads from a
   relocated segment word or from CS, plus any constant `add` in between: `mov ax, cs; add ax, 2b0h; mov ds, ax`),
   words read from memory, `les`/`lds` record pointers, the vector INT 21h/35h returns, and AH at every `int`
   (step 6). Every constant
   far pointer the code builds is recorded: stored as a dword (`mov [v], off` / `mov [v+2], seg`, or
   `stosw`), stored into a record field, pushed as an argument, handed to DOS as DS:DX (INT 21h/25h), or
   pushed for `retf`. An indirect call or jump through a variable resolves to the constant pointers stored
   in it (following copies between variables); through `[index + T]` to the run of entries stored at
   T, T+4, ... (or T+2 for near tables); through a record field (`es:[di + k]` with ES:DI from `les`) to
   whatever is stored into field k of any record (provisional: matched by offset only). Those targets, and
   installed interrupt handlers, are proven functions. A built pointer nothing is seen calling through is
   a guess: its target becomes a provisional function only if it decodes as a self-contained 8086
   procedure (clean flow, a terminator, no zero fill, no Pascal string at the start, no contact with
   already-decoded code); a guess never splits an existing listing. A plain `mov`/`push` immediate that is
   the first byte of an unreached run is the same kind of guess.
4. **Non-returning functions** are a fixpoint: no reachable return, no unresolved indirect jump, only tail
   transfers to non-returning functions. Calls to them have `returns: false` and nothing after them is
   decoded.
5. **Conditions** are direct control dependence (post-dominator based) of the site on the function's
   conditional jumps: the innermost branches deciding whether the site executes (several entries can be
   alternatives when different branches lead to the same block). `expression` is the jump plus the
   nearest preceding instruction on the single-predecessor path that writes a flag the jump tests (or a
   call, whose callee sets the flags).
6. **Links between programs** (edges with `link`, `returns: true`):
   * `interrupt`: an `int n` site → each handler another program installs for vector n before it terminates and
     stays resident (INT 27h, or INT 21h/31h). A handler counts when installed with INT 21h/25h from a tracked
     DS:DX, or (`provisional`) through a hook record: the vector number stored in the word before a stored far
     pointer to the handler. A program installing vector n itself is not linked for n (its `int n` chains to
     whatever was installed before). Several resident programs installing n are alternatives: the one the player runs.
   * `runs` / `loads`: a function builds a pointer to a string constant (a far pointer, or a near `mov`/`push`
     offset into DGROUP) holding the exact name of another program of the game (Pascal or C string, any path);
     `runs` when the function reaches DOS exec (INT 21h AH=4Bh) through calls, else `loads` when it reaches DOS
     open (AH=3Dh): the program reads the file (a loader, or a copy as a sound driver is installed). The site is
     the instruction loading the string's offset; the target the program's entry.
   * Batch files: each `.BAT` is a function node `<NAME>_BAT:0000` whose listing is its lines (address = line
     number). A line whose command is a program or batch file of the game (COMMAND.COM's search order .COM,
     .EXE, .BAT) `runs` it; conditions are the line's `if`s and every earlier `if ... goto` that jumps past it
     (`skipped when ...`). Internal commands and drive changes are skipped; any other command is an unknown target
     whose reason says it is not in the game directory, and which programs name it (files made at run time).
7. **Code loaded from data files** (a manifest, `loaded_modules.json`, checked against the bytes):
   the sound drivers or overlays some programs keep inside a container file such as `SOUND.PAK`. The manifest
   names, for each container, a reader plugin (a Python file defining `records(data, name)`) that unpacks its
   records, so the generator itself knows no container format. The program reads a record into a
   heap block, turns the block's address into a far pointer (`seg-10h:0100` for a record linked for 100h,
   `seg:0000` for one starting with a `jmp` table) and calls through that variable. Each declared record is a
   program `<FILE>-<record>` (`SOUND.PAK-0001`, space `SOUND_PAK-0001`, no file offsets since the bytes are
   unpacked); every far call through the declared variable has an edge to the record's entry whose `through`
   names the record and the evidence (the loader, the setup, the calls). Several records behind one variable
   are alternatives: the player's configuration picks one.

## Schema (`callgraph.json`)

- `nodes`: id -> `{{id, kind: function|unknown-target, space, address, file_offset, source_file, listing,
  entrypoint}}`, plus on functions `provisional` (true: no call or jump to it is proven, it exists because
  its address is built somewhere) and `evidence` (the transfers that prove it and where its address is
  built, up to 4 lines), and on unknown targets `reason` (why the site has no function target, or not only
  function targets). `entrypoint` is true for program and module entries, overlay entries, interrupt handlers,
  code reached through a pointer and batch files.
- `edges`: `{{source, target, instruction, instruction_offset, returns, conditions[{{offset, direction,
  expression}}]}}`; `instruction` is capstone text of the bytes at `instruction_offset`. Edges are calls,
  tail jumps, falling through into another function (site = last instruction before the boundary,
  `returns: false`) and indirect transfers. An indirect transfer has an edge to every function it was
  resolved to and, when (part of) it stays unresolved, one to `unknown:<space>:<site>`; its edges carry
  `through` (what it read: `ds:[6a78]`, `ds:[index+6786]`, `field +18h of a record`) and `provisional:
  true` on record-field matches. Edges between programs carry `link` (`runs`, `loads`, `interrupt`: step 6)
  and a `through` sentence giving the evidence.
- `aliases`: unrelocated stub `SSSS:OOOO` and `MAIN_EXE:XXXX` stub address -> overlay entry node.
- `frames`: how the code writes addresses (`seg` = segment*16+offset minus `base`, `flat` = offset
  minus `base`), per source file.
- `programs`: program or batch file -> the files its code comes from (the program and its overlay file; a loaded
  record names itself, `SOUND.PAK-0001`, the files table says which file holds it); every
  node's `source_file` is in exactly one of them.
- `counts`, `provenance`, `scope`.

`analysis.json` holds diagnostics (non-returning set, pointer proof and guess evidence, rejected pointer
candidates, every constant far pointer built, every indirect transfer with its targets and why the rest
is unknown, data-in-code hazards); it is not part of the graph contract.

Listings: `units/<file name, . as _>/functions/<id with : as _>.asm`, one line per reachable instruction
(`XXXX  bytes  text`). The chunk starting at the function's entry comes first, the remaining chunks
follow in address order, `; ...` separates non-contiguous chunks, and a chunk that other functions
also reach (shared tails) is preceded by `; shared with <id>, ... (N more)`. A resolved jump table is
described on the line after its jump: `; jump table cs:00cd, index 0x0..0xa step 2 (6 entries): <targets>`.
"""


def files_table(progs: list[Program], hashes: dict[str, str], scripts: tuple[str, ...] = ()) -> str:
    rows = []
    for p in progs:
        extra = f"; {p.mz.appended} bytes appended after the load image" if p.mz.appended else ""
        if p.section_list:
            extra = f"; RTLink/Plus overlays appended ({len(p.sections)} code sections, {len(p.section_list) - len(p.sections)} data)"
        if p.loaded_from:
            extra = f"; {p.loaded_from}"
        rows.append(f"| {p.exe_name} | {p.mz.layout}{extra} | `{hashes[p.exe_name]}` |")
        if p.ovr_name:
            rows.append(f"| {p.ovr_name} | Turbo Pascal overlays of {p.exe_name} ({len(p.blocks)}) | `{hashes[p.ovr_name]}` |")
    rows += [f"| {name} | batch file (links: `runs` per line) | `{hashes[name]}` |" for name in scripts]
    return "\n".join(rows)


def write_tree(out: Path, programs: list[tuple[Program, Analysis]], graph: dict, diag: dict, scripts: tuple = ()) -> tuple[int, int]:
    """The tree's files. `scripts`: batch files (links.Script: name, listing path, render())."""
    import json

    nav = out / "navigation"
    nav.mkdir(parents=True, exist_ok=True)
    (nav / "callgraph.json").write_text(json.dumps(graph, indent=1) + "\n")
    (nav / "analysis.json").write_text(json.dumps(diag, indent=1) + "\n")
    p = graph["provenance"]
    (nav / "README.md").write_text(README.format(
        generator=p["generator"],
        files=files_table([prog for prog, _an in programs], p["files"], tuple(s.name for s in scripts))))
    count = size = 0
    written = set()
    for prog, an in programs:
        owners = instruction_owners(an)
        for fid, d in an.descents.items():
            path = out / listing_path(prog, fid)
            path.parent.mkdir(parents=True, exist_ok=True)
            text = render_listing(fid, d, owners)
            path.write_text(text)
            written.add(path)
            count += 1
            size += len(text.encode())
    for s in scripts:
        path = out / s.listing
        path.parent.mkdir(parents=True, exist_ok=True)
        text = s.render()
        path.write_text(text)
        written.add(path)
        count += 1
        size += len(text.encode())
    for unit in (out / "units").glob("*/functions/*.asm"):
        if unit not in written:
            unit.unlink()
    return count, size
