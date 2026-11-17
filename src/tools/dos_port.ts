import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { lookupPort } from "../ports/lookup.js";
import { asText, numberish, type ToolDeps } from "./common.js";

export function register(server: McpServer, _deps: ToolDeps): void {
  server.registerTool(
    "dos_port",
    {
      title: "What does this IN/OUT port do?",
      description:
        "Decode an I/O port access from DOS-era code: `out dx,al` with DX=0x3C4, `in al,0x3DA`, `out 0x61,al`, `out 0xC0,al`. Tells you which device it is (VGA/EGA sequencer, graphics controller, CRTC, attribute controller, DAC palette, CGA/MDA, PIT timer and PC speaker, keyboard, PIC, joystick, Tandy/PCjr SN76496 sound chip, AdLib) and what the register does. " +
        "Pass `value` (the byte or word being written) to get every bit decoded; for index/data pairs (3C4/3C5, 3CE/3CF, 3D4/3D5, 3C0) also pass `index`, or send a 16-bit OUT to the index port (value 0x0F02 to 0x3C4 = index 02h Map Mask, data 0Fh). " +
        "Numbers must carry a hex marker (0x3C4 or 3C4h); bare digits are rejected.",
      inputSchema: z.object({
        port: numberish.describe('I/O port address, e.g. "0x3C4" or "3DAh". Hex needs 0x or an h suffix.'),
        index: numberish.optional().describe("Register index previously written to the paired index port (for data ports 3C5, 3CF, 3D5/3B5, 3C0/3C1). Hex needs 0x or h."),
        value: numberish.optional().describe("Byte (or 16-bit word for OUT DX,AX) being written or read. Hex needs 0x or h."),
      }),
      outputSchema: z.object({
        port: z.string().describe("The port and the register/device it addresses"),
        role: z.string().describe("A brief description of the register's purpose"),
        access: z.enum(["read", "write", "read/write", "unknown"]).describe("Whether software reads it, writes it, or both"),
        documentation: z.string().describe("Register documentation, bit decoding of `value` when given, and dosref://port/... resource links for the full register family."),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ port, index, value }) => {
      const result = lookupPort({ port: asText(port), index: asText(index), value: asText(value) });
      if (!result.ok) return { isError: true, content: [{ type: "text", text: result.error }] };
      const o = result.output;
      return {
        structuredContent: { ...o },
        content: [{ type: "text", text: `# ${o.port}

${o.role} (${o.access})

${o.documentation}` }],
      };
    },
  );
}
