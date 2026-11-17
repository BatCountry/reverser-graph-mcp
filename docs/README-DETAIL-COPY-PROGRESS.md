# Carrying progress to another tree (`reverser-copy-progress`)

Programs built on one engine share much of their code.
`npm run copy-progress -- --progress-root <dir> --source <tree> --destination <tree> [--dry-run] [--verbose]` (built
binary: `reverser-copy-progress`) copies implementation records and annotations from
`<progress-root>/<source dir name>.progress.json` into the destination's document for every destination work unit
whose code is the same as a source work unit's:

```
npm run copy-progress -- --progress-root ../reimpl/progress --source generated/alpha --destination generated/beta --dry-run
```

- **Same code**: the members' listings, instruction by instruction, after renaming what moves between builds: jumps
  inside a function become positions, call targets become the matching member or a numbered external, absolute memory
  operands (`[0x1234]`, per segment) and far pointer arguments (`mov di, imm` then `push <sreg>; push di`) become
  numbered globals, renamed consistently within the unit. Constants, registers, stack and field offsets must be equal.
  String and table contents are not compared (they are not in the trees).
- **Same callees**: identical code that calls functions which do not correspond is rejected (`call X0; call X1`
  matches any two callees). A callee that is in a matched unit must correspond to the function at the same position
  of a unit with the same code on the other side; a callee with no match may stand for one function per destination
  program (each program links its own runtime copy). Rejections repeat until the matches agree; `--verbose` lists
  them.
- Several identical source units (empty stubs, repeated helpers): the one with progress at the destination's own root
  address is taken, else the lowest id; the rest are listed with `--verbose`.
- Records are translated member by member. Annotation `module` references to the unit's members or callees are
  renamed; any other module reference becomes freeform text (`alpha MAIN_EXE:0060`). A destination member that already
  has an implementation record keeps its own, and identical annotations are skipped, so reruns copy only what is new.
  Copied records get the time of the copy.
- Work units are sized as the server sizes them (`--work-budget-lines`, `--work-trivial-lines`, or the
  `REVERSER_WORK_*` variables); use the server's values or the units will not line up. Exit status: 0 done,
  1 unreadable tree or no source progress, 2 bad arguments.
