import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, type McpServerFactory } from "@modelcontextprotocol/server";
import type { Correspondence } from "../compare/correspond.js";
import { mapRows } from "../compare/render.js";
import { dashboardVersion, moduleDetail, moduleRows, summary, unitRows } from "../dashboard/api.js";
import { comparePair, compareSummary, counterpartView } from "../dashboard/compare.js";
import type { Context } from "../graph/tools.js";

// One listener on 127.0.0.1: MCP over streamable HTTP at /mcp, the progress dashboard (index.html and app.css from
// web/, its script compiled from src/web/app.ts into build/, plus a
// read-only JSON API under /api/) everywhere else. Every request must carry a localhost Host (and, from a browser,
// Origin) header, so a foreign page that rebinds its own hostname to 127.0.0.1 cannot reach the tools.

export interface HttpOptions {
  /** 0 = any free port */
  port: number;
  mcp: McpServerFactory;
  /** shared graph/progress state; throws when the disassembly tree cannot be loaded */
  context: () => Context;
  /** directory holding index.html and app.css */
  webRoot: string;
  /** the compiled server (build/): web/app.js, the dashboard script compiled from src/web/app.ts, and the modules it
   * imports */
  buildRoot: string;
  onerror: (error: Error) => void;
  /** compare mode (--compare): the correspondence behind /api/compare/* */
  compare?: (() => Correspondence) | undefined;
  /** --game-name: the Overview's title in /api/summary */
  gameName?: string | undefined;
}

export interface RunningHttp {
  server: Server;
  url: string;
  close: () => Promise<void>;
}

/** URL -> file under webRoot ("web") or buildRoot ("build"). The compiled app imports ../percent.js and ../hex.js, so
 * /app.js and those modules keep that relative layout. */
const STATIC: Record<string, { root: "web" | "build"; file: string; type: string }> = {
  "/": { root: "web", file: "index.html", type: "text/html; charset=utf-8" },
  "/index.html": { root: "web", file: "index.html", type: "text/html; charset=utf-8" },
  "/app.css": { root: "web", file: "app.css", type: "text/css; charset=utf-8" },
  "/app.js": { root: "build", file: "web/app.js", type: "text/javascript; charset=utf-8" },
  "/percent.js": { root: "build", file: "percent.js", type: "text/javascript; charset=utf-8" },
  "/hex.js": { root: "build", file: "hex.js", type: "text/javascript; charset=utf-8" },
};

/** Loopback only: whoever reaches the port can call add_implementation and annotate. */
const HOST = "127.0.0.1";

function send(res: ServerResponse, status: number, type: string, body: string | Buffer): void {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(body);
}

const json = (res: ServerResponse, status: number, body: unknown) => send(res, status, "application/json; charset=utf-8", JSON.stringify(body));

/** Path segments after a prefix, URL-decoded; undefined when any is not valid encoding or the count is wrong. */
function segments(route: string, prefix: string, count: number): string[] | undefined {
  const parts = route.slice(prefix.length).split("/");
  if (parts.length !== count || parts.some((p) => p === "")) return undefined;
  try {
    return parts.map(decodeURIComponent);
  } catch {
    return undefined;
  }
}

/** `/api/compare/...`: the Compare page (compare mode only). */
function compareApi(route: string, compare: (() => Correspondence) | undefined): { status: number; body: unknown } {
  if (!compare) return { status: 404, body: { error: "Not in compare mode: start the server with --compare <other tree>." } };
  let c: Correspondence;
  try {
    c = compare();
  } catch (error) {
    return { status: 503, body: { error: `The trees could not be compared: ${String(error)}` } };
  }
  if (route === "compare/summary") return { status: 200, body: compareSummary(c) };
  if (route === "compare/map") return { status: 200, body: { rows: mapRows(c) } };
  if (route.startsWith("compare/pair/")) {
    const ids = segments(route, "compare/pair/", 2);
    if (!ids) return { status: 400, body: { error: "Use /api/compare/pair/{a}/{b} with both ids URL-encoded." } };
    const found = comparePair(c, ids[0]!, ids[1]!);
    return found.ok ? { status: 200, body: found.pair } : { status: 404, body: { error: found.error } };
  }
  if (route.startsWith("compare/counterpart/")) {
    const ids = segments(route, "compare/counterpart/", 2);
    if (!ids) return { status: 400, body: { error: "Use /api/compare/counterpart/{game}/{id} with the id URL-encoded." } };
    const found = counterpartView(c, ids[0]!, ids[1]!);
    return found.ok ? { status: 200, body: found.view } : { status: 404, body: { error: found.error } };
  }
  return { status: 404, body: { error: `No API route "/api/${route}". Compare routes: compare/summary, compare/map, compare/pair/{a}/{b}, compare/counterpart/{game}/{id}.` } };
}

/** `/api/...` routes; every one is a read of the current graph and progress. */
function api(route: string, context: () => Context, compare: (() => Correspondence) | undefined, gameName: string | null): { status: number; body: unknown } {
  if (route.startsWith("compare/")) return compareApi(route, compare);
  let ctx: Context;
  try {
    ctx = context();
  } catch (error) {
    return { status: 503, body: { error: `The disassembly tree could not be loaded: ${String(error)}` } };
  }
  if (route === "version") return { status: 200, body: { version: dashboardVersion(ctx) } };
  if (route === "summary") return { status: 200, body: summary(ctx, gameName) };
  if (route === "modules") return { status: 200, body: { modules: moduleRows(ctx) } };
  if (route === "units") return { status: 200, body: { units: unitRows(ctx) } };
  if (route.startsWith("modules/") && route.length > "modules/".length) {
    let id: string;
    try {
      id = decodeURIComponent(route.slice("modules/".length));
    } catch {
      return { status: 400, body: { error: "The module id is not valid URL encoding." } };
    }
    const found = moduleDetail(ctx, id);
    return found.ok ? { status: 200, body: found.detail } : { status: 404, body: { error: found.error } };
  }
  return { status: 404, body: { error: `No API route "/api/${route}". Routes: version, summary, modules, modules/{id}, units${compare ? ", compare/…" : ""}.` } };
}

export async function startHttp(options: HttpOptions): Promise<RunningHttp> {
  const handler = createMcpHandler(options.mcp, { onerror: options.onerror });
  const mcp = toNodeHandler(handler, { onerror: options.onerror });
  const guards = [localhostHostValidation(), localhostOriginValidation()];

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      for (const guard of guards) if (!guard(req, res)) return;
      // only the path matters; a base keeps relative and odd request targets parseable
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      if (pathname === "/mcp") return mcp(req, res);
      if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: "Method not allowed: the dashboard is read-only." });
      if (pathname.startsWith("/api/")) {
        const { status, body } = api(pathname.slice("/api/".length), options.context, options.compare, options.gameName ?? null);
        return json(res, status, body);
      }
      const asset = STATIC[pathname];
      if (!asset) return send(res, 404, "text/plain; charset=utf-8", "Not found. The dashboard is at /, MCP at /mcp.");
      return send(res, 200, asset.type, await readFile(path.join(asset.root === "web" ? options.webRoot : options.buildRoot, asset.file)));
    })().catch((error: unknown) => {
      options.onerror(error instanceof Error ? error : new Error(String(error)));
      if (!res.headersSent) json(res, 500, { error: "Internal error; see the server log." });
      else res.destroy();
    });
  });

  server.listen(options.port, HOST);
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    server,
    url: `http://${HOST}:${port}`,
    close: async () => {
      await handler.close();
      const closed = once(server, "close");
      server.close();
      server.closeAllConnections();
      await closed;
    },
  };
}
