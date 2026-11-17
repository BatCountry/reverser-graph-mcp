import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { addImplementation } from "../progress/tools.js";
import type { ToolDeps } from "./common.js";

export function register(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "add_implementation",
    {
      description:
        "Record that you finished reimplementing a module, so `module` shows it as done, `next_work` moves on, and you (or the next session) can find the code again. " +
        "Finished a whole work unit from `next_work`? Pass its id (work:MAIN_OVR-0020:33a0) to record every function in it at once. " +
        "The source file must contain a `/* Implements: ... */` block comment naming the module (for a work unit: the work unit id, or every function in it); the call is rejected, with the reason, if that comment or the function name is missing. " +
        "Each game has its own server and the same node names exist in every game, so say which game the work is for: a call naming another game's tree is refused and nothing is recorded.",
      inputSchema: z.object({
        tree: z.string().describe("The game tree you implemented this for, as its directory name: alpha, beta, … It must be this server's tree."),
        module: z.string().describe("Node name e.g. MAIN_EXE:5c10 or MAIN_OVR-0041:0a5c, or a work unit id from next_work e.g. work:MAIN_OVR-0020:33a0"),
        implementation_filename: z.string().describe("basename of the file that contains the implementation. do not use full path."),
        function_name: z.string().describe("the exact name of the function which contains the implementation"),
      }),
      annotations: { idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      const result = addImplementation(deps.progressContext(), args);
      return result.ok ? { content: [{ type: "text", text: result.message }] } : { isError: true, content: [{ type: "text", text: result.error }] };
    },
  );
}
