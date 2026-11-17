import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { IDS, makeFixture, type Fixture } from "./fixture.js";

// Drives the BUILT server (build/index.js; `npm test` builds first) over real stdio against a fixture tree.
const SERVER = path.resolve("build/index.js");
/** the fixture tree's directory is `disassembly`, so its resources live under disasm://disassembly/ */
const DISASM = "disasm://disassembly/";

let fx: Fixture;
let client: Client;

const text = (r: unknown): string => {
  const content = (r as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.map((c) => c.text ?? "").join("\n");
};

beforeAll(async () => {
  if (!existsSync(SERVER)) throw new Error("build/index.js missing: run `npm run build` (npm test does this)");
  fx = makeFixture();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER, "--disassembly-root", fx.disassembly],
    stderr: "pipe",
  });
  client = new Client({ name: "integration-test", version: "0.0.0" });
  await client.connect(transport);
}, 30_000);

afterAll(async () => {
  await client?.close();
});

describe("tools and discovery", () => {
  test("every advertised tool is listed", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["add_implementation", "annotate", "dos_memory_offset", "dos_port", "interrupts", "module", "next_work", "trace"]);
    for (const t of tools) expect(t.description?.length ?? 0).toBeGreaterThan(40);
  });
  test("resource templates cover reference docs and disassembly", async () => {
    const { resourceTemplates } = await client.listResourceTemplates();
    const names = resourceTemplates.map((t) => t.uriTemplate);
    for (const expected of ["dosref://entry/{id}", "dosref://port/{group}", "dosref://query/{handle}", `${DISASM}module/{id}`, `${DISASM}trace/{handle}`, `${DISASM}listing/{id}`, `${DISASM}work-unit/{id}`]) {
      expect(names).toContain(expected);
    }
  });
  test("next_work names a work unit whose detail and the ranked queue read back", async () => {
    const r = await client.callTool({ name: "next_work", arguments: {} });
    expect(text(r)).toContain(`# work:${IDS.D}\n`);
    expect(text(r)).toContain(`${DISASM}work-plan`);
    const { resources } = await client.listResources();
    expect(resources.map((x) => x.uri)).toContain(`${DISASM}work-plan`);
    const plan = await client.readResource({ uri: `${DISASM}work-plan` });
    expect(JSON.stringify(plan.contents)).toContain("# Work plan");
    const unit = await client.readResource({ uri: `${DISASM}work-unit/${encodeURIComponent(`work:${IDS.D}`)}` });
    expect(JSON.stringify(unit.contents)).toContain(`# work:${IDS.D}`);
    const bad = await client.callTool({ name: "next_work", arguments: { module: "nope" } });
    expect((bad as { isError?: boolean }).isError).toBe(true);
  });
  test("interrupts, memory and port lookups work end to end", async () => {
    const i = await client.callTool({ name: "interrupts", arguments: { interrupt: "0x21", registers: [{ register: "AX", value: "0x4C0A" }] } });
    expect(text(i)).toContain("TERMINATE WITH RETURN CODE");
    const m = await client.callTool({ name: "dos_memory_offset", arguments: { offset: "0xA000" } });
    expect(text(m)).toContain("EGA/VGA");
    const p = await client.callTool({ name: "dos_port", arguments: { port: "0x3C4", value: "0x0F02" } });
    expect(text(p)).toContain("Map Mask");
    const bad = await client.callTool({ name: "dos_port", arguments: { port: "3C4" } });
    expect((bad as { isError?: boolean }).isError).toBe(true);
    // a JSON number is still a bare number: refused with guidance rather than guessed
    const bare = await client.callTool({ name: "interrupts", arguments: { interrupt: 33 } });
    expect((bare as { isError?: boolean }).isError).toBe(true);
    expect(text(bare)).toContain("write 0x33 or 33h");
  });
});

