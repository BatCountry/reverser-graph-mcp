import { statSync } from "node:fs";
import path from "node:path";
import type { ProgressStore } from "../progress/store.js";
import type { CallGraph } from "./model.js";
import { findSameCode, type SameCode } from "./samecode.js";
import { buildWorkPlan, DEFAULT_WORK_UNIT_OPTIONS, listingSize, type WorkPlan, type WorkUnitOptions } from "./workunits.js";

export interface WorkPlanSource {
  graph: CallGraph;
  disassemblyRoot: string;
  progress: ProgressStore;
  workOptions?: WorkUnitOptions | undefined;
}

// Listing sizes and same-code groups never change for a loaded graph; the plan changes with progress. Each lives in
// one slot (the server has one graph), keyed so that recording progress or a new callgraph.json rebuilds the plan at once.
let sizes: { graph: CallGraph; root: string; sizeOf: (id: string) => number } | undefined;
let sameCode: { graph: CallGraph; root: string; groups: SameCode } | undefined;
let plan: { graph: CallGraph; key: string; plan: WorkPlan } | undefined;

function mtime(file: string): string {
  try {
    return String(statSync(file).mtimeMs);
  } catch {
    return "absent";
  }
}

/** Memoized listing line count of a node, shared with the plan builder. */
export function nodeLines(src: Pick<WorkPlanSource, "graph" | "disassemblyRoot">): (id: string) => number {
  if (sizes?.graph !== src.graph || sizes.root !== src.disassemblyRoot) {
    sizes = { graph: src.graph, root: src.disassemblyRoot, sizeOf: listingSize(src.disassemblyRoot, src.graph) };
  }
  return sizes.sizeOf;
}

/** Same-code groups of the loaded graph (see samecode.ts), computed once per graph. */
export function getSameCode(src: Pick<WorkPlanSource, "graph" | "disassemblyRoot">): SameCode {
  if (sameCode?.graph !== src.graph || sameCode.root !== src.disassemblyRoot) {
    sameCode = { graph: src.graph, root: src.disassemblyRoot, groups: findSameCode(src.disassemblyRoot, src.graph) };
  }
  return sameCode.groups;
}

/**
 * Everything implemented: id -> "" for a node with its own implementation record, or -> the same-code peer whose
 * record covers it. Never written back to the progress document. `own` defaults to the progress document's records
 * (the dashboard passes the set from its one snapshot).
 */
export function implementedNodes(src: Pick<WorkPlanSource, "graph" | "disassemblyRoot" | "progress">, own: ReadonlySet<string> = src.progress.implementedModules()): Map<string, string> {
  const out = new Map<string, string>([...own].map((id) => [id, ""]));
  for (const [id, by] of getSameCode(src).coverage(own)) out.set(id, by);
  return out;
}

/** The work plan for the current graph and progress; rebuilt only when callgraph.json, progress.json or the options change. */
export function getWorkPlan(src: WorkPlanSource): WorkPlan {
  const options = src.workOptions ?? DEFAULT_WORK_UNIT_OPTIONS;
  const key = [
    src.disassemblyRoot,
    mtime(path.join(src.disassemblyRoot, "navigation", "callgraph.json")),
    src.progress.file,
    src.progress.changeToken(),
    options.budgetLines,
    options.trivialLines,
  ].join("|");
  if (plan?.graph === src.graph && plan.key === key) return plan.plan;
  const built = buildWorkPlan(src.graph, new Set(implementedNodes(src).keys()), nodeLines(src), options);
  plan = { graph: src.graph, key, plan: built };
  return built;
}
