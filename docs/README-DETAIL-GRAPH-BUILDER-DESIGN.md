# The graph builder: design notes

`dosgraph` (`scripts/dosgraph/`, run by `scripts/build_callgraph.py`; usage in
[README-DETAIL-GRAPH-BUILDER.md](README-DETAIL-GRAPH-BUILDER.md)) turns a directory of 16-bit MS-DOS executables into
a navigable call graph: one JSON graph, one listing per function, and a README that explains how every edge was
derived. The MCP server in `src/` serves that tree to LLM clients (listings, callers/callees, call chains, work units,
progress). This document explains the choices behind the generator, where they are specific to real-mode DOS and to
Turbo Pascal-era toolchains, and what it would take to point the same design at ELF or 64-bit Windows binaries.

## What it produces

```
<tree>/
  navigation/callgraph.json   nodes, edges, programs, frames, aliases, counts, provenance
  navigation/analysis.json    per-program diagnostics: unresolved jumps and why, tables, non-returning functions
  navigation/data_references.json   per program, every instruction that names a memory location by its address
  navigation/frame_references.json  per function, every operand relative to BP in the stack segment
  navigation/control_flow.json      per function, its basic blocks and where each goes next
  navigation/README.md        the method, step by step, and the schema (written by emit.py, so it matches the code)
  units/<space>/functions/<SPACE>_<addr>.asm   one control-flow listing per function
```

A node id is `<SPACE>:<hex address>`. The space names the file the bytes come from (`MAIN_EXE`, an overlay
`MAIN_OVR-0020`, a record `SOUND_PAK-0001`), and the address is what the listing lines and the code's own jumps show.
Ids are stable across rebuilds as long as the bytes are, which is what lets progress records, annotations and
`/* Implements: … */` comments in a reimplementation refer to them.

## Principles

1. **The bytes are the only source of truth.** Every node and edge is derived from the files, never from another
   tool's output or a reader's interpretation. A disassembler's linear sweep, symbol guesses or decompiler output are
   not inputs. When outside knowledge is unavoidable (code a program loads from a data file, see `loaded.py`), it is
   declared in a separate file, every claim in it is checked against the bytes, and a declaration the bytes contradict
   aborts the build.
2. **Fail loudly, never half-read.** Every container parser (MZ, EXEPACK, overlay files, appended overlay sections,
   data containers) validates strictly and raises `FormatError` for anything it does not understand. A directory is
   built whole or not at all. A wrong pairing (an overlay file with the wrong program) cannot parse, so strict parsing
   doubles as the pairing test.
3. **Control flow, not linear sweep.** Functions are found by recursive descent from proven entries. Data is never
   decoded as code because something happened to look like an instruction. A function's listing holds the
   instructions its control flow reaches, in address order, so string bytes and padding never appear as jumps.
4. **Uniform rules, no special cases.** A rule must hold for every program it is applied to; an idiom is recognised by
   its semantics (a far pointer the code builds and keeps together), never by an address, a file name or a byte
   signature of one program. When a rule turns out wrong for one input, it is fixed for all inputs.
5. **Uncertainty is data.** Nothing is silently dropped or silently guessed:
   * an indirect transfer the analysis cannot resolve gets an edge to `unknown:<site>` whose `reason` says why
     (the previous interrupt handler, a value computed at run time, a register set by a caller);
   * a function that exists only because its address is built somewhere, and that no proven transfer reaches, is
     `provisional` and carries its `evidence`;
   * resolved indirect edges carry `through` (what was read: `ds:[6a78]`, `ds:[index+6786]`, a record field) and
     record-field matches are `provisional`;
   * every edge carries the branch `conditions` under which its site executes.
6. **Deterministic output.** The same inputs give the same tree byte for byte (apart from `generated_at`), so a test
   can require a checked tree to equal a fresh build.
7. **Built for small readers.** The consumer is often a weak model with a small attention budget. Listings are short
   and self-contained, every call line names its target node (`; → MAIN_OVR-0041:0100`), ids are readable, and the
   README states the method, so a reader can check a claim instead of trusting it.

## Pipeline

```
game.py     inventory: which files are programs, which overlay file belongs to which program, batch files
binary.py   loading: MZ header, relocations, .COM at 100h, modules at 0, INT 3Fh overlay stubs + .OVR,
            appended overlay sections (RTLink/Plus), appended overlay images (Microsoft LINK); address spaces and
            far-address resolution
exepack.py  unpack EXEPACK images before anything else looks at them
x86.py      capstone decoding (16-bit) and classification of control transfers
flow.py     recursive descent, function boundaries, non-returning fixpoint, control dependence
tables.py   near jump tables whose index the code bounds
pointers.py dataflow: constant far pointers, where they are stored, which indirect transfers read them
links.py    edges between programs of one directory: interrupts, exec, open; batch files
loaded.py   code read from data files at run time (declared, checked against the bytes)
emit.py     graph JSON, listings, README; write_tree writes the tree and removes listings a rebuild no longer makes
```

