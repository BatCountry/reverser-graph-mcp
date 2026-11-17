import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { renderCounterpart, resolveFunction } from "../compare/render.js";
import type { ToolDeps } from "./common.js";

/** Compare mode only (--compare). */
export function register(server: McpServer, deps: ToolDeps): void {
  const compare = deps.compare;
  if (!compare) return;
  const [a, b] = compare.names;
  server.registerTool(
    "counterpart",
    {
      title: `Find the same function in the other game (${a} ↔ ${b})`,
      description:
        `Looking at a function in ${a} or ${b} and wondering what became of it in the other game? Give its node name or an address pasted from a listing and get its counterpart, how alike they are (identical, or how much of the code still lines up), why the two were paired and how sure that is, which callees correspond, and the changed stretches side by side. ` +
        `Use it to carry what you learned about one game over to the other, or to see what the sequel changed (a gutted routine, a new check). With no counterpart you get the closest leads instead.`,
      inputSchema: z.object({
        module: z.string().describe(`Node name (MAIN_OVR-00a5:0000, MAIN_EXE:5c10) or an address copied from a listing of the game named by \`game\``),
        game: z.enum([a, b]).optional().describe(`Which game \`module\` is in (default ${a})`),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ module, game }) => {
      const c = compare.correspondence();
      const w = game === b ? "b" : "a";
      const r = resolveFunction(c, w, module);
      if (!r.ok) return { isError: true, content: [{ type: "text", text: r.error }] };
      return { content: [{ type: "text", text: renderCounterpart(c, w, r.id, r.note) }] };
    },
  );
}
