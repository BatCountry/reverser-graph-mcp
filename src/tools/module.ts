import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { lookupModule, renderModuleText } from "../graph/tools.js";
import type { ToolDeps } from "./common.js";

export function register(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "module",
    {
      title: "Look up a function/module in the disassembly",
      description:
        "Start here for any code you are reading or porting. Give a node name (MAIN_OVR-0020:1a2c, MAIN_EXE:5c10) or paste an address straight from a listing (lcall 0x41, 0x25; 5cd:0634; MAIN_OVR-0020:1a4b) and get: its assembly listing, its callers and callees (each a link you can follow one hop at a time), " +
          "how the program reaches it from every entrypoint (call chains with the call sites and branch conditions), whether it is already implemented, and your earlier annotations. Addresses are hex as written.",
      inputSchema: z.object({
        module: z.string().describe("Node name (MAIN_OVR-0020:1a2c, MAIN_EXE:5c10) or an address copied from a listing: lcall 0x41, 0x25; 5cd:0634; 0016:0020. A call or branch address inside a function gives that function."),
      }),
      outputSchema: z.object({
        module: z.string().describe("Canonical node name"),
        summary: z.string().describe("What and where this node is"),
        implementation_status: z.string().describe("Registered implementations and annotations"),
        listing: z.string().describe("Link to this function's assembly listing"),
        callers: z.string().describe("Callers with call sites; each links to that module's own lookup"),
        callees: z.string().describe("Callees with call sites; each links to that module's own lookup"),
        entrypoint_traces: z.string().describe("Shortest call chain from each entrypoint to this module, nearest first, with a handle for the full detail"),
        tool_hint: z.string().describe("Suggested next steps"),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ module }) => {
      const result = lookupModule(deps.graphContext(), { module });
      if (!result.ok) return { isError: true, content: [{ type: "text", text: result.error }] };
      return { structuredContent: { ...result.output }, content: [{ type: "text", text: renderModuleText(result.output) }] };
    },
  );
}
