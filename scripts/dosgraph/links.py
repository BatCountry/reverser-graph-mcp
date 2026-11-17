"""Links between the programs of one game, and the batch files that run them.

* `interrupt`: an `int n` site in one program and the handler another program installs for vector n before it
  terminates and stays resident (INT 27h, or INT 21h/31h). Handlers count when the program installs them with
  INT 21h/25h from a tracked DS:DX, or (provisional) through a hook record: the vector number stored in the word
  before a stored far pointer to the handler (a sound driver may pass such records to a routine that
  installs them). A program that installs vector n itself is not linked for n: its own `int n` reaches whatever
  handler was there before it (it chains). Every resident program installing n is a target: the game runs whichever
  one the player configured.
* `runs` / `loads`: a function names another program of the game in a string constant (a far pointer the code
  builds, or a near offset into DGROUP), and reaches DOS exec (INT 21h AH=4Bh: runs) or else DOS open (AH=3Dh:
  loads; the program reads the file: a loader such as LOADER.EXE reading DRIVER.COM, or a setup program
  installing a sound driver as a copy named DRIVER.EXE).
* batch files: each `.BAT` is a node; a line whose command is a program or batch file of the game `runs` it, under
  the line's `if` and the `if ... goto` lines that skip it. A command that is not in the game directory is an unknown
  target that says so (and which program names it, if one does: files made at run time).
"""

from __future__ import annotations

import collections
import re
from dataclasses import dataclass

from . import pointers
from .binary import Program, file_space, nid, split_id
from .emit import instruction_owners, site_conditions
from .flow import Analysis
from .x86 import Decoder

DOS_EXEC, DOS_OPEN, DOS_KEEP = 0x4B, 0x3D, 0x31
TSR_INT = 0x27
NAME_MAX = 127  # longest string read as a file name
PRINTABLE = set(range(0x21, 0x7F))


@dataclass
class Part:
    """One analysed program."""

    prog: Program
    dec: Decoder
    an: Analysis


# ------------------------------------------------------------------ evidence inside one program


def int_sites(an: Analysis) -> dict[str, tuple[int, set[int | None]]]:
    """`int n` site -> (n, the AH values the dataflow saw there; None = not a constant on some path)."""
    out: dict[str, tuple[int, set[int | None]]] = {}
    for site, n, ah in an.facts.ints:
        out.setdefault(site, (n, set()))[1].add(ah)
    return out


def dos_sites(an: Analysis, ah: int) -> set[str]:
    return {site for site, (n, ahs) in int_sites(an).items() if n == 0x21 and ah in ahs}


def resident(an: Analysis) -> str | None:
    """The first site where the program terminates and stays resident, or None."""
    sites = sorted(s for s, (n, ahs) in int_sites(an).items() if n == TSR_INT or (n == 0x21 and DOS_KEEP in ahs))
    return sites[0] if sites else None


def installs(an: Analysis) -> dict[int, list[tuple[str, str, bool]]]:
    """vector -> (handler, evidence, provisional) for the handlers the program installs."""
    out: dict[int, list[tuple[str, str, bool]]] = collections.defaultdict(list)
    seen = set()
    for tgt, n, site in an.facts.vectors:
        if tgt in an.descents and (n, tgt) not in seen:
            seen.add((n, tgt))
            out[n].append((tgt, f"installed with INT 21h/25h at {site}", False))
    numbers: dict[tuple, list[tuple[int, str]]] = collections.defaultdict(list)
    for s in an.facts.stores:
        if s.where[0] == "abs" and isinstance(s.value, pointers.Const) and s.value.n <= 0xFF:
            numbers[s.where].append((s.value.n, s.site))
    for p in an.facts.loads:
        if p.where[0] != "abs" or p.target not in an.descents:
            continue
        record = ("abs", p.where[1], (p.where[2] - 2) & 0xFFFF)
        for n, site in numbers.get(record, []):
            if (n, p.target) not in seen:
                seen.add((n, p.target))
                out[n].append((p.target, f"hook record [{record[2]:04x}]: vector {n:02X}h stored at {site}, "
                                         f"the handler's far pointer at {p.site}", True))
    return dict(out)


def adjacency(graph: dict) -> dict[str, set[str]]:
    """Function -> the functions it calls or jumps to (link edges excluded)."""
    out: dict[str, set[str]] = collections.defaultdict(set)
    for e in graph["edges"]:
        if "link" not in e:
            out[e["source"]].add(e["target"])
    return out


