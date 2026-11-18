import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { adviceFor, unresolvedReason } from "../graph/indirect.js";
import { sameCodeText, treeName, urisOf, workUnitLine, workUnitState, type Context, type DisasmUris } from "../graph/tools.js";
import { getSameCode, getWorkPlan, implementedNodes, nodeLines } from "../graph/workplan-cache.js";
import { DEFAULT_WORK_UNIT_OPTIONS, parseWorkUnitId, workUnitId, type WorkPlan, type WorkUnit } from "../graph/workunits.js";
import type { ToolDeps } from "./common.js";
import { percentDown } from "../percent.js";

export interface NextWorkOutput {
  work_unit: string;
  summary: string;
  members: string;
  dependencies: string;
  next_steps: string;
  queue: string;
}
export type NextWorkResult = { ok: true; output: NextWorkOutput } | { ok: false; error: string };

const INLINE_MEMBERS = 30;
const INLINE_DEPENDENCIES = 12;
/** Rows in disasm://work-plan. */
export const WORK_PLAN_ROWS = 100;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

type Found = { ok: true; unit: WorkUnit } | { ok: false; error: string };

/** A work unit id (work:<root>), or any node (node name / address) standing for the work unit it belongs to. */
export function findWorkUnit(ctx: Context, plan: WorkPlan, raw: string, field: string): Found {
  const text = raw.trim();
  if (!text) return { ok: false, error: `${field}: empty. Pass a work unit id such as work:MAIN_OVR-0020:33a0, or a node name such as MAIN_OVR-0020:1a2c.` };
  const root = parseWorkUnitId(text);
  const resolved = ctx.graph.resolve(root ?? text);
  if (!resolved.ok) return { ok: false, error: `${field}: ${resolved.error}` };
  const id = resolved.node.id;
  const owner = plan.unitOf.get(id);
  if (root !== undefined) {
    const unit = plan.units.get(workUnitId(id));
    if (unit) return { ok: true, unit };
    return { ok: false, error: `${field}: there is no work unit ${workUnitId(id)}; ${id} is part of ${owner ?? "no work unit"}.` };
  }
  const unit = owner === undefined ? undefined : plan.units.get(owner);
  return unit ? { ok: true, unit } : { ok: false, error: `${field}: ${id} is not part of any work unit.` };
}

/** Members callees-first (post-order over calls inside the unit, from the root), so each can be written against finished helpers. */
function implementOrder(ctx: Context, unit: WorkUnit): string[] {
  const inUnit = new Set(unit.members);
  const seen = new Set<string>();
  const order: string[] = [];
  const visit = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    for (const e of ctx.graph.out.get(id) ?? []) if (inUnit.has(e.target)) visit(e.target);
    order.push(id);
  };
  for (const m of unit.members) visit(m);
  return order;
}

function renderMembers(ctx: Context, unit: WorkUnit, limit: number): string {
  const lines = nodeLines(ctx);
  const done = implementedNodes(ctx);
  const sameCode = getSameCode(ctx);
  const order = implementOrder(ctx, unit);
  const rows = order.slice(0, limit).map((id) => {
    const kind = ctx.graph.nodes.get(id)?.kind ?? "unknown";
    const by = done.get(id);
    const peers = sameCode.peers(id);
    const state =
      kind === "unknown-target" ? `unresolved transfer, no listing: ${unresolvedReason(ctx.graph.nodes.get(id))}`
      : kind !== "function" ? `${kind} node, written as part of its caller`
      : by === "" ? "implemented"
      : by !== undefined ? `implemented: same code as ${by}, call that implementation`
      : peers.length ? `to do (${sameCodeText(peers).replace(/^S/, "s")}: write it once for all of them)`
      : "to do";
    return `- ${id}${id === unit.root ? " (entry)" : ""} — ${plural(lines(id), "line")} — ${state} — ${urisOf(ctx).module(id)}`;
  });
  if (order.length > limit) rows.push(`- … ${order.length - limit} more: ${urisOf(ctx).workUnit(unit.id)}`);
  return `${plural(unit.members.length, "member")}, all implemented together in one source file, callees first:\n${rows.join("\n")}`;
}

