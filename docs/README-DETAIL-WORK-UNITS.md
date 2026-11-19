# Work units (`next_work`)

`next_work` partitions the not-yet-implemented call graph into **work units** (id `work:<root node>`, e.g.
`work:MAIN_OVR-0020:0100`), each small enough to write in one sitting and entered only through its root:

1. Mutually recursive functions collapse into one node.
2. A function with exactly one caller belongs to that caller; functions with zero or several callers start their own
   unit. Calls through stored pointers that the graph resolved (edges with `through`: a dispatch table, a callback
   variable) never own, so table handlers are units of their own. Nodes with nothing
   to write (a call through an address computed at run time, an address-only node) are listed with their caller when
   they have exactly one; otherwise they belong to no unit, so no unit is ever complete before anything is implemented.
3. A unit larger than the line budget (non-blank lines of each member's listing) is split: every owned callee that has
   callees of its own or reaches the trivial-lines threshold becomes its own unit, recursively; small leaf helpers stay
   with their caller.
4. Whatever is still over budget (typically one huge function) is flagged oversized.

Recording progress never changes the partition; it marks members done. A unit is complete when every function in it
is implemented.

A unit depends on every unit its members call. A call through a stored pointer counts like a direct call, with one
exception: when the target's unit already waits on the caller's, the program recurses through the pointer (a script
command that runs the interpreter again), so one side has to be written first, and it is the caller. `next_work`
names those targets ("cannot be written first: their work units depend on this one") and says how many are still
missing. A dispatcher is therefore offered once the handlers that do not call back exist, and the handlers that do
call back come after it. Pointer calls are checked in id order, so a cycle made only of pointer calls always breaks
at the same call. Dependencies never form a cycle (mutual recursion is collapsed, multi-caller functions start their
own unit, a pointer call that would close a cycle is left out), so while any work remains some incomplete unit is
ready.

Incomplete units are ranked: ready ones (every unit they depend on is complete) first; among those, units that call
through addresses computed at run time (`unresolved (indirect)`: the graph could not name every target) last, since
nothing can say what has to exist first; then those that unblock the most other incomplete units, then not oversized,
then fewer external callees, then size closest to the budget. `next_work` and `module` name each run-time call site
and say how to translate it.

A function that is called through a stored pointer has no call that names it, so nothing fails to build when the
translation forgets to make it reachable. `next_work` (under step 2) and `module` (under its hints) say so for every
such function: register it under every address the program stores for it, and test a path that goes through the
pointer.

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
