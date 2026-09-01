/**
 * Span helpers built on the OpenTelemetry API + OpenInference semantic conventions, so traces
 * render as first-class LLM / chain / tool spans in Arize Phoenix.
 *
 * These are always safe to call. When no tracer provider is registered (no Phoenix endpoint
 * configured — see `lib/otel-setup.ts`), the OpenTelemetry API returns non-recording spans and
 * every helper here becomes a cheap no-op. Nothing in the app needs to branch on whether tracing
 * is on.
 */

import { SpanStatusCode, trace, type AttributeValue, type Span } from "@opentelemetry/api";
import {
  MimeType,
  OpenInferenceSpanKind,
  SemanticConventions,
} from "@arizeai/openinference-semantic-conventions";

const TRACER_NAME = "proof-of-synergy";

// Cap how much prompt/response text we attach to a span so a long resume or transcript can't
// bloat the exported payload. Phoenix still shows plenty of context at this size.
const MAX_ATTR_CHARS = 12_000;

type SpanKind = (typeof OpenInferenceSpanKind)[keyof typeof OpenInferenceSpanKind];

function getTracer() {
  return trace.getTracer(TRACER_NAME);
}

/** True when a Phoenix endpoint is configured. Handy for skipping expensive attribute prep. */
export function tracingConfigured(): boolean {
  return Boolean(process.env.PHOENIX_COLLECTOR_ENDPOINT?.trim());
}