def closure(adj: dict[str, set[str]], start: str) -> set[str]:
    """`start` and every function it reaches."""
    seen, todo = {start}, [start]
    while todo:
        for t in adj.get(todo.pop(), set()) - seen:
            seen.add(t)
            todo.append(t)
    return seen


def string_at(data: bytes, off: int) -> list[str]:
    """The texts a string constant at `off` may hold: a Pascal string (length byte) and/or a C string (to NUL)."""
    out = []
    if 0 <= off < len(data):
        n = data[off]
        body = data[off + 1:off + 1 + n]
        if 1 <= n <= NAME_MAX and len(body) == n and all(b in PRINTABLE for b in body):
            out.append(body.decode("ascii"))
        end = data.find(b"\0", off, off + NAME_MAX + 1)
        if end > off and all(b in PRINTABLE for b in data[off:end]):
            out.append(data[off:end].decode("ascii"))
    return out


def file_name(text: str) -> str:
    """`C:\\APP\\loader.exe` -> `LOADER.EXE`."""
    return re.split(r"[\\/:]", text)[-1].upper()


def name_references(part: Part) -> list[tuple[str, str, str]]:
    """(function, site, file name) for every string constant a function points at: far pointers the code builds,
    and near `mov r16, imm` / `push imm` offsets into DGROUP."""
    prog, an = part.prog, part.an
    owners = instruction_owners(an)
    found: list[tuple[str, str, str]] = []

    def check(site: str, target: str | None) -> None:
        if target is None:
            return
        space, off = split_id(target)
        sp, at = split_id(site)
        for text in string_at(prog.spaces[space].data, off):
            for fid in sorted(owners.get((sp, at), ())):
                found.append((fid, site, file_name(text)))

    for p in an.facts.loads:
        check(p.off_site, pointers.far_target(prog, p.seg, p.off, an.dgroup))  # the site a near offset would have
    if an.dgroup is not None:
        for d in an.descents.values():
            for ins in d.insns.values():
                ops = [o.strip() for o in ins.op_str.split(",")] if ins.op_str else []
                if ins.mnemonic in ("mov", "push") and ops and pointers.NUM.match(ops[-1]) and (ins.mnemonic == "push" or ops[0] in pointers.R16):
                    check(nid(ins.space, ins.addr), pointers.far_target(prog, pointers.DGROUP, int(ops[-1], 0), an.dgroup))
    return sorted(set(found))


# ------------------------------------------------------------------ edges between programs


def _edge(part: Part, fid: str, site: str, target: str, link: str, through: str, provisional: bool = False) -> dict:
    d = part.an.descents[fid]
    addr = split_id(site)[1]
    return {
        "conditions": site_conditions(part.dec, d, addr),
        "instruction": d.insns[addr].text,
        "instruction_offset": site,
        "returns": True,
        "source": fid,
        "target": target,
        "link": link,
        "through": through,
        **({"provisional": True} if provisional else {}),
    }


def interrupt_edges(parts: list[Part]) -> list[dict]:
    supply: dict[int, list[tuple[Part, str, str, bool, str]]] = collections.defaultdict(list)
    own: dict[str, set[int]] = {}
    for part in parts:
        inst = installs(part.an)
        own[part.prog.exe_name] = set(inst)
        tsr = resident(part.an)
        if tsr is None:
            continue
        for n, handlers in inst.items():
            for handler, evidence, provisional in handlers:
                supply[n].append((part, handler, evidence, provisional, tsr))
    edges = []
    for part in parts:
        owners = instruction_owners(part.an)
        for site, (n, _ahs) in sorted(int_sites(part.an).items()):
            others = [s for s in supply.get(n, []) if s[0] is not part]
            if not others or n in own[part.prog.exe_name]:
                continue
            names = sorted({s[0].prog.exe_name for s in others})
            choice = f"; {len(names)} resident programs install it ({', '.join(names)}): the one the player runs" if len(names) > 1 else ""
            for fid in sorted(owners[split_id(site)]):
                for q, handler, evidence, provisional, tsr in others:
                    through = (f"INT {n:02X}h, handled by {q.prog.exe_name} once it is resident ({evidence}; stays "
                               f"resident at {tsr}){choice}")
                    edges.append(_edge(part, fid, site, handler, "interrupt", through, provisional))
    return edges