function renderDependencies(plan: WorkPlan, unit: WorkUnit, limit: number, uris: DisasmUris): string {
  if (unit.externalCallees.length === 0) return "None: it calls nothing outside itself.";
  const groups = new Map<string, string[]>();
  for (const callee of unit.externalCallees) {
    const owner = plan.unitOf.get(callee) ?? callee;
    (groups.get(owner) ?? groups.set(owner, []).get(owner)!).push(callee);
  }
  const entries = [...groups].sort(([a], [b]) => {
    const ca = plan.units.get(a)?.complete ? 1 : 0;
    const cb = plan.units.get(b)?.complete ? 1 : 0;
    return ca - cb || (a < b ? -1 : a > b ? 1 : 0);
  });
  const rows = entries.slice(0, limit).map(([owner, callees]) => {
    const state = plan.units.get(owner)?.complete ? "complete" : "incomplete";
    return `- ${owner} (${state}) — calls ${callees.join(", ")} — ${uris.workUnit(owner)}`;
  });
  if (entries.length > limit) rows.push(`- … ${entries.length - limit} more: ${uris.workUnit(unit.id)}`);
  const waiting = entries.filter(([owner]) => !plan.units.get(owner)?.complete).length;
  return `Calls into ${plural(entries.length, "other work unit")} (${waiting} incomplete):\n${rows.join("\n")}`;
}

function describeUnit(ctx: Context, plan: WorkPlan, unit: WorkUnit): string {
  const budget = (ctx.workOptions ?? DEFAULT_WORK_UNIT_OPTIONS).budgetLines;
  const functions = unit.members.filter((m) => ctx.graph.nodes.get(m)?.kind === "function").length;
  const parts = [`${unit.id}: ${plural(unit.members.length, "member")} (${plural(functions, "function")}, ${unit.implemented.length} implemented), ${unit.lines} listing lines.`];
  if (unit.complete) return [...parts, "Already complete: every function in it is implemented."].join(" ");
  const deps = unit.dependsOn.length;
  const waiting = unit.dependsOn.filter((d) => !plan.units.get(d)?.complete).length;
  const known = unit.indirectCalls.length ? " else" : "";
  if (deps === 0) parts.push(`Ready: it calls nothing${known} outside itself, so it can be written and tested on its own.`);
  else if (waiting === 0) parts.push(`Ready: all ${plural(deps, "work unit")} it calls are complete.`);
  else parts.push(`Waiting on ${waiting} of ${plural(deps, "work unit")} it calls (readiness ${percentDown(unit.readiness)}): stub those calls or do them first.`);
  if (unit.indirectCalls.length) {
    const byAdvice = new Map<string, string[]>();
    for (const c of unit.indirectCalls) {
      const advice = adviceFor(c.reason);
      (byAdvice.get(advice) ?? byAdvice.set(advice, []).get(advice)!).push(`${c.site} \`${c.instruction}\` (${c.reason})`);
    }
    const groups = [...byAdvice].map(([advice, calls]) => `${calls.join("; ")}: ${advice}`);
    parts.push(`It also makes ${plural(unit.indirectCalls.length, "transfer")} the graph cannot resolve to a function. ${groups.join(". ")}.`);
  }
  if (unit.unblocks > 0) parts.push(`Finishing it unblocks ${plural(unit.unblocks, "other incomplete work unit")}.`);
  if (unit.oversized) {
    parts.push(`Warning: oversized. ${unit.lines} lines is over the ${budget}-line budget even after splitting (usually one big function); work through it in sections and record what you learn with annotate as you go.`);
  }
  return parts.join(" ");
}

