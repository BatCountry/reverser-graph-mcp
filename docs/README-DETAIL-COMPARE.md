# Comparing two trees (`--compare`)

`node build/index.js --disassembly-root generated/alpha --compare generated/beta` (add `--dashboard` for the page) is
a research mode for two programs that share code (two builds, or two products on one engine): the server keeps every
normal tool for its own tree and adds, named after the two directory names:

| Tool / resource | Use it when |
| --- | --- |
| `counterpart` | You look at a function in either tree (`game` picks which) and want its counterpart in the other: identical or how much lines up, why they were paired and how sure that is, which callees correspond, the changed stretches side by side (long one-sided runs cut), or, with no counterpart, the leads (same code elsewhere, candidates, matched callers) |
| `compare` | You want any two functions side by side, one from each tree, and whether they are recorded counterparts |
| `disasm://<tree>/compare/<other>/pair/{a}/{b}` | Every row of the side by side (ids URL-encoded) |
| `disasm://<tree>/compare/<other>/map/{all,identical,changed,unmatched}/{page}` | Every function with its counterpart, 100 per page |

Give it its own MCP config entry so workers on one tree never see the extra tools. The dashboard gets a Compare tab
(counts, a filterable table, a side-by-side page per pair with changed rows highlighted, a leads page for unmatched
functions) and a "Counterpart in …" card on module pages.

## How functions are paired

`src/compare/correspond.ts`, built once per process:

0. Programs: each program of one tree pairs with the program of the other whose distinct function code it shares the
   largest share of (shared ÷ union, compared as exact fractions); only mutual best choices pair, and a tie or no
   shared code leaves a program unpaired, with the reason in the output. File names play no part. Steps 1 and 2 run
   within each program pair, so "unique" means unique within the two paired programs.
1. Seeds: work units whose code no other unit in either program has (members pair by position), then single functions
   whose code no other function has. Code is compared as `reverser-copy-progress` compares it
   ([carrying progress](README-DETAIL-COPY-PROGRESS.md)): addresses that move between builds (globals, far pointer
   arguments, call targets, local jumps) are renamed, everything else must match.
2. Propagation: from every pair, the functions called at the same place in the aligned listings, and the only
   unmatched callers of both, are proposed; a proposal is taken when it is the best for both functions (most
   proposals, then most similar code; a tie on both is left open). New pairs propose more until nothing changes.

Code may differ arbitrarily in step 2, so routines gutted between builds are still found through their callers.
Confidence: `same code` (a seed), `strong` (≥60% lines up), `likely` (≥2 proposals or ≥30%), `weak` (one proposal,
little shared code: check the diff). Identical code shared by several functions of a program pair is never paired by
guessing; functions of an unpaired program get no counterpart, but identical code elsewhere still shows as a lead.
Link edges (`runs`, `loads`, `interrupt`) are not call positions.
