import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { lookupTrace, type TraceOutput } from "../graph/tools.js";
import type { ToolDeps } from "./common.js";

/** Markdown mirror of the structured result, for clients that only show text content. */
function renderTraceText(o: TraceOutput): string {
  return [`# ${o.from} → ${o.to}`, "", o.result, "", `## Shortest path\n${o.shortest_path}`, "", `## Other paths\n${o.other_paths}`, "", o.complete_trace, "", o.tool_hint].join("\n");
}

export function register(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "trace",
    {
      title: "How does module A reach module B?",
      description:
        "Point-to-point call path between two modules: the shortest chain of calls from one to the other plus a few alternatives, with the call instruction and branch conditions at every hop. " +
        "Use it to answer 'what calls into this from over there' or to see which conditions gate a call. It also crosses between programs (a batch file running the launcher, the launcher running the game, the game raising a sound driver's interrupt) and marks each such hop. For every path from the program's entrypoints to one module, use `module` instead.",
      inputSchema: z.object({
        from: z.string().describe("Starting node: node name (MAIN_OVR-0020:1a2c) or an address copied from a listing (lcall 0x41, 0x25; 5cd:0634; 0016:0020)"),
        to: z.string().describe("Target node: node name or an address copied from a listing"),
      }),
      outputSchema: z.object({
        from: z.string(),
        to: z.string(),
        result: z.string().describe("Reachable or not, and in how many hops"),
        shortest_path: z.string().describe("The shortest call chain, hop by hop with call sites and conditions"),
        other_paths: z.string().describe("Alternative paths within two hops of the shortest"),
        complete_trace: z.string().describe("Resource handle with every path in full"),
        tool_hint: z.string(),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ from, to }) => {
      const result = lookupTrace(deps.graphContext(), { from, to });
      if (!result.ok) return { isError: true, content: [{ type: "text", text: result.error }] };
      return { structuredContent: { ...result.output }, content: [{ type: "text", text: renderTraceText(result.output) }] };
    },
  );
}