function nextSteps(ctx: Context, plan: WorkPlan, unit: WorkUnit): string {
  if (unit.complete) return "- Nothing to do here. Call next_work without `module` for the next unit.";
  const waiting = unit.dependsOn.some((d) => !plan.units.get(d)?.complete);
  const done = implementedNodes(ctx);
  const covered = unit.members.filter((m) => done.get(m));
  return [
    "1. Read each member's listing through its disasm://module link, in the order above (callees first).",
    `2. Write them in one source file containing the comment \`/* Implements: ${unit.id} */\`.`,
    ...(covered.length ? [`   ${covered.join(", ")}: same code as a function already implemented; call that implementation instead of writing it again.`] : []),
    ...(waiting ? ["   Calls into incomplete work units: declare those functions and stub them for now."] : []),
    `3. Call add_implementation with tree "${treeName(ctx.disassemblyRoot)}", module "${unit.id}", the file name and the function name: it records every function in the unit at once.`,
    "4. Call next_work again.",
  ].join("\n");
}

function queueText(plan: WorkPlan, skipped: number, uris: DisasmUris): string {
  return `${plural(plan.ranked.length, "incomplete work unit")} of ${plan.units.size} remain${skipped ? ` (${skipped} skipped this call)` : ""}. Ranked queue with sizes and readiness: ${uris.workPlan}`;
}

export function nextWork(ctx: Context, args: { skip?: string[] | undefined; module?: string | undefined }): NextWorkResult {
  const plan = getWorkPlan(ctx);
  const errors: string[] = [];
  const skip = new Set<string>();
  (args.skip ?? []).forEach((raw, i) => {
    const found = findWorkUnit(ctx, plan, raw, `skip[${i}]`);
    if (found.ok) skip.add(found.unit.id);
    else errors.push(found.error);
  });
  let unit: WorkUnit | undefined;
  if (args.module !== undefined) {
    const found = findWorkUnit(ctx, plan, args.module, "module");
    if (found.ok) unit = found.unit;
    else errors.push(found.error);
  }
  if (errors.length) return { ok: false, error: errors.join("\n") };

  const skipped = plan.ranked.filter((u) => skip.has(u.id)).length;
  unit ??= plan.ranked.find((u) => !skip.has(u.id));
  if (!unit) {
    const allDone = plan.ranked.length === 0;
    return {
      ok: true,
      output: {
        work_unit: "none",
        summary: allDone
          ? `All ${plural(plan.units.size, "work unit")} are complete: every function in the call graph is implemented.`
          : `All ${plural(plan.ranked.length, "incomplete work unit")} are in \`skip\`.`,
        members: "None.",
        dependencies: "None.",
        next_steps: allDone ? "- Nothing left to implement. Use `module` to review or annotate what is done." : "- Call next_work again with fewer ids in `skip`.",
        queue: queueText(plan, skipped, urisOf(ctx)),
      },
    };
  }
  const rank = plan.ranked.indexOf(unit);
  const why = args.module !== undefined ? `The work unit containing ${args.module.trim()}${rank >= 0 ? `, #${rank + 1} in the queue` : ""}.` : `Next in the queue (#${rank + 1} of ${plan.ranked.length}).`;
  return {
    ok: true,
    output: {
      work_unit: unit.id,
      summary: `${why} ${describeUnit(ctx, plan, unit)}`,
      members: renderMembers(ctx, unit, INLINE_MEMBERS),
      dependencies: renderDependencies(plan, unit, INLINE_DEPENDENCIES, urisOf(ctx)),
      next_steps: nextSteps(ctx, plan, unit),
      queue: queueText(plan, skipped, urisOf(ctx)),
    },
  };
}

export function renderNextWorkText(o: NextWorkOutput): string {
  return [`# ${o.work_unit}`, "", o.summary, "", `## Members\n${o.members}`, "", `## Dependencies\n${o.dependencies}`, "", `## Next steps\n${o.next_steps}`, "", o.queue].join("\n");
}

