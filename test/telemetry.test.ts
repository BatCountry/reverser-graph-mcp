import { context, propagation, SpanStatusCode, type Attributes } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { MAX_RECORDED_CHARS, telemetrySignals, traced, type Telemetry } from "../src/telemetry.js";

describe("telemetrySignals", () => {
  test.each([
    [{}, { traces: false, metrics: false }],
    [{ OTEL_EXPORTER_OTLP_ENDPOINT: "" }, { traces: false, metrics: false }],
    [{ OTEL_EXPORTER_OTLP_ENDPOINT: "   " }, { traces: false, metrics: false }],
    [{ OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318" }, { traces: true, metrics: true }],
    [{ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://c:4318/v1/traces" }, { traces: true, metrics: false }],
    [{ OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "http://c:4318/v1/metrics" }, { traces: false, metrics: true }],
    [{ OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318", OTEL_TRACES_EXPORTER: "none" }, { traces: false, metrics: true }],
    [{ OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318", OTEL_METRICS_EXPORTER: "otlp, NONE" }, { traces: true, metrics: false }],
    [{ OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318", OTEL_TRACES_EXPORTER: "otlp" }, { traces: true, metrics: true }],
    [{ OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318", OTEL_SDK_DISABLED: " TRUE " }, { traces: false, metrics: false }],
    [{ OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318", OTEL_SDK_DISABLED: "false" }, { traces: true, metrics: true }],
    [{ OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318", OTEL_SDK_DISABLED: "1" }, { traces: true, metrics: true }],
  ])("%j", (env, expected) => {
    expect(telemetrySignals(env)).toEqual(expected);
  });
});

describe("traced", () => {
  const exporter = new InMemorySpanExporter();
  const recorded: Array<{ value: number; attributes: Attributes | undefined }> = [];
  let t: Telemetry;
  beforeAll(() => {
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    propagation.setGlobalPropagator(new W3CTraceContextPropagator());
    const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
    t = { tracer: provider.getTracer("test"), duration: { record: (value, attributes) => void recorded.push({ value, attributes }) }, shutdown: async () => {} };
  });
  afterEach(() => {
    exporter.reset();
    recorded.length = 0;
  });
  const ctx = (meta?: Record<string, unknown>) => ({ sessionId: "s1", mcpReq: { id: 7, _meta: meta } });
  const PARENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

  test("a tool call records method, tool, arguments, shown text and the client's traceparent as parent", async () => {
    const handler = traced(t, { method: "tools/call", tool: "module" }, async (_args: unknown, _ctx: unknown) => ({ content: [{ type: "text", text: "# module-0200:186c" }, { type: "image", data: "x" }] }));
    await expect(handler({ module: "2000:186c" }, ctx({ traceparent: PARENT }))).resolves.toMatchObject({ content: [{ text: "# module-0200:186c" }, {}] });
    const [span] = exporter.getFinishedSpans();
    expect(span?.name).toBe("tools/call module");
    expect(span?.spanContext().traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(span?.parentSpanContext?.spanId).toBe("00f067aa0ba902b7");
    expect(span?.attributes).toMatchObject({
      "mcp.method.name": "tools/call",
      "gen_ai.tool.name": "module",
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.call.arguments": '{"module":"2000:186c"}',
      "gen_ai.tool.call.result": "# module-0200:186c",
      "reverser.result.chars": 18,
      "jsonrpc.request.id": "7",
      "mcp.session.id": "s1",
    });
    expect(span?.attributes["error.type"]).toBeUndefined();
    expect(recorded).toEqual([{ value: expect.any(Number), attributes: { "mcp.method.name": "tools/call", "gen_ai.tool.name": "module" } }]);
  });
  test.each([
    ["no _meta", undefined],
    ["malformed traceparent", { traceparent: "garbage" }],
    ["non-string traceparent", { traceparent: 42 }],
  ])("%s: a new root span", async (_label, meta) => {
    await traced(t, { method: "tools/call", tool: "x" }, async (_a: unknown, _c: unknown) => ({ content: [] }))({}, ctx(meta));
    expect(exporter.getFinishedSpans()[0]?.parentSpanContext).toBeUndefined();
  });
  test("isError results are tool_error spans and metrics, and the result passes through unchanged", async () => {
    const result = { isError: true, content: [{ type: "text", text: "no such node" }] };
    await expect(traced(t, { method: "tools/call", tool: "module" }, async (_a: unknown, _c: unknown) => result)({}, ctx())).resolves.toBe(result);
    const [span] = exporter.getFinishedSpans();
    expect(span?.attributes["error.type"]).toBe("tool_error");
    expect(span?.status).toEqual({ code: SpanStatusCode.ERROR, message: "no such node" });
    expect(recorded[0]?.attributes).toMatchObject({ "error.type": "tool_error" });
  });
  test("a throwing handler records the exception and rethrows it", async () => {
    const boom = new RangeError("bad id");
    await expect(traced(t, { method: "resources/read", resource: "disassembly-module" }, async (_u: unknown, _c: unknown) => { throw boom; })(new URL("disasm://module/x"), ctx())).rejects.toBe(boom);
    const [span] = exporter.getFinishedSpans();
    expect(span?.name).toBe("resources/read");
    expect(span?.attributes).toMatchObject({ "error.type": "RangeError", "mcp.resource.uri": "disasm://module/x", "reverser.resource.name": "disassembly-module" });
    expect(span?.events.map((e) => e.name)).toContain("exception");
    expect(recorded[0]?.attributes).toEqual({ "mcp.method.name": "resources/read", "error.type": "RangeError" });
  });
  test("non-Error throws are _OTHER", async () => {
    await expect(traced(t, { method: "tools/call", tool: "x" }, async (_a: unknown, _c: unknown) => { throw "string"; })({}, ctx())).rejects.toBe("string");
    expect(exporter.getFinishedSpans()[0]?.attributes["error.type"]).toBe("_OTHER");
  });
  test("resource text is recorded and clipped at the limit", async () => {
    const long = "x".repeat(MAX_RECORDED_CHARS + 5);
    await traced(t, { method: "resources/read", resource: "listing" }, async (_u: unknown, _c: unknown) => ({ contents: [{ uri: "u", text: long }] }))(new URL("disasm://listing/x"), ctx());
    const attrs = exporter.getFinishedSpans()[0]?.attributes;
    expect(attrs?.["reverser.resource.text"]).toBe(`${"x".repeat(MAX_RECORDED_CHARS)}… [5 more chars]`);
    expect(attrs?.["reverser.result.chars"]).toBe(MAX_RECORDED_CHARS + 5);
  });
  test.each([
    ["undefined", undefined],
    ["null", null],
    ["a string", "text"],
    ["no content arrays", { content: "nope" }],
  ])("odd handler results (%s) record empty text", async (_label, result) => {
    await traced(t, { method: "tools/call", tool: "x" }, async (_a: unknown, _c: unknown) => result)({}, ctx());
    expect(exporter.getFinishedSpans()[0]?.attributes["reverser.result.chars"]).toBe(0);
  });
  test("handlers called without a request context still get a span", async () => {
    await traced(t, { method: "tools/call", tool: "x" }, async () => ({ content: [] }))();
    const attrs = exporter.getFinishedSpans()[0]?.attributes;
    expect(attrs?.["jsonrpc.request.id"]).toBeUndefined();
    expect(attrs?.["gen_ai.tool.call.arguments"]).toBe("{}");
  });
});
