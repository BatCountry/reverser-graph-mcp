import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { queryCache } from "./cache.js";
import { loadConfig } from "./config.js";
import { getCallGraph } from "./graph/model.js";
import { startHttp } from "./http/server.js";
import { treeName, type Context } from "./graph/tools.js";
import { getSameCode, getWorkPlan } from "./graph/workplan-cache.js";
import { ProgressStore } from "./progress/store.js";
import type { ProgressContext } from "./progress/tools.js";
import { getCorrespondence } from "./compare/correspond.js";
import { compareUris } from "./compare/render.js";
import { registerCompareResources, registerResources } from "./resources.js";
import { instrumentServer, startTelemetry } from "./telemetry.js";
import { register as addImplementation } from "./tools/add_implementation.js";
import { register as annotate } from "./tools/annotate.js";
import type { ToolDeps } from "./tools/common.js";
import { register as dataReferences } from "./tools/data_references.js";
import { register as dosMemoryOffset } from "./tools/dos_memory_offset.js";
import { register as dosPort } from "./tools/dos_port.js";
import { register as interrupts } from "./tools/interrupts.js";
import { register as compareTool } from "./tools/compare.js";
import { register as counterpart } from "./tools/counterpart.js";
import { register as moduleTool } from "./tools/module.js";
import { register as nextWork } from "./tools/next_work.js";
import { register as trace } from "./tools/trace.js";

const config = loadConfig();
const VERSION = "1.0.0";
const telemetry = startTelemetry(VERSION);

const INSTRUCTIONS = `Reference helper for reverse engineering MS-DOS-era programs (real-mode x86 assembly, BIOS/DOS/mouse/EMS interrupts, PC memory map).
- Numbers: always write hex with a marker, 0x4C or 4Ch; bare digits like "76" are rejected. (SEG:OFF addresses such as B800:0160 and far calls such as 0016:0020 are hex as written.)
- Stuck on an \`INT nn\` in assembly? Call \`interrupts\` with the interrupt and the registers loaded just before it (AH=0x4C, AX=0x4C0A, ...). You get what the call does, what it returns, and links to deeper pages.
- Seeing writes to segments like 0xA000/0xB800 or odd 0040:xxxx / 0000:xxxx accesses? Call \`dos_memory_offset\` to learn what lives at that address (video RAM layout, BIOS data area, interrupt vector table, ROM font, ...).
- Seeing \`IN\`/\`OUT\` on a port (3C4h/3C5h, 3C8h, 3DAh, 61h, 0C0h, 201h)? Call \`dos_port\` with the port; add the AL/AX value being written and, for indexed registers, the index, to get the bit-by-bit meaning (VGA/EGA/CGA video, palette, PIT/speaker, keyboard, PIC, joystick, Tandy/PCjr SN76496 sound).
- Results are short on purpose. Follow the dosref:// resource links for full interrupt entries, walkthroughs, assembler reference notes, field tables and video-mode tables, only when you need them.
- Working in the disassembly? Call \`module\` with a node name or any address pasted from a listing (lcall 0x41, 0x25; 5cd:0634): listing, callers/callees, how every entrypoint reaches it, and implementation status. \`trace\` gives the call path between two modules. When you finish a module call \`add_implementation\`; when you only learn something call \`annotate\`. (Disassembly tree: ${config.disassemblyRoot}.)
- Wondering who else touches a variable or table (\`mov word ptr [0x4f2a], ax\`, \`lcall [0x4f20]\`)? Call \`data_references\` with the address (ds:4f2a): every instruction in the program that reads it, writes it, calls or jumps through it or takes its address, by function.
- Reimplementing the program and unsure where to go next? Call \`next_work\`: it hands you the next bite-sized work unit (a function plus helpers only it uses), preferring ones whose callees are already done, and how to record it when finished.`;

/** Compare mode: what the extra tools are for, appended to the instructions. */
const COMPARE_INSTRUCTIONS = (a: string, b: string) => `
- Comparing two games (${a}, this tree, and ${b})? Call \`counterpart\` with a function of either game: its counterpart in the other, how alike they are, what changed side by side, and which callees correspond. \`compare\` puts any two functions side by side. ${compareUris(a, b).map("changed", 1)} lists every function whose code differs between the games.`;