describe("query handles are live within a session", () => {
  test("interrupts ranked-candidates handle can be read back, an unknown one errors", async () => {
    const r = await client.callTool({ name: "interrupts", arguments: { interrupt: "0x21", registers: [{ register: "AH", value: "0x3D" }] } });
    const uri = /dosref:\/\/query\/[\w-]+/.exec(text(r))?.[0];
    expect(uri).toBeDefined();
    const read = await client.readResource({ uri: uri! });
    expect(read.contents[0]).toMatchObject({ mimeType: "text/markdown" });
    expect(JSON.stringify(read.contents)).toContain("INT 21h");
    await expect(client.readResource({ uri: "dosref://query/deadbeef" })).rejects.toThrow(/expired or never existed/);
  });
  test("module's entrypoint trace handle reads back, and so does a neighbour's module resource", async () => {
    const r = await client.callTool({ name: "module", arguments: { module: IDS.D } });
    const out = text(r);
    const trace = /disasm:\/\/disassembly\/trace\/[\w-]+/.exec(out)?.[0];
    expect(trace).toBeDefined();
    expect(JSON.stringify((await client.readResource({ uri: trace! })).contents)).toContain("Entrypoint traces to module-0002:0040");
    const neighbour = /disasm:\/\/disassembly\/module\/[^\s]+/.exec(out)?.[0];
    expect(JSON.stringify((await client.readResource({ uri: neighbour! })).contents)).toContain("# module-0002:0030");
  });
  test("module takes an address pasted from a listing and says how it read it", async () => {
    const out = text(await client.callTool({ name: "module", arguments: { module: "CALL 0x2000:0040" } }));
    expect(out).toContain(`# ${IDS.D}`);
    expect(out).toContain(`"CALL 0x2000:0040" read as ${IDS.D}.`);
    expect(await client.callTool({ name: "module", arguments: { ghidra: IDS.D } })).toMatchObject({ isError: true });
  });
  test("a function's listing reads back with call targets marked; non-functions, old kind URIs and other trees are rejected", async () => {
    const a = JSON.stringify((await client.readResource({ uri: `${DISASM}listing/${encodeURIComponent(IDS.A)}` })).contents);
    expect(a).toContain("push bp");
    expect(a).toContain(`call 0x20\\t; → ${IDS.B}`);
    await expect(client.readResource({ uri: `${DISASM}listing/${encodeURIComponent(IDS.D)}` })).rejects.toThrow(/module-0002:0040 has no listing on disk/);
    await expect(client.readResource({ uri: `${DISASM}listing/${encodeURIComponent(IDS.ADDR)}` })).rejects.toThrow(/module-0002:0099 is not a function \(kind: address\)/);
    await expect(client.readResource({ uri: `${DISASM}listing/nope` })).rejects.toThrow(/No graph node "nope"/);
    await expect(client.readResource({ uri: `${DISASM}listing/ghidra/${encodeURIComponent(IDS.A)}` })).rejects.toThrow();
    await expect(client.readResource({ uri: `${DISASM}unit/game-ovr/blocks` })).rejects.toThrow();
    // URIs name their tree: the unscoped form and another game's tree are not this server's
    await expect(client.readResource({ uri: `disasm://listing/${encodeURIComponent(IDS.A)}` })).rejects.toThrow();
    await expect(client.readResource({ uri: `disasm://beta/listing/${encodeURIComponent(IDS.A)}` })).rejects.toThrow();
  });
  test("a line range after the id, as omp's read tool writes it, returns just those lines with their targets marked", async () => {
    const read = async (uri: string) => {
      const content = (await client.readResource({ uri })).contents[0];
      return content && "text" in content ? content.text : "";
    };
    const lines = (await read(`${DISASM}listing/${encodeURIComponent(IDS.A)}:4-5`)).split("\n");
    expect(lines[0]).toBe(`; ${IDS.A}, lines 4-5 of 6`);
    // A is reached through a stub table: that line comes first, then the arrow legend, then the lines
    expect(lines[1]).toMatch(/^; Other code reaches it through a stub table as `lcall 0x16, 0x20`/);
    expect(lines.slice(3)).toEqual([`0012  e80b00      call 0x20\t; → ${IDS.B}`, `0014  e81900      call 0x30\t; → ${IDS.C}`]);
    // the colon may arrive encoded too; a range past the end is cut and says so; -N counts from the end
    expect(await read(`${DISASM}listing/${encodeURIComponent(`${IDS.A}:5-80`)}`)).toContain(`; ${IDS.A}, lines 5-6 of 6 (the listing ends there)`);
    const last = (await read(`${DISASM}listing/${encodeURIComponent(IDS.A)}:-1`)).split("\n");
    expect([last[0], last.at(-1)]).toEqual([`; ${IDS.A}, lines 6-6 of 6`, "0017  cb          retf"]);
    await expect(client.readResource({ uri: `${DISASM}listing/${encodeURIComponent(IDS.A)}:9-12` })).rejects.toThrow(/starts past the end: the listing has 6 lines\. The whole listing is disasm:\/\/disassembly\/listing\/module-0001%3A0010/);
    // a comma list only reaches the server encoded (a raw comma does not match the URI template)
    await expect(client.readResource({ uri: `${DISASM}listing/${encodeURIComponent(`${IDS.A}:1-3,5-6`)}` })).rejects.toThrow(/is not a line range: use N-M/);
    await expect(client.readResource({ uri: `${DISASM}listing/${encodeURIComponent(IDS.ADDR)}:1-5` })).rejects.toThrow(/is not a function/);
    await expect(client.readResource({ uri: `${DISASM}listing/nope:1-5` })).rejects.toThrow(/No graph node "nope:1-5"/);
  });
});