/** disasm://work-plan: the ranked queue, best first. */
export function renderWorkPlan(ctx: Context): string {
  const plan = getWorkPlan(ctx);
  const options = ctx.workOptions ?? DEFAULT_WORK_UNIT_OPTIONS;
  const oversized = plan.ranked.filter((u) => u.oversized).length;
  const head = [
    "# Work plan",
    "",
    `${plural(plan.units.size, "work unit")}: ${plan.units.size - plan.ranked.length} complete, ${plan.ranked.length} to do (${oversized} oversized). ` +
      `Budget ${options.budgetLines} lines per unit; leaf callees under ${options.trivialLines} lines stay with their caller.`,
    `Best first: ready units (everything they call is done), then those that unblock the most others, then compact ones. Detail of one unit: ${urisOf(ctx).base}work-unit/{id} (id URL-encoded), or next_work with \`module\`.`,
  ];
  if (plan.ranked.length === 0) return [...head, "", "Nothing left: every work unit is complete."].join("\n");
  const rows = plan.ranked.slice(0, WORK_PLAN_ROWS).map((u, i) => `| ${i + 1} | [${u.id}](${urisOf(ctx).workUnit(u.id)}) | ${u.members.length} | ${u.lines} | ${percentDown(u.readiness)} | ${u.unblocks} | ${workUnitState(plan, u)} |`);
  const more = plan.ranked.length > WORK_PLAN_ROWS ? [`… ${plan.ranked.length - WORK_PLAN_ROWS} more incomplete units not shown; they come up as these are completed.`] : [];
  return [...head, "", "| # | work unit | members | lines | readiness | unblocks | state |", "| --- | --- | --- | --- | --- | --- | --- |", ...rows, ...more].join("\n");
}

/** disasm://work-unit/{id}: one unit in full. Throws on an unknown id (the resource layer reports it). */
export function renderWorkUnit(ctx: Context, id: string): string {
  const plan = getWorkPlan(ctx);
  const found = findWorkUnit(ctx, plan, id, "id");
  if (!found.ok) throw new Error(found.error);
  const unit = found.unit;
  const callers = [...plan.units.values()].filter((u) => u.dependsOn.includes(unit.id)).map((u) => `- ${u.id} (${workUnitState(plan, u)}) — ${urisOf(ctx).workUnit(u.id)}`);
  return [
    `# ${unit.id}`,
    "",
    workUnitLine(plan, unit, urisOf(ctx)),
    "",
    describeUnit(ctx, plan, unit),
    "",
    `## Members\n${renderMembers(ctx, unit, Number.POSITIVE_INFINITY)}`,
    "",
    `## Dependencies\n${renderDependencies(plan, unit, Number.POSITIVE_INFINITY, urisOf(ctx))}`,
    "",
    `## Called by\n${callers.length ? callers.join("\n") : "No other work unit calls into it."}`,
    "",
    `## Next steps\n${nextSteps(ctx, plan, unit)}`,
  ].join("\n");
}

export function register(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "next_work",
    {
      title: "What should I implement next?",
      description:
        "Answers 'what should I implement next?'. Returns one bite-sized work unit: a function plus the small helpers only it calls, sized to write in one sitting, preferring units whose callees are already done and that unblock the most others. " +
        "You get its members with listing links (callees first), which other units it calls and whether they are done, and the exact steps to record it. Pass `skip` to pass over units, or `module` for the unit a given function belongs to.",
      inputSchema: z.object({
        skip: z.array(z.string()).describe("Work unit ids to pass over, e.g. [\"work:MAIN_OVR-0020:33a0\"]").optional(),
        module: z.string().describe("Show the work unit containing this function instead: node name (MAIN_OVR-0020:1a2c), an address copied from a listing (lcall 0x41, 0x25; 5cd:0634) or a work unit id").optional(),
      }),
      outputSchema: z.object({
        work_unit: z.string().describe("Work unit id (work:<root node>), or \"none\" when nothing is left"),
        summary: z.string().describe("Why this unit: readiness, what it unblocks, size, oversized warning"),
        members: z.string().describe("Nodes in the unit, callees first, with lines, status and module links"),
        dependencies: z.string().describe("Other work units it calls, grouped, complete or not"),
        next_steps: z.string().describe("How to implement and record it"),
        queue: z.string().describe("How many units remain, with a link to the ranked queue"),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ skip, module }) => {
      const result = nextWork(deps.graphContext(), { skip, module });
      if (!result.ok) return { isError: true, content: [{ type: "text", text: result.error }] };
      return { structuredContent: { ...result.output }, content: [{ type: "text", text: renderNextWorkText(result.output) }] };
    },
  );
}