def program_edges(parts: list[Part], graph: dict) -> list[dict]:
    """`runs` / `loads` edges from functions naming another program's file."""
    by_name = {p.prog.exe_name: p for p in parts}
    adj = adjacency(graph)
    edges = []
    for part in parts:
        an = part.an
        owners = instruction_owners(an)
        execs = {f for s in dos_sites(an, DOS_EXEC) for f in owners[split_id(s)]}
        opens = {f for s in dos_sites(an, DOS_OPEN) for f in owners[split_id(s)]}
        for fid, site, name in name_references(part):
            target = by_name.get(name)
            if target is None or target is part:
                continue
            reach = closure(adj, fid)
            if reach & execs:
                link, how = "runs", "DOS exec (INT 21h/4Bh)"
            elif reach & opens:
                link, how = "loads", "DOS open (INT 21h/3Dh), not exec: the program reads the file"
            else:
                continue
            through = f"the string {name.lower()} built at {site}; {fid} reaches {how}"
            edges.append(_edge(part, fid, site, target.prog.entry_id, link, through))
    return edges


# ------------------------------------------------------------------ batch files

INTERNAL = {
    "break", "call", "cd", "chdir", "cls", "copy", "ctty", "date", "del", "dir", "echo", "erase", "exit", "for",
    "goto", "md", "mkdir", "path", "pause", "prompt", "rd", "rem", "ren", "rename", "rmdir", "set", "shift", "time",
    "type", "ver", "verify", "vol",
}
DRIVE = re.compile(r"^[A-Za-z%0-9]+:$")
NAME_END = re.compile(r"[.\\/+=;,]")  # COMMAND.COM ends an internal command's name here: `cd..`, `echo.`, `cd\save`
REDIRECT = re.compile(r"(?:>>?|<)\s*[^\s<>]*")  # `>nul`, `> nul`, `>>log`, `<keys`, also glued: `tool>nul`
SEARCH = (".COM", ".EXE", ".BAT")  # COMMAND.COM's order for a command without extension


@dataclass
class Script:
    name: str  # MAIN.BAT
    data: bytes

    @property
    def lines(self) -> list[str]:
        """The lines COMMAND.COM reads: CP437 text up to the first ^Z (end of file)."""
        return self.data.split(b"\x1a", 1)[0].decode("cp437").splitlines()

    @property
    def space(self) -> str:
        return file_space(self.name)

    @property
    def node_id(self) -> str:
        return nid(self.space, 0)

    @property
    def listing(self) -> str:
        return f"units/{self.space.lower()}/functions/{self.node_id.replace(':', '_')}.asm"

    def render(self) -> str:
        """Listing: line number (hex, the `address` edges use) and the line as written."""
        return "\n".join([f"; {self.node_id} (batch file; addresses are line numbers)"]
                         + [f"{i:04x}  {'':12}  {line}" for i, line in enumerate(self.lines, 1)]) + "\n"


def _if(tokens: list[str]) -> tuple[str | None, list[str]]:
    """Split one leading `if [not] cond` from a command: (condition text, rest). A comparison may have spaces
    around `==`, as COMMAND.COM allows: `a==b`, `a== b`, `a ==b`, `"%1" == "x"`."""
    if not tokens or tokens[0].lower() != "if":
        return None, tokens
    i = 1
    if len(tokens) > i and tokens[i].lower() == "not":
        i += 1
    if len(tokens) > i and tokens[i].lower() in ("exist", "errorlevel"):
        i += 2
    elif len(tokens) > i:
        text = tokens[i]
        i += 1
        if "==" not in text and len(tokens) > i and tokens[i].startswith("=="):
            text += tokens[i]
            i += 1
        if text.endswith("==") and len(tokens) > i:
            i += 1
    return " ".join(tokens[:i]), tokens[i:]


def batch_commands(script: Script) -> list[tuple[int, str, list[str], bool]]:
    """(line number, command, conditions, called) for each line running something other than an internal command.
    Conditions: the line's own `if`s, and `skipped when ...` for each earlier `if ... goto` jumping past it."""
    labels = {line.strip()[1:].split()[0].lower(): i for i, line in enumerate(script.lines, 1)
              if line.strip().startswith(":") and line.strip()[1:].split()}
    skips: list[tuple[int, int, str]] = []
    out = []
    for i, line in enumerate(script.lines, 1):
        for segment in line.strip().lstrip("@").split("|"):
            tokens = REDIRECT.sub(" ", segment).split()
            conds = []
            while True:
                cond, tokens = _if(tokens)
                if cond is None:
                    break
                conds.append(cond)
            if not tokens or tokens[0].startswith(":"):
                continue
            cmd = tokens[0].lower()
            if cmd == "goto" and len(tokens) > 1 and conds and labels.get(tokens[1].lower(), 0) > i:
                skips.append((i, labels[tokens[1].lower()], " ".join(conds) + f" goto {tokens[1]}"))
            called = cmd == "call" and len(tokens) > 1
            if called:
                tokens, cmd = tokens[1:], tokens[1].lower()
            if NAME_END.split(cmd, 1)[0] in INTERNAL or DRIVE.match(cmd):
                continue
            skipped = [f"skipped when {text} (line {g})" for g, end, text in skips if g < i < end]
            out.append((i, tokens[0], conds + skipped, called))
    return out