Each program is analysed on its own (steps 2-5 of the generated README), then the graphs are merged and linked.

### Loading and address spaces

A program contributes one space for its load image plus one per overlay module or overlay section. Spaces have a
`code_base` (where segment 0 of the image sits) so a far call `lcall seg, off` resolves to (space, offset) through the
relocation table: relocated segment words name image segments, unrelocated ones name overlay stub segments. Overlay
stubs are resolved to the overlay module entry they load, and the stub addresses become `aliases`. Microsoft LINK
writes no stubs: a call into an overlay is `int 3Fh; db segment number; dw offset` in place of the far call, decoded
as one five-byte call whose target comes from the segment table in the root's data (found as the one place in the
image that fits the appended overlays, never by address). An `int 3Fh` reached in a program whose overlays were not
parsed aborts the build, because the bytes behind it are call data and would otherwise be listed as instructions.
Unpacked bytes (EXEPACK, container records) have no file offset; nodes record `file_offset: null` instead of a wrong
number.

### Functions

Descent starts from the program entry, module jump-table entries, overlay entries, every direct call target, every
cross-space jump target, every resolved indirect target and every installed interrupt handler. It follows conditional
and unconditional jumps, stops at returns, DOS exits, indirect jumps, tail jumps into another function's start and at
falling into another function's start (recorded as an edge with `returns: false`). A jump target that is not a call
target belongs to every function that jumps to it, so shared tails appear in each listing. Non-returning functions
are a fixpoint (no reachable return, only tail transfers to non-returning functions); nothing after a call to one is
decoded.

### Jump tables

`jmp word ptr [seg:][bx|si|di + disp]` is followed into every entry only when a small abstract interpretation of the
straight-line path before it bounds the index (unsigned `cmp`/`jcc` guards and the arithmetic dispatch idioms use),
the path has no other entry, and every entry decodes in the same space. Otherwise the jump stays unresolved with a
reason. Cases join the function's listing rather than becoming nodes.

Two things widen "bounded by the code" without leaving it. Where the path leaves a loop that CX counts
(`mov cx, N; ...; loop`, one straight run nothing else enters), a 16-bit register every pass moves by the same
constant holds its N values: a compiler's `switch` over scattered values searches a value table this way and jumps
through the table behind it. The listing then pairs each value with its case, since the values are data no
instruction shows. And a DS-relative table is read from the code segment when code in that segment loads DS with it,
from a relocated segment word or from CS.

In the function's control flow a followed table jump leads to each case. Which entry is taken is not a branch the
graph can name, so a case carries the conditions of the jump itself.

### Pointers

Each function is walked as dataflow over 16-bit registers, DS/ES and the words pushed on the current run. Values are
constants, segments (relocated words, CS, DGROUP), words read from memory, halves of `les`/`lds` pointers and the
vector INT 21h/35h returns. Merge points keep up to 8 separate states and join at loop heads; a dataflow that does not
settle aborts the build. Every far pointer the code builds and keeps together (stored as a dword, stored into a record
field, pushed as an argument pair, handed to DOS as DS:DX, pushed for `retf`) is recorded; every indirect transfer is a
use, and `resolve()` connects uses to the pointers stored where they read. That connection is the proof that a target
is code. A built pointer nothing is seen calling through is only a guess: its target becomes a provisional function
only if it decodes as a self-contained procedure that touches no already-decoded code.

The load image is read under the same model, because a linker writes pointers the code never builds:

* A variable or table entry whose segment word is relocated holds a far pointer before any code runs, so a call
  through it reaches that pointer as it reaches a stored one. A table run continues only over entries that point at
  code (into an overlay, or into a segment that holds decoded instructions and not past the next segment's start): a
  far pointer to data looks the same in the bytes.
* A far address in a segment that holds no decoded instruction, pointing at code, is a guess like a built pointer
  nothing calls through. In a segment that holds code the same bytes may be the operand of an instruction nothing
  reaches yet, so they are skipped; so is a segment word right behind another one (a list of segments).
* A near call through a table in the code's own segment that no code fills (`call word ptr cs:[bx + T]`, or
  DS-relative where DS is that segment) has nothing bounding its index, so the bytes bound the table: it runs from T
  (or T+2, for an index that starts at 1) up to where code begins, which is the first decoded instruction or the
  lowest address the table itself names. Every word in that span must be an address in the space that is neither
  inside a decoded instruction nor inside the table; otherwise this is no such table and nothing is taken.
