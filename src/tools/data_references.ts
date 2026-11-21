import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { lookupDataReferences, renderDataReferencesText } from "../graph/datarefs.js";
import type { ToolDeps } from "./common.js";

export function register(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "data_references",
    {
      title: "Who reads, writes or calls through this data address?",
      description:
        "Give the address of a variable, table or stored pointer (ds:4f2a, or the operand as a listing shows it: [0x4f2a]) and get every instruction in the program that names it: which functions write it, read it, call or jump through it, or take its address, each with the instruction and its address. " +
        "Use it before translating code that depends on a global ('who sets this flag?', 'is this function pointer ever changed?', 'what else reads this buffer?') instead of searching listings. " +
        "It also points at tables indexed from just below the address. Accesses through a pointer are not visible to it, and it says so. For who calls a function, use `module`.",
      inputSchema: z.object({
        address: z.string().describe("Data address: ds:4f2a (the program's data segment), an operand or instruction pasted from a listing ([0x4f2a], mov ax, word ptr cs:[0x40]), or a segment as this server prints it (0714h:[0124], MAIN_OVR-0020:[000f]). Hex as written; a bare number needs 0x or an h suffix."),
      }),
      outputSchema: z.object({
        address: z.string().describe("The address as understood"),
        result: z.string().describe("How many instructions and functions name it, by kind of access"),
        references: z.string().describe("The first instructions that name it, writers first, each with its function and a link"),
        other_ways_in: z.string().describe("Tables that may reach it, the same offset through a segment register of unknown value, and what cannot be seen"),
        all_references: z.string().describe("Resource with every instruction, uncut"),
        tool_hint: z.string(),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ address }) => {
      const result = lookupDataReferences(deps.graphContext(), { address });
      if (!result.ok) return { isError: true, content: [{ type: "text", text: result.error }] };
      return { structuredContent: { ...result.output }, content: [{ type: "text", text: renderDataReferencesText(result.output) }] };
    },
  );
}
