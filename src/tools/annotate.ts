import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { addAnnotation } from "../progress/tools.js";
import type { ToolDeps } from "./common.js";

export function register(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "annotate",
    {
      description: "Save what you have learned about a module when you cannot implement it yet. Notes show up in the module's lookup so the next session does not re-derive them. Use it after real progress: what the function does, what it touches, which modules it relates to. Name the game the note is for (`tree`): node names repeat across games, and a note for another game's tree is refused.",
      inputSchema: z.object({
        tree: z.string().describe("The game tree the note is about, as its directory name: alpha, beta, … It must be this server's tree."),
        module: z.string().describe("Node name e.g. MAIN_EXE:5c10 or MAIN_OVR-0041:0a5c"),
        annotation_type: z
          .enum(["behavioral", "functional"])
          .describe(`Type of annotation:
            - behavioral - a behavioral description of the function: you have identified what purpose the function performs in the larger program, not only its local influence, for instance, that it is solely a participant in the operation of a single feature of the decompiled software
            - functional - a description of the function's operation: you have discovered broadly what data operations the function is doing, but have no broader context, for instance that it manipulates the EGA display adapter by reading data from a fixed location then making interrupt calls`),
        annotation_body: z
          .object({
            description: z.string(),
            references: z.array(
              z.object({
                reference_type: z.enum(["module", "freeform"]),
                reference_content: z.string(),
              }),
            ),
          })
          .describe(`The annotation description, as well as references to evidentiary information. reference_type is one of "module" or "freeform". "module" type references have a "reference_content" value of the exact node name and only that string. "freeform" type references can contain any text in "reference_content" and are intended for providing observations or freeform annotations.`),
      }),
      annotations: { openWorldHint: false },
    },
    async (args) => {
      const result = addAnnotation(deps.progressContext(), args);
      return result.ok ? { content: [{ type: "text", text: result.message }] } : { isError: true, content: [{ type: "text", text: result.error }] };
    },
  );
}
