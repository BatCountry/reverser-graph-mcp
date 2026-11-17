import { context, metrics, propagation, SpanKind, SpanStatusCode, trace, type Attributes, type Histogram, type Tracer } from "@opentelemetry/api";
import type { McpServer } from "@modelcontextprotocol/server";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { CompositePropagator, W3CBaggagePropagator, W3CTraceContextPropagator } from "@opentelemetry/core";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { detectResources, hostDetector, processDetector, resourceAttributesEnvDetector, resourceFromAttributes, serviceNameEnvDetector } from "@opentelemetry/resources";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { BatchSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";

// OpenTelemetry for the MCP server: one SERVER span per tools/call and resources/read, following the OTel MCP semantic
// conventions (mcp.method.name, gen_ai.tool.name, gen_ai.tool.call.arguments/result, error.type = tool_error), with the
// client's `_meta.traceparent` as parent when it sends one. Arguments and results are recorded: seeing what a model asked
// for and what it was shown is the point. Off unless an OTLP endpoint is configured (the standard OTEL_* variables).

const SERVICE_NAME = "reverser-progress-graph";
/** Longest recorded argument/result text; tool results are short by design, listings are not. */
export const MAX_RECORDED_CHARS = 16_384;

export interface Telemetry {
  tracer: Tracer;
  duration: Histogram;
  shutdown(): Promise<void>;
}

type Env = Readonly<Record<string, string | undefined>>;

/** Which signals the OTEL_* environment asks for, mirroring the SDK rules: an endpoint, and no `none` exporter. */
export function telemetrySignals(env: Env): { traces: boolean; metrics: boolean } {
  if (env.OTEL_SDK_DISABLED?.trim().toLowerCase() === "true") return { traces: false, metrics: false };
  const wanted = (signal: "TRACES" | "METRICS") =>
    Boolean(env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim() || env[`OTEL_EXPORTER_OTLP_${signal}_ENDPOINT`]?.trim()) &&
    !(env[`OTEL_${signal}_EXPORTER`] ?? "").split(",").some((e) => e.trim().toLowerCase() === "none");
  return { traces: wanted("TRACES"), metrics: wanted("METRICS") };
}

/** Starts export per the OTEL_* environment; undefined (and no SDK at all) when nothing is configured. */
export function startTelemetry(version: string, env: Env = process.env): Telemetry | undefined {
  const signals = telemetrySignals(env);
  if (!signals.traces && !signals.metrics) return undefined;

  const resource = resourceFromAttributes({ "service.name": SERVICE_NAME, "service.version": version }).merge(
    detectResources({ detectors: [hostDetector, processDetector, resourceAttributesEnvDetector, serviceNameEnvDetector] }),
  );
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  propagation.setGlobalPropagator(new CompositePropagator({ propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()] }));

  const tracerProvider = signals.traces ? new TracerProvider({ resource, spanProcessors: [new BatchSpanProcessor({ exporter: new OTLPTraceExporter() })] }) : undefined;
  if (tracerProvider) trace.setGlobalTracerProvider(tracerProvider);
  const meterProvider = signals.metrics
    ? new MeterProvider({ resource, readers: [new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter(), exportIntervalMillis: 15_000 })] })
    : undefined;
  if (meterProvider) metrics.setGlobalMeterProvider(meterProvider);

  const tracer = trace.getTracer(SERVICE_NAME, version);
  const duration = metrics.getMeter(SERVICE_NAME, version).createHistogram("mcp.server.operation.duration", {
    unit: "s",
    description: "Duration of MCP requests handled by the server",
    advice: { explicitBucketBoundaries: [0.001, 0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] },
  });
  let stopped: Promise<void> | undefined;
  const shutdown = () => (stopped ??= Promise.all([tracerProvider?.shutdown(), meterProvider?.shutdown()]).then(() => undefined));
  return { tracer, duration, shutdown };
}

const clip = (s: string) => (s.length > MAX_RECORDED_CHARS ? `${s.slice(0, MAX_RECORDED_CHARS)}… [${s.length - MAX_RECORDED_CHARS} more chars]` : s);

/** Text the client was shown: text content parts for tools, `contents[].text` for resources. */
function shownText(result: unknown): string {
  if (typeof result !== "object" || result === null) return "";
  const parts = "content" in result && Array.isArray(result.content) ? result.content : "contents" in result && Array.isArray(result.contents) ? result.contents : [];
  return parts
    .map((p: unknown) => (typeof p === "object" && p !== null && "text" in p && typeof p.text === "string" ? p.text : ""))
    .filter(Boolean)
    .join("\n");
}

