# Tools and resources

| Tool | Use it when |
| --- | --- |
| `next_work` | You are reimplementing the program and ask "what should I implement next?": one bite-sized work unit, its members, what it depends on, how to record it ([work units](README-DETAIL-WORK-UNITS.md)) |
| `module` | You are reading or porting a function: listing, callers/callees (linked), every entrypoint's call chain to it, implementation status, work unit |
| `trace` | You need the call path between two specific modules |
| `interrupts` | You see `INT nn` (DOS, BIOS, mouse, EMS, DPMI) and want what it does for the registers set before it |
| `dos_memory_offset` | You see a segment/offset (video RAM, BIOS data area, IVT, ROM font) and want its meaning |
| `dos_port` | You see `IN`/`OUT` (VGA/EGA/CGA, palette, PIT/speaker, PIC, keyboard, joystick, Tandy SN76496) |
| `add_implementation`, `annotate` | You finished a module or a whole work unit / learned something about one |
| `counterpart`, `compare` | Only with `--compare <other tree>`: the same function in the other tree, side by side ([comparing two trees](README-DETAIL-COMPARE.md)) |

Numbers and addresses the tools accept: [number format](README-DETAIL-NUMBER-FORMAT.md).

Results are short; deep detail is behind `dosref://` (reference) and `disasm://` (disassembly) resources. Every
`disasm://` URI starts with the tree's directory name (`disasm://alpha/…`, `disasm://beta/…`): with one server per tree
loaded, a client routes each URI to the server of that tree only (several servers serving the same paths would all
claim the first server's URIs).

Each function has one listing, `disasm://<tree>/listing/{id}` (id URL-encoded): its instructions decoded from the
binary by following its control flow, one line per instruction (`1a2c  fc  cld`, offset within its space). Every call
or jump to another function ends with `; → <node>` (the node name to pass to `module`); lines are matched to graph
call sites within the listing's own space, so a shared overlay address range is never ambiguous there.

A call through a stored pointer names the procedures the program stores there (at most 4 on the line, then
`… (+N more …)`; `module` lists them all as callees, each site saying what it read, e.g. `through ds:[index+1200]`);
what the graph cannot name shows as `unresolved (indirect)`, and `module` says why and how to translate it (a hand-off
to the previous interrupt handler is not a function-pointer lookup). On the other side, a function that is called
through a stored pointer gets a hint that no call names it: it must be registered under every address the program
stores for it (its Evidence lines name each store), and a path through the pointer should be tested. `module` also
marks provisional functions (no call or jump to them is proven; listed because the code builds their address) with
the evidence.

A line range after the id, written as omp's `read` tool writes it (`:50-80`, `:50+30`, `:50` from line 50 on, `:-20`
the last 20 lines; lines numbered from 1 in the file), returns only those lines under a `; <id>, lines 50-80 of 310`
header; a range past the end is cut there and says so, anything else is refused with the forms that work
(`src/graph/line-range.ts`).