function clip(text: string): string {
  return text.length > MAX_ATTR_CHARS ? `${text.slice(0, MAX_ATTR_CHARS)}…[truncated]` : text;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Run `fn` inside an active OpenInference span. The span is made the active context, so any spans
 * created by `fn` (e.g. an LLM call from a route handler) nest underneath it automatically.
 * Records exceptions and sets an ERROR status on throw, then always ends the span.
 */
export async function runInSpan<T>(
  name: string,
  opts: { kind: SpanKind; attributes?: Record<string, AttributeValue> },
  fn: (span: Span) => Promise<T>
): Promise<T> {
  return getTracer().startActiveSpan(
    name,
    {
      attributes: {
        [SemanticConventions.OPENINFERENCE_SPAN_KIND]: opts.kind,
        ...opts.attributes,
      },
    },
    async (span) => {
      try {
        const result = await fn(span);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (e) {
        span.recordException(e as Error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: (e as Error).message });
        throw e;
      } finally {
        span.end();
      }
    }
  );
}

/** Set the input attributes of an LLM span from a system + user prompt pair. */
export function setLLMInput(
  span: Span,
  input: {
    provider: string;
    model?: string | null;
    system?: string;
    user: string;
    invocationParameters?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  }
): void {
  span.setAttribute(SemanticConventions.LLM_PROVIDER, input.provider);
  if (input.model) span.setAttribute(SemanticConventions.LLM_MODEL_NAME, input.model);
  span.setAttribute(SemanticConventions.INPUT_MIME_TYPE, MimeType.TEXT);
  span.setAttribute(SemanticConventions.INPUT_VALUE, clip(input.user));

  let i = 0;
  if (input.system) {
    span.setAttribute(`${SemanticConventions.LLM_INPUT_MESSAGES}.${i}.${SemanticConventions.MESSAGE_ROLE}`, "system");
    span.setAttribute(
      `${SemanticConventions.LLM_INPUT_MESSAGES}.${i}.${SemanticConventions.MESSAGE_CONTENT}`,
      clip(input.system)
    );
    i++;
  }
  span.setAttribute(`${SemanticConventions.LLM_INPUT_MESSAGES}.${i}.${SemanticConventions.MESSAGE_ROLE}`, "user");
  span.setAttribute(
    `${SemanticConventions.LLM_INPUT_MESSAGES}.${i}.${SemanticConventions.MESSAGE_CONTENT}`,
    clip(input.user)
  );

  if (input.invocationParameters) {
    span.setAttribute(SemanticConventions.LLM_INVOCATION_PARAMETERS, safeJson(input.invocationParameters));
  }
  if (input.metadata) {
    span.setAttribute(SemanticConventions.METADATA, safeJson(input.metadata));
  }
}

/** Set the output attributes of an LLM span: the resolved model, the completion text, and tokens. */
export function setLLMOutput(
  span: Span,
  output: {
    model?: string | null;
    text: string;
    usage?: { prompt?: number; completion?: number; total?: number };
  }
): void {
  if (output.model) span.setAttribute(SemanticConventions.LLM_MODEL_NAME, output.model);
  span.setAttribute(SemanticConventions.OUTPUT_MIME_TYPE, MimeType.TEXT);
  span.setAttribute(SemanticConventions.OUTPUT_VALUE, clip(output.text));

  const usage = output.usage;
  if (usage) {
    if (typeof usage.prompt === "number") span.setAttribute(SemanticConventions.LLM_TOKEN_COUNT_PROMPT, usage.prompt);
    if (typeof usage.completion === "number")
      span.setAttribute(SemanticConventions.LLM_TOKEN_COUNT_COMPLETION, usage.completion);
    if (typeof usage.total === "number") span.setAttribute(SemanticConventions.LLM_TOKEN_COUNT_TOTAL, usage.total);
  }
}

/**
 * Wrap a whole request flow (an interview turn, the opening question, a coaching summary) in a
 * CHAIN span so nested LLM / tool spans render as one end-to-end trace in Phoenix.
 */
export async function traceChain<T>(
  name: string,
  opts: { input?: string; metadata?: Record<string, unknown> },
  fn: (span: Span) => Promise<T>
): Promise<T> {
  return runInSpan(name, { kind: OpenInferenceSpanKind.CHAIN }, async (span) => {
    if (opts.input) {
      span.setAttribute(SemanticConventions.INPUT_MIME_TYPE, MimeType.TEXT);
      span.setAttribute(SemanticConventions.INPUT_VALUE, clip(opts.input));
    }
    if (opts.metadata) span.setAttribute(SemanticConventions.METADATA, safeJson(opts.metadata));
    return fn(span);
  });
}

/** Set the output value on the current chain/tool span (best-effort — no-op if text is empty). */
export function setSpanOutput(span: Span, text: string): void {
  if (!text) return;
  span.setAttribute(SemanticConventions.OUTPUT_MIME_TYPE, MimeType.TEXT);
  span.setAttribute(SemanticConventions.OUTPUT_VALUE, clip(text));
}

/**
 * Attach a completed voice turn's latency breakdown to `span` as `voice.latency.*` attributes, and
 * (when raw stage timestamps are supplied) one `voice.stage.<name>` event per stage at the epoch-ms
 * moment it happened, so a turn's mic -> STT -> LLM -> TTS -> playback waterfall is visible
 * alongside the STT/LLM/TTS tool and LLM spans it summarizes. Fields that are `NaN` (a stage never
 * reached this turn, e.g. TTS on a typed answer) are skipped rather than sent as garbage.
 */
export function setVoiceLatencyMetrics(
  span: Span,
  metrics: Record<string, number | undefined>,
  timestamps?: Record<string, number | undefined>
): void {
  for (const [key, value] of Object.entries(metrics)) {
    if (Number.isFinite(value)) span.setAttribute(`voice.latency.${key}`, value as number);
  }
  if (timestamps) {
    for (const [stage, atMs] of Object.entries(timestamps)) {
      if (Number.isFinite(atMs)) span.addEvent(`voice.stage.${stage}`, {}, atMs as number);
    }
  }
}

/** Wrap a non-LLM external call (speech-to-text, text-to-speech) as an OpenInference TOOL span. */
export async function traceTool<T>(
  name: string,
  opts: { input?: string; metadata?: Record<string, unknown> },
  fn: (span: Span) => Promise<T>
): Promise<T> {
  return runInSpan(name, { kind: OpenInferenceSpanKind.TOOL }, async (span) => {
    if (opts.input) {
      span.setAttribute(SemanticConventions.INPUT_MIME_TYPE, MimeType.TEXT);
      span.setAttribute(SemanticConventions.INPUT_VALUE, clip(opts.input));
    }
    if (opts.metadata) span.setAttribute(SemanticConventions.METADATA, safeJson(opts.metadata));
    return fn(span);
  });
}

/** Wrap an LLM call as an OpenInference LLM span with input set up front and output recorded after. */
export async function traceLLM(
  name: string,
  input: {
    provider: string;
    model?: string | null;
    system?: string;
    user: string;
    invocationParameters?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  },
  fn: (span: Span) => Promise<string>
): Promise<string> {
  return runInSpan(name, { kind: OpenInferenceSpanKind.LLM }, async (span) => {
    setLLMInput(span, input);
    if (input.model) span.setAttribute(SemanticConventions.LLM_MODEL_NAME, input.model);
    const text = await fn(span);
    setLLMOutput(span, { text });
    return text;
  });
}
