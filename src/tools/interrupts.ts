import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { queryCache } from "../cache.js";
import { getInterruptDb } from "../interrupts/db.js";
import { lookupInterrupt, type InterruptOutput } from "../interrupts/lookup.js";
import { asText, numberish, type ToolDeps } from "./common.js";

/** Markdown mirror of the structured result, for clients that only show text content. */
function renderOutputText(o: InterruptOutput): string {
  const regs = (rows: Array<{ register: string; value?: string; register_purpose: string }>) =>
    rows.map((r) => `- ${r.register}${r.value ? ` = ${r.value}` : ""}: ${r.register_purpose}`).join("\n") || "- (none)";
  return [
    `# ${o.interrupt}`,
    "",
    o.register_invocation_documentation,
    "",
    "## Register inputs",
    regs(o.register_inputs),
    "",
    "## Register outputs",
    regs(o.register_outputs),
    "",
    o.complete_documentation,
    "",
    "## Refine your query",
    o.tool_hint,
  ].join("\n");
}

export function register(server: McpServer, _deps: ToolDeps): void {
  const RegisterDoc = z.object({
    register: z.string(),
    value: z.string().optional(),
    register_purpose: z.string(),
  });
  server.registerTool(
    "interrupts",
    {
      title: "Explain an INT instruction (DOS, BIOS, mouse, EMS)",
      description:
        "Decode an `INT nn` from MS-DOS-era code: what it does, which registers it reads and writes, and where to read more. Covers DOS (INT 21h, 20h, 25h-2Fh), BIOS/hardware (10h video, 13h disk, 16h keyboard, 1Ah clock, 11h/12h, 15h, 08h-0Fh IRQs), mouse (33h), EMS (67h) and DPMI (31h). " +
        "Pass the interrupt plus the registers set just before it, e.g. interrupt 0x21 with AH=0x4C, or AX=0x4C0A, or INT 33h AX=0x0003. " +
        "More precise registers give a more precise answer (AH 0x3D -> Open File; add AL for access mode); with few registers you get the function family and a list of values worth supplying next.",
      inputSchema: z.object({
        interrupt: numberish.describe('Which interrupt: for INT 10h, specify "0x10" ("10h" and "INT 10h" also accepted). Hex needs a marker: 0x21 or 21h; bare digits like "21" are rejected.'),
        registers: z
          .array(
            z.object({
              register: z.string().describe("Register: AX, AH, AL, BX, BH, BL, CX, CH, CL, DX, DH, DL, SI, DI, BP, SP, ES, DS (E-prefixed 32-bit forms use the low 16 bits)."),
              value: numberish.optional().describe('Exact value held at the call site: hex with a marker, "0x4C" or "4Ch". Omit if unknown.'),
            }),
          )
          .optional()
          .describe("Registers populated immediately before the interrupt call, provided for search context."),
      }),
      outputSchema: z.object({
        interrupt: z.string().describe("Canonical name of the interrupt, e.g. `Interrupt 21h - MS-DOS Function Calls`"),
        register_inputs: z.array(RegisterDoc).describe("Registers the call reads. `value` appears when your query matched or supplied one, with its meaning."),
        register_outputs: z.array(RegisterDoc).describe("Registers (and flags) the call writes, and their significance."),
        register_invocation_documentation: z.string().describe("Plain-English explanation of the most specific operation the supplied registers identify; for partial context, the function family and which extra register values would pin it down."),
        complete_documentation: z.string().describe("Markdown list of dosref:// resource URIs with fuller documentation for this call and its family."),
        tool_hint: z.string().describe("Markdown steering: which additional registers/values would sharpen the lookup, and nearby alternatives."),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ interrupt, registers }) => {
      const result = lookupInterrupt(getInterruptDb(), queryCache, {
        interrupt: asText(interrupt),
        registers: registers?.map((r) => ({ register: r.register, value: asText(r.value) })),
      });
      if (!result.ok) return { isError: true, content: [{ type: "text", text: result.error }] };
      return { structuredContent: { ...result.output }, content: [{ type: "text", text: renderOutputText(result.output) }] };
    },
  );
}
