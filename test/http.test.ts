import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { z } from "zod";
import { TtlCache } from "../src/cache.js";
import { startHttp, type RunningHttp } from "../src/http/server.js";
import { CallGraph } from "../src/graph/model.js";
import type { Context } from "../src/graph/tools.js";
import { ProgressStore } from "../src/progress/store.js";
import { IDS, makeFixture, type Fixture } from "./fixture.js";

const WEB = path.resolve("web");

/** Raw request so Host/Origin can be set freely (fetch forbids overriding Host). */
function raw(url: string, opts: { method?: string; headers?: Record<string, string> } = {}): Promise<{ status: number; type: string; body: string }> {
  const { promise, resolve, reject } = Promise.withResolvers<{ status: number; type: string; body: string }>();
  const req = request(url, { method: opts.method ?? "GET", headers: opts.headers }, (res) => {
    let body = "";
    res.setEncoding("utf8");
    res.on("data", (c: string) => (body += c));
    res.on("end", () => resolve({ status: res.statusCode ?? 0, type: String(res.headers["content-type"] ?? ""), body }));
  });
  req.on("error", reject);
  req.end();
  return promise;
}

const tinyServer = () => {
  const server = new McpServer({ name: "t", version: "0" });
  server.registerTool("echo", { description: "echo back", inputSchema: z.object({ text: z.string() }) }, ({ text }) => ({ content: [{ type: "text", text }] }));
  return server;
};