const progressStore = new ProgressStore(config.progressFile);
const workOptions = { budgetLines: config.workBudgetLines, trivialLines: config.workTrivialLines };
const compare = config.compare && {
  names: [treeName(config.disassemblyRoot), config.compare.name] as const,
  correspondence: () => getCorrespondence(config.disassemblyRoot, config.compare!.root, workOptions, getCallGraph(config.disassemblyRoot)),
};
const comparing = config.compare ? `, compare=${config.compare.root}` : "";

/** The call graph is loaded on first use so interrupt/port/memory lookups work without a disassembly tree. */
function graphContext(): Context {
  return {
    graph: getCallGraph(config.disassemblyRoot),
    disassemblyRoot: config.disassemblyRoot,
    progress: progressStore,
    cache: queryCache,
    workOptions,
  };
}

function progressContext(): ProgressContext {
  return {
    tree: treeName(config.disassemblyRoot),
    graph: getCallGraph(config.disassemblyRoot),
    progress: progressStore,
    implementationRoot: config.implementationRoot,
    workPlan: () => getWorkPlan(graphContext()),
    sameCode: () => getSameCode(graphContext()),
  };
}

function createServer() {
  const server = new McpServer(
    { name: "reverser-progress-graph", version: VERSION },
    {
      instructions: compare ? INSTRUCTIONS + COMPARE_INSTRUCTIONS(...compare.names) : INSTRUCTIONS,
      cacheHints: {
        "tools/list": { ttlMs: 60 * 60_000, cacheScope: "public" },
        "resources/list": { ttlMs: 60 * 60_000, cacheScope: "public" },
        "resources/templates/list": { ttlMs: 60 * 60_000, cacheScope: "public" },
        "server/discover": { ttlMs: 60 * 60_000, cacheScope: "public" },
      },
    },
  );
  if (telemetry) instrumentServer(server, telemetry);
  registerResources(server, graphContext, treeName(config.disassemblyRoot));
  if (compare) registerCompareResources(server, compare.names, compare.correspondence);

  const deps: ToolDeps = { graphContext, progressContext, ...(compare ? { compare } : {}) };
  for (const register of [dosMemoryOffset, dosPort, interrupts, moduleTool, trace, dataReferences, nextWork, addImplementation, annotate, counterpart, compareTool]) register(server, deps);

  return server;
}

const onerror = (error: Error) => console.error("reverser-progress-graph error:", error);
let stopHttp: (() => Promise<void>) | undefined;
if (config.dashboard) {
  const { port } = config.dashboard;
  try {
    const http = await startHttp({ port, mcp: createServer, context: graphContext, webRoot: fileURLToPath(new URL("../web/", import.meta.url)), buildRoot: fileURLToPath(new URL("./", import.meta.url)), onerror, compare: compare?.correspondence, gameName: config.gameName });
    stopHttp = http.close;
    console.error(`reverser-progress-graph dashboard at ${http.url}/ and MCP (streamable HTTP) at ${http.url}/mcp (disassembly_root=${config.disassemblyRoot}, progress=${config.progressFile}${comparing})`);
  } catch (error) {
    console.error(`reverser-progress-graph: cannot listen on 127.0.0.1:${port}: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
} else {
  serveStdio(createServer, { onerror });
  console.error(`reverser-progress-graph MCP Server running on stdio (disassembly_root=${config.disassemblyRoot}, progress=${config.progressFile}${comparing})`);
}
if (telemetry) {
  console.error("reverser-progress-graph: exporting OpenTelemetry (OTEL_EXPORTER_OTLP_* set)");
  // flush buffered spans/metrics however the client ends us: stdin closing drains the loop; signals do not
  process.once("beforeExit", () => void telemetry.shutdown());
}
if (telemetry || stopHttp) {
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => void Promise.allSettled([stopHttp?.(), telemetry?.shutdown()]).finally(() => process.exit(0)));
  }
}
