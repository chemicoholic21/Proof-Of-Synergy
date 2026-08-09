/**
 * Next.js instrumentation hook. Runs once at server startup (see `experimental.instrumentationHook`
 * in next.config.mjs). We only initialize tracing on the Node.js runtime — the OTLP exporter and
 * tracer provider are Node-only and must never load into an edge bundle.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initTracing } = await import("./lib/otel-setup");
    initTracing();
  }
}
