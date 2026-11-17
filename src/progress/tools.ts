import { readFileSync } from "node:fs";
import path from "node:path";
import type { CallGraph } from "../graph/model.js";
import type { SameCode } from "../graph/samecode.js";
import { sameCodeText } from "../graph/tools.js";
import { parseWorkUnitId, workUnitId, type WorkPlan, type WorkUnit } from "../graph/workunits.js";
import { checkImplementsComment, findImplementationFiles, type AnnotationReference, type ProgressStore } from "./store.js";

export type ToolResult = { ok: true; message: string } | { ok: false; error: string };

export interface ProgressContext {
  /** this server's tree: the disassembly root's directory name (alpha, beta, …), which names its progress document */
  tree: string;
  graph: CallGraph;
  progress: ProgressStore;
  implementationRoot: string;
  /** current work plan (work unit ids accepted by add_implementation) */
  workPlan: () => WorkPlan;
  /** same-code groups of the graph: a record on one member counts for all */
  sameCode: () => SameCode;
}

type Target = { ok: true; id: string; unit?: WorkUnit; functions: string[] } | { ok: false; error: string };

/** A graph node, or a work unit id `work:<root>` standing for all of its function members. */
function resolveTarget(ctx: ProgressContext, raw: string): Target {
  const root = parseWorkUnitId(raw);
  if (root === undefined) {
    const mod = ctx.graph.resolve(raw);
    return mod.ok ? { ok: true, id: mod.node.id, functions: [mod.node.id] } : { ok: false, error: `module: ${mod.error}` };
  }
  const mod = ctx.graph.resolve(root);
  if (!mod.ok) return { ok: false, error: `module: "${raw.trim()}" is not a work unit: ${mod.error}` };
  const plan = ctx.workPlan();
  const unit = plan.units.get(workUnitId(mod.node.id));
  if (!unit) {
    const owner = plan.unitOf.get(mod.node.id);
    return {
      ok: false,
      error: owner
        ? `module: ${mod.node.id} does not head a work unit; it belongs to ${owner}. Pass that work unit id, or ${mod.node.id} alone to record just this function.`
        : `module: ${mod.node.id} is in no work unit: a node of kind "${mod.node.kind}" has nothing to implement on its own.`,
    };
  }
  // every work unit has at least one function member (see buildWorkPlan)
  const functions = unit.members.filter((m) => ctx.graph.nodes.get(m)?.kind === "function");
  return { ok: true, id: unit.id, unit, functions };
}

/** Several servers (one per game) expose these tools and node ids repeat across games, so a write names the game it
 * is for and is refused on any other game's server. Case and surrounding space are ignored (ALPHA = alpha). */
export function checkTree(ctx: Pick<ProgressContext, "tree">, raw: string): ToolResult | undefined {
  const given = raw.trim();
  if (!given) return { ok: false, error: `tree: empty. Pass the game tree you did this work for; this server's tree is "${ctx.tree}".` };
  if (given.toLowerCase() === ctx.tree.toLowerCase()) return undefined;
  return {
    ok: false,
    error: `tree: "${given}" is not this server's tree. This server records progress for "${ctx.tree}" only (node names repeat across games, so recording here would mark ${ctx.tree} functions). Nothing was recorded: call this tool on the ${given} server instead, or pass tree "${ctx.tree}" if the work really is for ${ctx.tree}.`,
  };
}