/** The request context the SDK passes as a handler's last argument. */
interface HandlerContext {
  sessionId?: string;
  mcpReq?: { id?: unknown; _meta?: Record<string, unknown> };
}
function handlerContext(args: readonly unknown[]): HandlerContext | undefined {
  const last = args.at(-1);
  return typeof last === "object" && last !== null && "mcpReq" in last ? (last as HandlerContext) : undefined;
}

const metaGetter = {
  keys: (carrier: Record<string, unknown>) => Object.keys(carrier),
  get: (carrier: Record<string, unknown>, key: string) => {
    const v = carrier[key];
    return typeof v === "string" ? v : undefined;
  },
};

export type Operation = { method: "tools/call"; tool: string } | { method: "resources/read"; resource: string };

/**
 * Wrap an MCP handler so each call is one SERVER span (parented on `_meta.traceparent`) plus a duration measurement.
 * The handler's own result or exception passes through untouched.
 */
export function traced<A extends unknown[], R>(t: Telemetry, op: Operation, handler: (...args: A) => R | Promise<R>): (...args: A) => Promise<R> {
  return async (...args: A) => {
    const ctx = handlerContext(args);
    const parent = propagation.extract(context.active(), ctx?.mcpReq?._meta ?? {}, metaGetter);
    const attributes: Attributes = { "mcp.method.name": op.method, "network.transport": "pipe" };
    if (ctx?.mcpReq?.id !== undefined && ctx.mcpReq.id !== null) attributes["jsonrpc.request.id"] = String(ctx.mcpReq.id);
    if (ctx?.sessionId) attributes["mcp.session.id"] = ctx.sessionId;
    if (op.method === "tools/call") {
      attributes["gen_ai.tool.name"] = op.tool;
      attributes["gen_ai.operation.name"] = "execute_tool";
      attributes["gen_ai.tool.call.arguments"] = clip(JSON.stringify(args.length > 1 ? args[0] : {}) ?? "");
    } else {
      attributes["reverser.resource.name"] = op.resource;
      const uri = args[0];
      if (uri instanceof URL) attributes["mcp.resource.uri"] = uri.href;
    }
    const name = op.method === "tools/call" ? `tools/call ${op.tool}` : "resources/read";
    const metricAttributes: Attributes = op.method === "tools/call" ? { "mcp.method.name": op.method, "gen_ai.tool.name": op.tool } : { "mcp.method.name": op.method };
    const started = performance.now();

    return t.tracer.startActiveSpan(name, { kind: SpanKind.SERVER, attributes }, parent, async (span) => {
      try {
        const result = await handler(...args);
        const text = shownText(result);
        span.setAttribute(op.method === "tools/call" ? "gen_ai.tool.call.result" : "reverser.resource.text", clip(text));
        span.setAttribute("reverser.result.chars", text.length);
        if (typeof result === "object" && result !== null && "isError" in result && result.isError === true) {
          span.setAttribute("error.type", "tool_error");
          span.setStatus({ code: SpanStatusCode.ERROR, message: clip(text) });
          metricAttributes["error.type"] = "tool_error";
        }
        return result;
      } catch (error) {
        const type = error instanceof Error ? error.name : "_OTHER";
        span.setAttribute("error.type", type);
        if (error instanceof Error) span.recordException(error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: error instanceof Error ? error.message : String(error) });
        metricAttributes["error.type"] = type;
        throw error;
      } finally {
        span.end();
        t.duration.record((performance.now() - started) / 1000, metricAttributes);
      }
    });
  };
}

type AnyHandler = (...args: unknown[]) => unknown;

/**
 * Route every tool and resource registered on `server` from now on through {@link traced}. Call before registering.
 * The casts bridge the SDK's overloaded register signatures; the handler is passed through unchanged apart from the wrapper.
 */
export function instrumentServer(server: McpServer, t: Telemetry): void {
  const registerTool = server.registerTool.bind(server) as (name: string, config: unknown, cb: AnyHandler) => unknown;
  server.registerTool = ((name: string, config: unknown, cb: AnyHandler) => registerTool(name, config, traced(t, { method: "tools/call", tool: name }, cb))) as typeof server.registerTool;
  const registerResource = server.registerResource.bind(server) as (name: string, target: unknown, metadata: unknown, cb: AnyHandler) => unknown;
  server.registerResource = ((name: string, target: unknown, metadata: unknown, cb: AnyHandler) =>
    registerResource(name, target, metadata, traced(t, { method: "resources/read", resource: name }, cb))) as typeof server.registerResource;
}