describe("progress graph through the tools", () => {
  test("trace tool", async () => {
    const r = await client.callTool({ name: "trace", arguments: { from: IDS.R, to: IDS.D } });
    expect(text(r)).toContain("3 hops");
  });
  test("add_implementation rejects until the Implements comment names the module, then module shows it", async () => {
    const tree = path.basename(fx.disassembly);
    const wrong = await client.callTool({ name: "add_implementation", arguments: { tree: "beta", module: IDS.A, implementation_filename: "src/render.cpp", function_name: "draw_frame" } });
    expect(wrong).toMatchObject({ isError: true });
    expect(text(wrong)).toContain(`This server records progress for "${tree}" only`);
    const bad = await client.callTool({ name: "add_implementation", arguments: { tree, module: IDS.A, implementation_filename: "bare.cpp", function_name: "nothing" } });
    expect((bad as { isError?: boolean }).isError).toBe(true);
    expect(text(bad)).toContain("no `/* Implements");
    const missing = await client.callTool({ name: "add_implementation", arguments: { tree, module: IDS.A, implementation_filename: "nowhere.cpp", function_name: "x" } });
    expect(text(missing)).toContain("No file named");

    const good = await client.callTool({ name: "add_implementation", arguments: { tree, module: IDS.A, implementation_filename: "src/render.cpp", function_name: "draw_frame" } });
    expect((good as { isError?: boolean }).isError).toBeUndefined();
    expect(text(good)).toContain("Recorded draw_frame");
    expect(text(await client.callTool({ name: "module", arguments: { module: IDS.A } }))).toContain("Implemented: draw_frame in");
    // implemented modules are marked inside other modules' neighbour lists and traces
    expect(text(await client.callTool({ name: "module", arguments: { module: IDS.B } }))).toContain(`${IDS.A} (implemented)`);
  });
  test("add_implementation with a work unit id completes it and next_work moves on", async () => {
    const unit = `work:${IDS.D}`;
    const tree = path.basename(fx.disassembly);
    expect(text(await client.callTool({ name: "next_work", arguments: { module: unit } }))).toContain(`Call add_implementation with tree "${tree}", module "${unit}"`);
    writeFileSync(path.join(fx.implementation, "src", "leaf.cpp"), `/* Implements: ${unit} */\nvoid leaf() {}\n`);
    const r = await client.callTool({ name: "add_implementation", arguments: { tree, module: unit, implementation_filename: "leaf.cpp", function_name: "leaf" } });
    expect(text(r)).toContain(`as the implementation of ${unit}: 1 function member`);
    const next = text(await client.callTool({ name: "next_work", arguments: {} }));
    expect(next).not.toContain(`# ${unit}\n`);
    expect(text(await client.callTool({ name: "module", arguments: { module: IDS.D } }))).toContain(`Work unit: ${unit} (1 member, 0 lines, complete)`);
  });
  test("annotate persists and is shown by module", async () => {
    const a = await client.callTool({
      name: "annotate",
      arguments: { tree: path.basename(fx.disassembly), module: IDS.B, annotation_type: "functional", annotation_body: { description: "copies a row to B800", references: [{ reference_type: "module", reference_content: IDS.C }] } },
    });
    expect((a as { isError?: boolean }).isError).toBeUndefined();
    expect(text(await client.callTool({ name: "module", arguments: { module: IDS.B } }))).toContain("copies a row to B800");
  });
});
