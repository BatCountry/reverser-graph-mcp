import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { lookupMemory } from "../memory/lookup.js";
import { asText, numberish, type ToolDeps } from "./common.js";

export function register(server: McpServer, _deps: ToolDeps): void {
  server.registerTool(
    "dos_memory_offset",
    {
      title: "What lives at this DOS memory address?",
      description:
        "Stop guessing what a segment or offset means. Give an address from the assembly (0xA000, B800:0160, 0040:006C, 0000:0084, 0xB8000) and get what lives there: " +
        "VGA/EGA/CGA/Hercules video RAM and how pixels are laid out, the BIOS data area field (keyboard flags, timer tick, video mode), the interrupt vector table slot for a given INT, the PSP, ROM fonts, boot sector. " +
        "Tolerant: 0xA0F8 resolves to the A000 graphics segment. A value up to 0xFFFF is read as a segment; larger (or hex written with 5+ digits, like 0xB8000) as a linear address; SEG:OFF is also accepted. Numbers must carry a hex marker (0xA000 or A000h); bare digits are rejected. Short answer inline, deep detail via dosref://memory/... resources.",
      inputSchema: z.object({
        offset: numberish.describe('Address: "0xA000" (segment), "B800:0160" (segment:offset; both parts are hex), or "0xB8000" (linear). Numbers need a hex marker (0x or h suffix); bare digits are rejected.'),
      }),
      outputSchema: z.object({
        offset: z.string().describe("The requested address normalised to SEGMENT:OFFSET"),
        role: z.string().describe("A brief description of the purpose of this memory segment"),
        documentation: z.string().describe("Documentation text with MCP Resource handles to expanded detail per section."),
        linear_address: z.string().describe("20-bit linear address in hex"),
        interpretation: z.string().describe("How the input was understood (segment, segment:offset, linear)"),
        matched_range: z.string().describe("The documented range the address fell into"),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ offset }) => {
      const result = lookupMemory(asText(offset));
      if (!result.ok) return { isError: true, content: [{ type: "text", text: result.error }] };
      const o = result.output;
      return {
        structuredContent: { ...o },
        content: [{ type: "text", text: `# ${o.offset} (${o.matched_range})\n\n${o.documentation}\n\nInterpreted as: ${o.interpretation}; linear ${o.linear_address}.` }],
      };
    },
  );
}
