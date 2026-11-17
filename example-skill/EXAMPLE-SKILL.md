---
name: example-reimplementation
description: "Translate the functions of <your target program> to C++ one work unit at a time, using that tree's *-progress-graph MCP server for every listing, call, interrupt and port lookup. Use for any implementation work in this repository."
---

<!--
This is an example agent skill for a reimplementation project built on reverser-progress-graph. Copy it into your
project (e.g. `.agents/skills/<name>/SKILL.md` or `.claude/skills/<name>/SKILL.md`), replace the <placeholders>,
fill in the server table, and delete this comment. The skill tells implementing agents how to use the server; the
"Setting it up" section at the end tells you how to build what it assumes.
-->

# <Target> C++ reimplementation

## First: check the MCP servers

This work runs entirely on the `*-progress-graph` MCP servers, one per tree (one tree per input directory). Each has
the tools `next_work`, `module`, `trace`, `add_implementation`, `annotate`, `interrupts`, `dos_port` and
`dos_memory_offset`, plus `disasm://` resources. Depending on the client they appear as
`mcp__<server name with _ for ->_<tool>` (e.g. `mcp__first_game_progress_graph_next_work`) or under another prefix.

Use the server of the tree you are working on. Node names (`MAIN_EXE:1a2c`) repeat across trees, so a name means
nothing without its server.

| Game                    | Input dir    | Tree           | MCP server name               |
|-------------------------|--------------|----------------|-------------------------------|
| <First game title>      | FIRST-GAME   | `first-game`   | first-game-progress-graph     |
| <Second game title>     | SECOND-GAME  | `second-game`  | second-game-progress-graph    |

Optional research servers compare one tree with another. They have every normal tool for the first tree plus
`counterpart` and `compare`:

| Comparison                   | MCP server name                |
|------------------------------|--------------------------------|
| first-game ↔ second-game     | first-game-second-game-compare |

**If the server for your tree is missing, stop now.** Tell the user: "the <name> MCP server is not loaded in this
session". Do not substitute anything for it: no reading or grepping the generated tree directly, no disassembling, no
writing code from memory or guesses, no using another tree's server instead. End your turn and wait for the user.

## What the job is

The disassembly is finished. Each tree holds every program in its input directory: the main program and its overlay
file (`MAIN.EXE` + `MAIN.OVR`), helper programs (a setup program, a launcher), resident drivers (`DRIVER.COM`),
loadable modules (`VIDEO.DRV`), and the batch files that start them (`START.BAT`). Every function has a listing decoded
from the original bytes, and every call that can be resolved goes to a named node. Your job is to read those listings
and write faithful C++ in `<implementation root>/`. You are not reverse engineering: never produce new disassembly,
never run a disassembler on the target's code, never write behavior documents or reports.

Reading bytes of the target's data files (archives, save files, data tables inside an EXE) with a small script is
fine when a function you are translating reads them.

## Node names

A node is named after the file its bytes are in, then the address its listing shows:

- `MAIN_EXE:1a2c`, `SETUP_EXE:0038`: offset in that program's loaded image. A `.COM` starts at `0100`; a `.DRV`
  module at `0000`.
- `MAIN_OVR-0041:0100`: overlay code. `0041` is the overlay's stub segment, the number other code writes in its far
  calls; `0100` is the offset inside the overlay. `lcall 0x41, 0x25` calls slot `0x25` of that overlay's stub table,
  not offset `0x25`: pass the whole instruction to `module` and it names the function.
- `TOOL_EXE-0003:07bb`: code in section 3 of an EXE with appended overlay sections (RTLink/Plus).
- `SOUND_PAK-0001:0100`: code the program reads from record 1 of a data file and calls (declared when the tree was
  built).
- `START_BAT:0000`: a batch file. Its listing is its lines, numbered.

If a progress note or `Implements:` comment uses a name `module` does not know, do not guess the new name: tell the
user.

## The loop

1. **Pick work:** call `next_work`. It returns one work unit (`work:<node>`): a function plus the small helpers only
   it uses. Every member is part of this job: implement them all together in one source file, starting with the
   callees ("callees first" is the order to write them in, not a list of prerequisites). A unit `next_work` offers as
   ready calls nothing outside itself that is still unimplemented.
2. **Read each member, callees first:** call `module` with the node name (e.g. `MAIN_OVR-0041:0100`,
   `MAIN_EXE:1a2c`). It gives the callers, callees and a link to the listing. Read the listing resource exactly as
   linked: `disasm://<tree>/listing/<id>` (id URL-encoded, e.g. `disasm://first-game/listing/MAIN_OVR-0041%3A0100`). The
   tree in the URI picks the server, so a link from one server reads that tree's listing even with every server
   loaded; never drop or change it. For a long listing you may read part of it by appending a line range: `:1-80`,
   then `:81-160`; the first line says which lines you got and how many there are.
3. **Follow calls by name:** every call or jump to another function ends with `; → <node>`, and code that runs on into
   the next function ends with `; ↓ falls through into <node>`. Pass that node name to `module`.
   `unresolved (indirect)` means the target is computed at run time: implement that call as a lookup in a table of
   function pointers keyed by the far address (seg:off) the program stores, register functions in it as they are
   implemented (`module` resolves a stored seg:off to its function), and make an address missing from the table fail
   visibly. That is implementable now; it is not a reason to defer the unit. When the call stays unresolved for a
   stated reason (e.g. it chains to the interrupt handler that was installed before), `module` says so and what to do
   instead.
