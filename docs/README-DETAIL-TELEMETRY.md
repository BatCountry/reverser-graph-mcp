# Telemetry (see what a model tried)

Set the standard OpenTelemetry variables and the server exports one span per `tools/call` and `resources/read` (OTel
MCP semantic conventions: `mcp.method.name`, `gen_ai.tool.name`, `gen_ai.tool.call.arguments`,
`gen_ai.tool.call.result`, `mcp.resource.uri`, `error.type` = `tool_error` for `isError` results) plus the
`mcp.server.operation.duration` histogram. Arguments and the text shown to the model are recorded (clipped at 16 KB).
A client `_meta.traceparent` becomes the span's parent. Nothing is loaded unless an endpoint is set.

| Variable | Effect |
| --- | --- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` (or `..._TRACES_ENDPOINT` / `..._METRICS_ENDPOINT`) | Enables export (OTLP http/protobuf) |
| `OTEL_TRACES_EXPORTER=none`, `OTEL_METRICS_EXPORTER=none`, `OTEL_SDK_DISABLED=true` | Turn signals off |
| `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES` | Standard meaning (e.g. tag a run: `run.id=probe-7`) |

Put them in the MCP server's `env` block of your client's config; some clients deliberately do not pass their own
environment to MCP servers.

A local sink: `HOST_UID=$(id -u) HOST_GID=$(id -g) docker compose -f observability/docker-compose.yml up -d` runs an
OpenTelemetry Collector (OTLP on :4318/:4317) feeding Jaeger (UI http://localhost:16686, query API `/api/v3/traces`),
a Prometheus endpoint (http://localhost:8889/metrics) and JSONL files in `observability/data/`.
`observability/otel-collector.yaml` works unchanged on a cluster once its `otlp/jaeger` exporter points at the deployed
backend.