describe("startHttp (in process)", () => {
  let fx: Fixture;
  let http: RunningHttp;
  let failContext = false;
  const errors: Error[] = [];

  beforeAll(async () => {
    fx = makeFixture();
    const ctx: Context = { graph: CallGraph.load(fx.disassembly), disassemblyRoot: fx.disassembly, progress: new ProgressStore(fx.progressFile), cache: new TtlCache() };
    http = await startHttp({
      port: 0,
      mcp: tinyServer,
      context: () => {
        if (failContext) throw new Error("no callgraph.json here");
        return ctx;
      },
      webRoot: WEB,
      onerror: (e) => errors.push(e),
    });
  });
  afterAll(async () => {
    await http?.close();
  });

  test("serves the page and its assets with their types", async () => {
    for (const [p, type] of [["/", "text/html"], ["/index.html", "text/html"], ["/app.js", "text/javascript"], ["/app.css", "text/css"]] as const) {
      const r = await raw(`${http.url}${p}`);
      expect(r.status, p).toBe(200);
      expect(r.type).toContain(type);
    }
  });

  test.each(["/nope", "/web/app.js", "/../package.json", "/%2e%2e/package.json", "/app.js/", "/index.htm"])("only the listed assets are served: %s", async (p) => {
    expect((await raw(`${http.url}${p}`)).status).toBe(404);
  });

  test("API routes return JSON", async () => {
    const summary = JSON.parse((await raw(`${http.url}/api/summary`)).body);
    expect(summary.functions.total).toBe(9);
    expect(summary.gameName).toBeNull(); // no --game-name: no title
    expect(JSON.parse((await raw(`${http.url}/api/modules`)).body).modules).toHaveLength(9);
    expect(JSON.parse((await raw(`${http.url}/api/units`)).body).units).toHaveLength(6);
    expect(JSON.parse((await raw(`${http.url}/api/version`)).body).version).toEqual(expect.any(String));
    const a = await raw(`${http.url}/api/modules/${encodeURIComponent(IDS.A)}`);
    expect(a.type).toContain("application/json");
    expect(JSON.parse(a.body).id).toBe(IDS.A);
    expect(JSON.parse((await raw(`${http.url}/api/modules/${encodeURIComponent("0016:0020")}?x=1`)).body).id).toBe(IDS.A);
  });

  test.each([
    ["/api/modules/%E0%A4%A", 400, /not valid URL encoding/],
    ["/api/modules/%", 400, /not valid URL encoding/],
    ["/api/modules/nope", 404, /No graph node/],
    ["/api/modules/", 404, /No API route/],
    ["/api/", 404, /No API route/],
    ["/api/summary/extra", 404, /No API route/],
    ["/api/SUMMARY", 404, /No API route/],
  ])("%s answers %i with an explanation", async (p, status, message) => {
    const r = await raw(`${http.url}${p}`);
    expect(r.status).toBe(status);
    expect(JSON.parse(r.body).error).toMatch(message);
  });

  test("the dashboard is read-only; HEAD has no body", async () => {
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) expect((await raw(`${http.url}/api/summary`, { method })).status, method).toBe(405);
    expect((await raw(`${http.url}/`, { method: "POST" })).status).toBe(405);
    const head = await raw(`${http.url}/api/summary`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.body).toBe("");
  });

  test("foreign Host and Origin headers are rejected (DNS rebinding)", async () => {
    expect((await raw(`${http.url}/api/summary`, { headers: { Host: "evil.example" } })).status).toBe(403);
    expect((await raw(`${http.url}/mcp`, { method: "POST", headers: { Host: "evil.example" } })).status).toBe(403);
    expect((await raw(`${http.url}/api/summary`, { headers: { Origin: "http://evil.example" } })).status).toBe(403);
    expect((await raw(`${http.url}/api/summary`, { headers: { Origin: "not a url" } })).status).toBe(403);
    expect((await raw(`${http.url}/api/summary`, { headers: { Origin: "http://localhost:5173" } })).status).toBe(200);
    expect((await raw(`${http.url}/api/summary`, { headers: { Host: "localhost" } })).status).toBe(200);
  });

  test("a missing disassembly tree is a 503 with the reason, not a crash", async () => {
    failContext = true;
    try {
      const r = await raw(`${http.url}/api/summary`);
      expect(r.status).toBe(503);
      expect(JSON.parse(r.body).error).toContain("no callgraph.json here");
      expect((await raw(`${http.url}/`)).status).toBe(200);
    } finally {
      failContext = false;
    }
  });

  test("MCP over streamable HTTP at /mcp", async () => {
    const client = new Client({ name: "http-test", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${http.url}/mcp`)));
    try {
      expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["echo"]);
      const r = await client.callTool({ name: "echo", arguments: { text: "hi" } });
      expect(r.content).toEqual([{ type: "text", text: "hi" }]);
    } finally {
      await client.close();
    }
  });

  test("a port in use rejects instead of serving nothing", async () => {
    const port = Number(new URL(http.url).port);
    await expect(startHttp({ port, mcp: tinyServer, context: () => { throw new Error("unused"); }, webRoot: WEB, onerror: () => {} })).rejects.toThrow(/EADDRINUSE/);
  });
});

test("a missing asset file is a 500 and reported", async () => {
  const errors: Error[] = [];
  const http = await startHttp({ port: 0, mcp: tinyServer, context: () => { throw new Error("unused"); }, webRoot: mkdtempSync(path.join(tmpdir(), "rpg-web-")), onerror: (e) => errors.push(e) });
  try {
    const r = await raw(`${http.url}/app.js`);
    expect(r.status).toBe(500);
    expect(JSON.parse(r.body).error).toMatch(/Internal error/);
    expect(errors[0]?.message).toMatch(/ENOENT/);
  } finally {
    await http.close();
  }
});

// ---------------------------------------------------------------- the built server with --dashboard

describe("build/index.js --dashboard", () => {
  const SERVER = path.resolve("build/index.js");
  let child: ChildProcess;
  let url: string;
  let fx: Fixture;

  beforeAll(async () => {
    if (!existsSync(SERVER)) throw new Error("build/index.js missing: run `npm run build` (npm test does this)");
    fx = makeFixture();
    writeFileSync(path.join(fx.implementation, "src", "d.cpp"), `/* Implements: ${IDS.D} */\nvoid d_fn() {}\n`);
    child = spawn(process.execPath, [SERVER, "--disassembly-root", fx.disassembly, "--dashboard", "--game-name", "Example Game"], { stdio: ["ignore", "ignore", "pipe"] });
    const { promise, resolve, reject } = Promise.withResolvers<string>();
    let log = "";
    child.stderr!.setEncoding("utf8").on("data", (c: string) => {
      log += c;
      const m = /dashboard at (http:\/\/\S+?)\/ and MCP/.exec(log);
      if (m) resolve(m[1]!);
    });
    child.once("exit", (code) => reject(new Error(`server exited (${code}): ${log}`)));
    url = await promise;
  }, 30_000);
  afterAll(() => {
    child?.kill("SIGTERM");
  });

  test("the real tools over HTTP, and the dashboard sees what they record", async () => {
    const client = new Client({ name: "http-e2e", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`)));
    try {
      expect((await client.listTools()).tools.map((t) => t.name)).toContain("next_work");
      const before = JSON.parse((await raw(`${url}/api/summary`)).body);
      expect(before.functions.implemented).toBe(0);
      expect(before.gameName).toBe("Example Game");
      const r = await client.callTool({ name: "add_implementation", arguments: { tree: path.basename(fx.disassembly), module: IDS.D, implementation_filename: "src/d.cpp", function_name: "d_fn" } });
      expect(r.isError).toBeFalsy();
    } finally {
      await client.close();
    }
    const after = JSON.parse((await raw(`${url}/api/summary`)).body);
    expect(after.functions.implemented).toBe(1);
    expect(after.version).not.toBe("");
    expect((await raw(`${url}/`)).body).toContain("<script type=\"module\" src=\"/app.js\">");
  });

  const failsToStart = async (args: string[]) => {
    const bad = spawn(process.execPath, [SERVER, "--disassembly-root", fx.disassembly, ...args], { stdio: ["ignore", "ignore", "pipe"] });
    let log = "";
    bad.stderr!.setEncoding("utf8").on("data", (c: string) => (log += c));
    const [code] = await once(bad, "exit");
    expect(code).not.toBe(0);
    return log;
  };

  test("an unusable --port stops startup with the reason", async () => {
    expect(await failsToStart(["--dashboard", "--port", "70000"])).toMatch(/--port must be a decimal port number/);
  });

  test("a port already in use stops startup with the reason", async () => {
    expect(await failsToStart(["--dashboard", "--port", new URL(url).port])).toMatch(/cannot listen on 127\.0\.0\.1:\d+: .*EADDRINUSE/);
  });
});