def script_part(script: Script, files: set[str], entries: dict[str, str], images: dict[str, bytes]) -> dict:
    """The batch file's node, its `runs` edges and unknown targets. `files`: every program and batch file of the game;
    `entries`: program -> entry id; `images`: program -> bytes (to find which program names a missing file)."""
    nodes = {script.node_id: {
        "id": script.node_id, "kind": "function", "space": script.space, "address": 0, "file_offset": 0,
        "source_file": script.name, "listing": script.listing, "entrypoint": True, "provisional": False,
        "evidence": ["batch file: COMMAND.COM runs it line by line"],
    }}
    edges = []
    for line, command, conds, called in batch_commands(script):
        base = file_name(command)
        candidates = [base] if "." in base else [base + s for s in SEARCH]
        found = next((c for c in candidates if c in files), None)
        site = nid(script.space, line)
        if found is not None:
            target = entries.get(found, nid(file_space(found), 0))
            returns = not found.endswith(".BAT") or called
        else:
            target = f"unknown:{site}"
            namers = sorted(p for p, data in images.items()
                            if any(re.search(re.escape(c).encode(), data, re.IGNORECASE) for c in candidates))
            where = (f"{', '.join(namers)} names it (made at run time)" if namers
                     else "a DOS command or a program installed elsewhere")
            nodes[target] = {"id": target, "kind": "unknown-target", "space": None, "address": None,
                             "file_offset": None, "source_file": None, "listing": None, "entrypoint": False,
                             "reason": f"no {' / '.join(candidates)} in the game directory: {where}"}
            returns = True
        edges.append({
            "conditions": [{"direction": "taken", "expression": c, "offset": site} for c in conds],
            "instruction": script.lines[line - 1].strip(),
            "instruction_offset": site,
            "returns": returns,
            "source": script.node_id,
            "target": target,
            "link": "runs",
            "through": "batch file line" + (" (CALL: returns to the batch file)" if called else ""),
        })
    return {"nodes": nodes, "edges": edges}


def link(parts: list[Part], scripts: list[Script], graph: dict) -> None:
    """Add every link edge (and the batch files' nodes) to a combined graph, with their counts. Edge counts
    (`edges`, `conditional_edges`, `returning_edges`, `nonreturning_edges`) cover every edge, link edges included;
    `functions` stays the programs' code functions: batch files are function nodes counted in `batch_files`."""
    edges = interrupt_edges(parts) + program_edges(parts, graph)
    files = {p.prog.exe_name for p in parts} | {s.name for s in scripts}
    entries = {p.prog.exe_name: p.prog.entry_id for p in parts}
    images = {p.prog.exe_name: p.prog.image for p in parts}
    nodes: dict[str, dict] = {}
    for s in scripts:
        sp = script_part(s, files, entries, images)
        nodes.update(sp["nodes"])
        edges += sp["edges"]
    graph["nodes"] = dict(sorted({**graph["nodes"], **nodes}.items()))
    graph["edges"] += edges
    counts = graph["counts"]
    counts["nodes"] = len(graph["nodes"])
    counts["edges"] = len(graph["edges"])
    counts["conditional_edges"] = sum(1 for e in graph["edges"] if e["conditions"])
    counts["returning_edges"] = sum(1 for e in graph["edges"] if e["returns"])
    counts["nonreturning_edges"] = sum(1 for e in graph["edges"] if not e["returns"])
    counts["unknown_targets"] = sum(1 for n in graph["nodes"].values() if n["kind"] == "unknown-target")
    counts["entrypoints"] = sum(1 for n in graph["nodes"].values() if n["entrypoint"])
    counts["batch_files"] = len(scripts)
    for kind in ("runs", "loads", "interrupt"):
        counts[f"{kind}_edges"] = sum(1 for e in edges if e["link"] == kind)
