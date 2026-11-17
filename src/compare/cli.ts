import { existsSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { lineCount, progressFileFor } from "../config.js";
import { CallGraph } from "../graph/model.js";
import { buildWorkPlan, DEFAULT_WORK_UNIT_OPTIONS, listingSize, type WorkUnitOptions } from "../graph/workunits.js";
import { ProgressStore } from "../progress/store.js";
import { applyCarry, planCarry, type Tree } from "./carry.js";

export const USAGE = `usage: reverser-copy-progress --progress-root <dir> --source <tree> --destination <tree> [--dry-run] [--verbose]
                              [--work-budget-lines <n>] [--work-trivial-lines <n>]

Copies implementation records and annotations from <progress-root>/<source dir name>.progress.json to
<progress-root>/<destination dir name>.progress.json for every destination work unit whose code matches a
source work unit (same instructions, addresses renamed consistently). Records already present are skipped,
so running it again copies only what is new. Work units are sized as the server sizes them (defaults 600/20).`;

function loadTree(root: string, options: WorkUnitOptions, progressRoot: string): Tree {
  if (!existsSync(path.join(root, "navigation", "callgraph.json"))) throw new Error(`${root} is not a generated tree: it has no navigation/callgraph.json`);
  const graph = CallGraph.load(root);
  return {
    name: path.basename(root),
    disassemblyRoot: root,
    graph,
    plan: buildWorkPlan(graph, new Set(), listingSize(root, graph), options),
    progress: new ProgressStore(progressFileFor(progressRoot, root)),
  };
}

/** Runs the command: report lines go to `out`, problems to `err`; returns 0 done, 1 failed, 2 bad usage. */
export function copyProgress(argv: readonly string[], out: (line: string) => void, err: (line: string) => void, cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env): number {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        "progress-root": { type: "string" },
        source: { type: "string" },
        destination: { type: "string" },
        "dry-run": { type: "boolean", default: false },
        verbose: { type: "boolean", default: false },
        "work-budget-lines": { type: "string" },
        "work-trivial-lines": { type: "string" },
        help: { type: "boolean", default: false },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    err(`${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (values.help) {
    out(USAGE);
    return 0;
  }
  const missing = (["progress-root", "source", "destination"] as const).filter((k) => !values[k]?.trim());
  if (missing.length) {
    err(`missing ${missing.map((k) => `--${k}`).join(", ")}\n\n${USAGE}`);
    return 2;
  }
  let options: WorkUnitOptions;
  try {
    options = {
      budgetLines: lineCount(values["work-budget-lines"] ?? env.REVERSER_WORK_BUDGET_LINES, DEFAULT_WORK_UNIT_OPTIONS.budgetLines, "work-budget-lines", "REVERSER_WORK_BUDGET_LINES"),
      trivialLines: lineCount(values["work-trivial-lines"] ?? env.REVERSER_WORK_TRIVIAL_LINES, DEFAULT_WORK_UNIT_OPTIONS.trivialLines, "work-trivial-lines", "REVERSER_WORK_TRIVIAL_LINES"),
    };
  } catch (error) {
    err((error as Error).message);
    return 2;
  }
  const progressRoot = path.resolve(cwd, values["progress-root"]!);
  const [sourceRoot, destinationRoot] = [values.source!, values.destination!].map((p) => path.resolve(cwd, p));
  if (progressFileFor(progressRoot, sourceRoot!) === progressFileFor(progressRoot, destinationRoot!)) {
    err(`--source and --destination share the progress document ${progressFileFor(progressRoot, sourceRoot!)}: their directories need different names`);
    return 2;
  }

  let source: Tree;
  let destination: Tree;
  try {
    source = loadTree(sourceRoot!, options, progressRoot);
    destination = loadTree(destinationRoot!, options, progressRoot);
  } catch (error) {
    err((error as Error).message);
    return 1;
  }
  if (!existsSync(source.progress.file)) {
    err(`No source progress at ${source.progress.file}: nothing to copy.`);
    return 1;
  }

  const plan = planCarry(source, destination);
  const implCount = plan.carried.reduce((n, c) => n + c.implementations.length, 0);
  const noteCount = plan.carried.reduce((n, c) => n + c.annotations.length, 0);
  out(`source       ${sourceRoot} (${plan.sourceUnits} work units), progress ${source.progress.file}`);
  out(`destination  ${destinationRoot} (${plan.destinationUnits} work units), progress ${destination.progress.file}`);
  out(`matched      ${plan.matched} of ${plan.destinationUnits} destination work units have the same code as a source work unit`);
  out(`to copy      ${implCount} implementation record(s) and ${noteCount} annotation(s) into ${plan.carried.length} work unit(s)`);
  const chosen = plan.carried.filter((c) => c.alternatives.length);
  if (chosen.length) out(`identical    ${chosen.length} of them match several identical source units with progress; the root at the same address, else the lowest id, was taken (--verbose lists them)`);
  if (plan.rejected.length) {
    out(`rejected     ${plan.rejected.length} work unit(s) have the same code but call functions that do not correspond; left alone${values.verbose ? ":" : " (--verbose lists them)"}`);
    if (values.verbose) for (const r of plan.rejected) out(`  ${r.destination} <- ${r.source}: ${r.reason}`);
  }
  if (plan.unreadable.length) {
    out(`unreadable   ${plan.unreadable.length} work unit(s) have a member without a readable listing; not compared:`);
    for (const u of plan.unreadable) out(`  ${u}`);
  }
  if (values.verbose) {
    for (const c of plan.carried) {
      out(`  ${c.destination} <- ${c.source}: ${c.implementations.length} implementation(s), ${c.annotations.length} annotation(s)${c.alternatives.length ? ` (also identical: ${c.alternatives.join(", ")})` : ""}`);
      for (const [to, from] of c.members) if (to !== from) out(`    ${to} <- ${from}`);
    }
  }
  if (values["dry-run"]) {
    out("dry run: nothing written");
    return 0;
  }
  const written = applyCarry(plan, destination.progress);
  out(`wrote        ${written.implementations} implementation record(s) and ${written.annotations} annotation(s) to ${destination.progress.file}`);
  return 0;
}