export function addImplementation(
  ctx: ProgressContext,
  args: { tree: string; module: string; implementation_filename: string; function_name: string },
  now = new Date(),
): ToolResult {
  const wrongTree = checkTree(ctx, args.tree);
  if (wrongTree) return wrongTree;
  const target = resolveTarget(ctx, args.module);
  if (!target.ok) return target;
  const fileName = args.implementation_filename.trim();
  const fn = args.function_name.trim();
  if (!fileName) return { ok: false, error: "implementation_filename: empty. Pass the file's basename, e.g. render_map.cpp" };
  if (!fn) return { ok: false, error: "function_name: empty. Pass the exact identifier of the implementing function." };

  const hits = findImplementationFiles(ctx.implementationRoot, fileName);
  if (hits.length === 0) {
    return { ok: false, error: `No file named "${fileName}" under ${ctx.implementationRoot}. Pass just the basename of a file inside the reimplementation tree (--implementation-root / REVERSER_IMPLEMENTATION_ROOT sets where that is).` };
  }
  if (hits.length > 1) {
    const rels = hits.slice(0, 6).map((h) => path.relative(ctx.implementationRoot, h));
    return { ok: false, error: `"${fileName}" is ambiguous (${hits.length} matches: ${rels.join(", ")}). Add a leading directory, e.g. ${rels[0]}.` };
  }
  const file = hits[0]!;
  const rel = path.relative(ctx.implementationRoot, file);
  const check = checkImplementsComment(readFileSync(file, "utf8"), target.id, fn, rel, target.unit ? target.functions : []);
  if (!check.ok) return check;

  if (target.unit) {
    const { created } = ctx.progress.addImplementations(target.functions.map((module) => ({ module, file: rel, function: fn })), now);
    const n = target.functions.length;
    return {
      ok: true,
      message: `Recorded ${fn} in ${rel} as the implementation of ${target.id}: ${n} function member${n === 1 ? "" : "s"} (${created} new, ${n - created} refreshed): ${target.functions.join(", ")}.${alsoCovered(ctx, target.functions)} Call next_work for what to do next.`,
    };
  }
  const { created } = ctx.progress.addImplementation({ module: target.id, file: rel, function: fn }, now);
  const total = ctx.progress.implementationsFor(target.id).length;
  return { ok: true, message: `${created ? "Recorded" : "Refreshed"} ${fn} in ${rel} as an implementation of ${target.id} (${total} implementation${total === 1 ? "" : "s"} registered for this module).${alsoCovered(ctx, target.functions)}` };
}

/** " Same code as X …: implemented through this record too." for the same-code peers outside `functions`, else "". */
function alsoCovered(ctx: ProgressContext, functions: readonly string[]): string {
  const sameCode = ctx.sameCode();
  const inside = new Set(functions);
  const peers = [...new Set(functions.flatMap((f) => sameCode.peers(f)))].filter((p) => !inside.has(p)).sort();
  return peers.length ? ` ${sameCodeText(peers)}: implemented through this record too, nothing to write there.` : "";
}

export function addAnnotation(
  ctx: ProgressContext,
  args: { tree: string; module: string; annotation_type: "behavioral" | "functional"; annotation_body: { description: string; references: AnnotationReference[] } },
  now = new Date(),
): ToolResult {
  const wrongTree = checkTree(ctx, args.tree);
  if (wrongTree) return wrongTree;
  const mod = ctx.graph.resolve(args.module);
  if (!mod.ok) return { ok: false, error: `module: ${mod.error}` };
  const description = args.annotation_body.description.trim();
  if (!description) return { ok: false, error: "annotation_body.description: empty" };

  const errors: string[] = [];
  const references: AnnotationReference[] = args.annotation_body.references.map((ref, i) => {
    if (ref.reference_type !== "module") return { ...ref, reference_content: ref.reference_content.trim() };
    const r = ctx.graph.resolve(ref.reference_content);
    if (!r.ok) {
      errors.push(`references[${i}]: ${r.error}`);
      return ref;
    }
    return { reference_type: "module", reference_content: r.node.id };
  });
  if (errors.length) return { ok: false, error: errors.join("\n") };

  ctx.progress.addAnnotation({ module: mod.node.id, annotation_type: args.annotation_type, description, references }, now);
  const n = ctx.progress.annotationsFor(mod.node.id).length;
  return { ok: true, message: `Recorded a ${args.annotation_type} annotation on ${mod.node.id} (${n} annotation${n === 1 ? "" : "s"} on this module, ${references.length} reference${references.length === 1 ? "" : "s"}).` };
}
