/**
 * OpenTelemetry → Arize Phoenix bootstrap.
 *
 * This wires a Node tracer provider to an OTLP/HTTP exporter that ships spans to Arize Phoenix
 * (self-hosted or Phoenix Cloud — both free). It is called exactly once from the Next.js
 * `instrumentation.ts` `register()` hook, on the Node.js runtime only.
 *
 * It degrades gracefully, in keeping with the rest of the app: with no
 * PHOENIX_COLLECTOR_ENDPOINT set, tracing is a no-op and the app runs unchanged. The span
 * helpers in `lib/tracing.ts` are always safe to call — when no provider is registered the
 * OpenTelemetry API hands back non-recording spans.
 */

import { logger } from "./logger";

const log = logger.child({ module: "otel" });

let initialized = false;

/** Normalize a Phoenix base URL / endpoint into the OTLP HTTP traces URL Phoenix expects. */
function resolveTracesEndpoint(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  // Already a full traces path (e.g. someone set it explicitly) — use as-is.
  if (trimmed.endsWith("/v1/traces")) return trimmed;
  return `${trimmed}/v1/traces`;
}

/** Build the exporter headers. Phoenix Cloud authenticates with an API key; self-hosted needs none. */
function buildHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const apiKey = process.env.PHOENIX_API_KEY?.trim();
  if (apiKey) {
    // Phoenix accepts either header; send both so this works against Cloud and self-hosted-with-auth.
    headers["api_key"] = apiKey;
    headers["authorization"] = `Bearer ${apiKey}`;
  }
  // Phoenix Cloud multi-tenant spaces are selected with a header rather than a resource attribute.
  const spaceId = process.env.PHOENIX_CLIENT_HEADERS_SPACE_ID?.trim();
  if (spaceId) headers["space_id"] = spaceId;
  return headers;
}

/**
 * Initialize tracing. Safe to call multiple times (the second call is a no-op). Never throws —
 * an observability layer must never take the app down.
 */
export function initTracing(): void {
  if (initialized) return;

  const endpoint = process.env.PHOENIX_COLLECTOR_ENDPOINT?.trim();
  if (!endpoint) {
    log.info("phoenix tracing disabled (PHOENIX_COLLECTOR_ENDPOINT not set)");
    return;
  }

  try {
    // Required lazily so these heavy Node-only modules are never pulled into an edge bundle.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Resource } = require("@opentelemetry/resources");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { NodeTracerProvider, BatchSpanProcessor } = require("@opentelemetry/sdk-trace-node");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-proto");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { SEMRESATTRS_PROJECT_NAME } = require("@arizeai/openinference-semantic-conventions");

    const projectName = process.env.PHOENIX_PROJECT_NAME?.trim() || "proof-of-synergy";
    const url = resolveTracesEndpoint(endpoint);

    const resource = new Resource({
      "service.name": process.env.OTEL_SERVICE_NAME?.trim() || projectName,
      // Phoenix groups traces into "projects" via this resource attribute.
      [SEMRESATTRS_PROJECT_NAME]: projectName,
    });

    const exporter = new OTLPTraceExporter({
      url,
      headers: buildHeaders(),
    });

    const provider = new NodeTracerProvider({ resource });
    // Batch (non-blocking) with a short delay so traces appear in Phoenix within ~1s during a demo
    // without adding latency to the request path.
    provider.addSpanProcessor(
      new BatchSpanProcessor(exporter, { scheduledDelayMillis: 1000, maxExportBatchSize: 128 })
    );
    // register() installs the async-context manager, so spans created in `lib/tracing.ts` nest
    // correctly under the route-level chain span across `await` boundaries.
    provider.register();

    // Best-effort flush on shutdown so the final batch isn't lost when the server stops.
    const shutdown = () => {
      provider.shutdown().catch(() => {});
    };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);

    initialized = true;
    log.info("phoenix tracing enabled", { endpoint: url, project: projectName });
  } catch (e) {
    // Never let an observability failure break the app.
    log.warn("phoenix tracing failed to initialize", { error: (e as Error).message });
  }
}