4. **Calls into another program:** a line ending in `; ⇒ <how>: <node>` reaches another program, not a function of
   this one:
   - `interrupt`: an `int n` the program raises is answered by a resident program (a driver); every resident program
     that can answer it is listed, and the user's configuration decides which one is loaded.
   - `runs`: the program starts another one (DOS exec, or a batch-file line).
   - `loads`: the program reads another program's file (a loader reading its drivers or modules).
   These are boundaries. Implement this side's half: the interrupt API call, the process launch, the file read,
   behind an interface. Do not inline or reimplement the other program's code as part of this unit; it is its own
   work.
5. **Hardware and OS calls:** for `INT nn`, call `interrupts` with the interrupt and the registers loaded before it
   (`AH=0x3D`). For `IN`/`OUT`, call `dos_port`. For segment constants like `A000`, `B800`, `0040`, call
   `dos_memory_offset`. Numbers need a hex marker: `0x21` or `21h`.
6. **Same code elsewhere:** every program links its own copy of its compiler's runtime library, so many functions are
   byte-for-byte copies of others. `module` says so:
   - "Same code as X; implemented there as … : nothing to write here, call that implementation": the copy is already
     done. Call the existing C++ function.
   - "Same code as …: write it once and register it for any one of them": implement it once; the record covers every
     copy.
7. **Write the C++** in `<implementation root>/src` (headers in `<implementation root>/include`). Put an
   `/* Implements: work:MAIN_OVR-0041:0100 */` comment (or every member's node name) inside each function body.
   Build with `<your build command>`.
8. **Record it:** call `add_implementation` on the tree's server with `tree` (the tree name: `first-game`,
   `second-game`, …; `next_work` says which), the work unit id, the source file's basename (not a path: it is
   looked up under the implementation root), and the function name. It rejects the call, saying why, if the comment
   or function is missing, or if `tree` is not that server's tree: then you are on the wrong server, so nothing was
   recorded. Its reply names any same-code copies the record now covers.
9. **Partial progress:** if you learned something but cannot finish, call `annotate` on the node (with the same
   `tree`) so the next session sees it. Then call `next_work` again (`skip` passes over a unit you cannot do yet).

`trace` gives the call path between two functions with the branch conditions on the way; it follows links between
programs too (`START_BAT:0000 →[runs] SETUP_EXE:0038 →[runs] MAIN_EXE:…`). `module` also accepts addresses as
listings print them: `lcall 0x41, 0x25`, `3a0:0112`, or an address inside a function.

## Another game already did it

Games built on one engine share most of their code. Before writing a large routine for the second game, ask the
compare server (where one exists) for its `counterpart` in the first game: if the first game's function is
implemented and the code is the same or close, reuse or adapt it rather than starting over. Compare pairs programs
first (by shared code, never by file name), then functions within each program pair; its confidence (`same code`,
`strong`, `likely`, `weak`) says how far to trust a pair. A `weak` pair needs the diff read before you rely on it.
`reverser-copy-progress` can also carry implementation records across trees for units whose code is the same.

## Reviewing a worker's claims (orchestrators)

If a worker says a unit is blocked by unimplemented callees, or wants to defer it until some other function is done,
do not accept it. Make it check its work: call `next_work` with `module` set to the unit and read the Dependencies
section. For a unit offered as ready it says the unit calls nothing outside itself, or that every unit it calls is
complete. A "missing" callee listed under Members is part of the same unit and gets written in the same file. Calls
into other programs (`⇒` links) are never dependencies. The only targets the graph cannot name are calls through
run-time addresses, and those are implemented with a function-pointer table (above), not deferred.

## What not to trust

- Notes left by `annotate` and names in older code are hypotheses written by models; the listing wins every
  disagreement.
- The overlays of one overlay file share one address range, so a bare overlay address can match several functions;
  `module` lists the candidates. Use node names.
- Data between code is not in the listings. A function reading a table in a program's data segment reads bytes you
  load from the file.
- A function marked provisional exists because its address is built somewhere, not because a call to it was proven;
  `module` shows the evidence.

## Translation requirements

Within the work unit, translate every decoded branch, state read and write, call, return and cleanup convention,
native-width arithmetic operation, narrowing or wrapping behavior, and observable operation order. Do not omit a
branch because it looks unimportant.

Preserve the source machine's integer widths and signedness, wrap/narrowing, evaluation and update order, memory
aliasing, lifetime/state assumptions, call ordering, return conventions, and shared-routine reuse. Know the compiler
of the program you are in (list yours here):
- Turbo Pascal: strings are length-prefixed, procedures pop their own arguments (`RETF n`), overlays are called
  through INT 3Fh stubs.
- C (Turbo C / Borland C / Microsoft C): zero-terminated strings, the caller pops arguments (`add sp, n` after the
  call).
- Hand-written assembly (drivers, `.DRV` modules, resident programs): take conventions from the listing, not from
  either compiler.
Avoid undefined behavior or implementation-defined conversions when they would change a DOS result.

Keep calls into functions that are not implemented yet as declared functions with stubs that fail visibly, named
after their node. Do not invent their behavior. Do not discard surrounding translated code when a dependency can be
isolated; name the exact node or data that is missing and keep going.

## Tests and limits

Exercise the translated code: feasible branches, arithmetic boundaries, native-width behavior, operation order, and
return/state effects. Label synthetic expectations as such. A passing test shows agreement with that test, not
complete fidelity to the original program.

Do not guess at missing semantics or treat a call-graph path as proof that it runs. When an uncertainty blocks only
part of a work unit, isolate it and proceed with the rest.
