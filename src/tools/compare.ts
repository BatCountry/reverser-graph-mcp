import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { renderCompare, resolveFunction } from "../compare/render.js";
import type { ToolDeps } from "./common.js";

/** Compare mode only (--compare). */
export function register(server: McpServer, deps: ToolDeps): void {
  const compare = deps.compare;
  if (!compare) return;
  const [a, b] = compare.names;
  server.registerTool(
    "compare",
    {
      title: `Put a ${a} function and a ${b} function side by side`,
      description:
        `Have a hunch that two functions are the same routine in ${a} and ${b}? Give one from each and see how much of the code lines up, the changed stretches side by side (addresses that moved are told apart from real changes), which callees correspond, and whether they are already recorded as counterparts. ` +
        `Handy when \`counterpart\` finds none or names several candidates.`,
      inputSchema: z.object({
        [a]: z.string().describe(`Node name or listing address in ${a}`),
        [b]: z.string().describe(`Node name or listing address in ${b}`),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args: Record<string, string>) => {
      const c = compare.correspondence();
      const ra = resolveFunction(c, "a", args[a]!); // both are required by the schema
      const rb = resolveFunction(c, "b", args[b]!);
      const errors = [ra, rb].flatMap((r) => (r.ok ? [] : [r.error]));
      if (!ra.ok || !rb.ok) return { isError: true, content: [{ type: "text", text: errors.join("\n") }] };
      const notes = [ra.note, rb.note].filter((n): n is string => n !== undefined);
      return { content: [{ type: "text", text: renderCompare(c, ra.id, rb.id, notes) }] };
    },
  );
}