* `INT 21h/25h` with a constant DS:DX installs a handler whatever AL holds; where AL is not a constant the handler
  is a proven function for an unknown vector.

### Data references

The same walk records every memory operand that names an address: an absolute one (`mov [4f2ah], ax`, also where
the registers in it hold constants), or `[register + T]` in a known segment (a table based at T). The segment is what
the dataflow knows the segment register holds there: the program's data segment, a load-image segment, or an overlay.
Where it does not know, the operand is recorded with the register instead of a segment, so a reader sees a possible
reference rather than none. What the instruction does with the operand (reads, writes, calls through, takes the
address of) is the decoder's statement, and `uses` where the decoder makes none. A far pointer the code builds is a
reference to the location it points at.

A location can be reached without being named: through a pointer, through a table indexed from a lower base, from an
8087-emulator interrupt whose operand the listing shows as bytes. `data_references.json` holds what the bytes say
and the server says what they cannot (`src/graph/datarefs.ts`).

### Per-function facts

A call edge carries `return_offset`, the address the call pushes. `frame_references.json` holds the BP-relative
stack operands of each function, with the same access words as the data references; it says nothing about what a
slot is, and does not check that the function sets BP up as a frame pointer. `control_flow.json` holds each
function's basic blocks and successors, the same blocks the conditions are computed on (`flow.basic_blocks`).

These are what the decoder already knows, written out so that a consumer does not parse listing text a second time.
Stack depth at a call, argument lists, return registers and signatures are not derived: they are a decompiler's
analyses, and the bytes cannot always settle them (an indirect call to a callee that pops its own arguments,
hand-written assembler).

### Links between programs

`interrupt` (an `int n` site to the handlers resident programs install for n), `runs` (a function names another
program and reaches DOS exec), `loads` (names it and reaches DOS open), and batch files as nodes whose lines run
programs. Link edges are boundaries, not dependencies: the work planner ignores them.

### Declared modules

When a program reads code from a data file into a heap block and calls it through a far pointer it computes at run
time, no constant leads there and the dataflow cannot see the link. Rather than trace heap pointers through a file
loader, `loaded_modules.json` (kept beside the inputs, not in this repository) declares, per far-pointer variable, the
file, the records, the layout (entered at 100h or at 0) and the evidence. A container reader is a plugin named by the
entry, so no container format is built in. Every claim is checked: the record exists and decodes, and the program has
a far call through that variable.

## Where the design is overfit

| Assumption | Where it lives | Specific to |
|---|---|---|
| 16-bit decoding, segment:offset addresses, paragraphs, near/far calls, `retf` dispatch | x86.py, binary.py, pointers.py, tables.py | x86 real mode |
| Relocations are segment words; DGROUP is a relocated segment loaded into DS at startup | binary.py, pointers.dgroup | MZ, Borland toolchains |
| Overlays are INT 3Fh stub segments plus a `TPOV`/`FBOV` file; RTLink/Plus sections or Microsoft LINK overlay images appended to the EXE | binary.py | Turbo Pascal 5/6, RTLink, Microsoft LINK |
| `.COM` at 100h, PSP below it; modules loaded at offset 0 with a `jmp` table | binary.load_executable | DOS |
| OS services by INT 21h AH (exec 4Bh, open 3Dh, set vector 25h, get vector 35h, TSR 31h/INT 27h) | links.py, pointers.py, flow.py | DOS |
| Batch file semantics (COMMAND.COM search order, `if`, `goto`) | links.py | DOS |
| Stack discipline: callee pops its `ret n` words; Pascal strings; `ExitProc` chains | pointers.py, flow.py | Turbo Pascal calling convention |
| Jump-table idioms (`shl bx,1; jmp cs:[bx+T]`) | tables.py | 16-bit compilers and hand-written assembler |
| State caps (8 states per merge, 8 alternatives per value) | pointers.py | sized for programs of ~100 KB |

What is not overfit: the evidence model (proven / provisional / unknown with reasons), the per-function listing with
target annotations, control dependence for conditions, the non-returning fixpoint, cross-program links as boundaries,
declared modules checked against the bytes, and the output format. The server only assumes `SPACE:hex` ids and the
listing line format `addr  bytes  mnemonic operands`; its address parser (`src/graph/addresses.ts`) learns how code
writes addresses (`frames`) by voting over edges, and knows the x86 call spellings (`lcall seg, off`, `call word …`).

