# Work units (`next_work`)

`next_work` partitions the not-yet-implemented call graph into **work units** (id `work:<root node>`, e.g.
`work:MAIN_OVR-0020:0100`), each small enough to write in one sitting and entered only through its root:

1. Mutually recursive functions collapse into one node.
2. A function with exactly one caller belongs to that caller; functions with zero or several callers start their own
   unit. Calls through stored pointers that the graph resolved (edges with `through`: a dispatch table, a callback
   variable) count neither as owning nor as a dependency, so table handlers are units of their own. Nodes with nothing
   to write (a call through an address computed at run time, an address-only node) are listed with their caller when
   they have exactly one; otherwise they belong to no unit, so no unit is ever complete before anything is implemented.
3. A unit larger than the line budget (non-blank lines of each member's listing) is split: every owned callee that has
   callees of its own or reaches the trivial-lines threshold becomes its own unit, recursively; small leaf helpers stay
   with their caller.
4. Whatever is still over budget (typically one huge function) is flagged oversized.

Recording progress never changes the partition; it marks members done. A unit is complete when every function in it
is implemented. Incomplete units are ranked: ready ones (every unit they call is complete) first; among those, units
that call through addresses computed at run time (`unresolved (indirect)`, e.g. a far call through a pointer table)
last, since they need a function-pointer table whose entries are written elsewhere; then those that unblock the most
other incomplete units, then not oversized, then fewer external callees, then size closest to the budget. Units cannot
depend on each other in a cycle (mutual recursion is collapsed, multi-caller functions start their own unit), so while
any work remains some incomplete unit is ready. `next_work` and `module` name each run-time call site and say how to
translate it.

`next_work` returns the top unit (or, with `module`, the unit containing a node; `skip` passes over units). Resources:
`disasm://<tree>/work-plan` (ranked queue, top 100) and `disasm://<tree>/work-unit/{id}` (one unit in full, id
URL-encoded). `module` shows a one-line `Work unit:` status. When a unit is finished, put
`/* Implements: work:<root> */` (or every member's name) in the source file and call `add_implementation` with the
work unit id: one record is written per function member. The plan is rebuilt whenever `callgraph.json` or
`progress.json` changes. Sizes are set by `--work-budget-lines` and `--work-trivial-lines`
([configuration](README-DETAIL-CONFIGURATION.md)).

## Same code

`src/graph/samecode.ts`: every program of a tree links its own copy of its compiler's runtime library, and driver
modules often share their entry stubs, so one tree holds many identical functions. Two functions are the same code when
their normalised code matches (addresses that move are renamed, as in `reverser-copy-progress`), each callee in the
same position is itself the same code or the same node, and, within one program, they read the same memory addresses
(two getters of different variables are not one routine). Implementing any member of such a group counts for all of
them: `module` says "Same code as X; implemented there as … : nothing to write here, call that implementation", the
work plan and `next_work` treat covered functions as implemented, and `add_implementation` names the peers it covers.
Nothing extra is written to the progress document.

## Links between programs

Link edges (`runs`, `loads`, `interrupt`: one program calling into another) are boundaries, not dependencies: they do
not join units, and `module` advises implementing the other program's interface (an interrupt API, a process launch,
a file read), not its code.