Known gaps even within its domain: function pointers in record fields are not followed; aligned indexed writes only
mark a table "also filled at run time". A near pointer in initialised data has no relocation to mark it, so a near
call through a variable no code fills stays unresolved. A table read by an indirect jump is followed only when the
code bounds its index (guards, or a search loop counted by `loop`; a search written with `dec`/`jnz` or `repne scasw`
is not read); the bound taken from the bytes for near call tables is not applied to it. A segment in which nothing is decoded
is taken for data, so the far-call operands of a code segment nothing reaches name their targets as guesses. A handler
a program installs for itself is listed, but its own `int n` sites get no edge to it. The Microsoft LINK overlay
interrupt is taken to be 3Fh, the default; a program linked with another number aborts.

## Broadening it

The seams to cut along are the ones the table above names: **container/loader**, **architecture**, **OS model** and
**runtime idioms**. A sketch of each for ELF and PE32+.

### Loader → spaces, entries, relocations, symbols

Make `binary.py` an interface: a loader returns spaces (name, bytes, base address, file offset), entry points, a way
to resolve an absolute target to (space, offset), relocation sites, and any symbols.

* **ELF (x86-64, AArch64)**: spaces per executable `PT_LOAD` segment (or per section for readability), addresses are
  virtual addresses (PIE: offsets from 0). Free function starts: `.symtab`/`.dynsym`, `.init_array`/`.fini_array`,
  and `.eh_frame` FDEs, which give exact function bounds. Imports: PLT stubs → external nodes `libc.so.6!open`.
  Relocations (`R_X86_64_RELATIVE` in `.data.rel.ro`) mark pointer-sized slots that hold code addresses: vtables
  and function-pointer tables come almost for free.
* **PE32+ (Windows x64)**: spaces per section, addresses are RVAs. `.pdata` RUNTIME_FUNCTION entries give exact
  function bounds for every non-leaf function; exports, TLS callbacks, the CFG guard table and delay imports add
  entries; the IAT gives external nodes `KERNEL32.dll!CreateFileW`; base relocations (`.reloc`) mark absolute
  pointers in data.
* Node ids stay `<FILE>:<addr>` with wider addresses (`CORE_DLL:00012a40`); listings stay per function.

With symbols, unwind tables and relocations, most of what `pointers.py` proves the hard way on DOS is given by the
format. Keep the evidence model: a symbol or unwind entry is proof of a function start; a relocation-backed slot read
by an indirect call is the same kind of proof as a stored constant pointer here.

### Architecture

`x86.py` classifies transfers for one mode. Generalise it to: decode (capstone mode per arch), classify (call, jump,
conditional, return, indirect, trap, no-return), and give operand forms. AArch64 adds `bl`, `br`, `blr`, `ret`,
`cbz`/`tbz`, literal pools and `adrp`+`add` address pairs; x86-64 adds RIP-relative operands. Jump tables become
`lea r, [rip+T]; movsxd; add; jmp r` (x86-64) or `adr; ldrb/ldrh; add; br` (AArch64): the bounded-index abstract
interpretation in `tables.py` carries over with new idioms.

### OS model

Replace INT 21h AH with a table of calls by import: `execve`/`posix_spawn`/`CreateProcessW` (runs),
`dlopen`/`LoadLibraryW` (loads), `exit`/`abort`/`ExitProcess`/`__stack_chk_fail` (non-returning), signal and
exception handler installation (`sigaction`, `SetUnhandledExceptionFilter`, SEH scopes) in place of interrupt vectors.
Link discovery by string constant still works: the name passed to `dlopen` is usually a literal.

### Runtime idioms

C++ vtables, Objective-C/Swift metadata, Go and Rust runtime tables are where a binary keeps its function pointers.
Each is a plugin that turns a table into stored pointers with evidence, exactly like the record-field matches here.

### What not to rebuild

The pure-Python dataflow is fine for programs of a few hundred KB. For multi-megabyte binaries, take function
boundaries and cross-references from Ghidra, rizin or IDA as **declared knowledge** (with their provenance on every
node) rather than re-implementing their analysis, and keep this generator's value where it is: the evidence model, the
per-function listings, conditions, links between programs, and a format the server and small models can navigate.

## Testing

Synthetic binaries, built byte by byte in `scripts/tests/conftest.py` (`mz()`, `build()` for overlays,
`exepack()`, `rtlink()`, `link_overlays()`), drive every rule; untrusted input (headers, tables, declarations) has boundary tests for
every branch, and the suite holds 100% branch coverage. Acceptance tests on real inputs, which require a checked tree
to equal a fresh build, live with those inputs outside this repository.
