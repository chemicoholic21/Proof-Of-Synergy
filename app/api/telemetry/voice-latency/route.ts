import { NextRequest, NextResponse } from "next/server";
import { VoiceLatencyReportBody } from "@/lib/schemas";
import { logger } from "@/lib/logger";
import { traceChain, setVoiceLatencyMetrics } from "@/lib/tracing";
import { newRequestId, errorResponse, enforceRateLimit, parseJsonBody, ValidationError } from "@/lib/http";

export const runtime = "nodejs";

/**
 * Receives one voice turn's complete latency breakdown from the client (see lib/voice-latency.ts)
 * once mic -> STT -> LLM -> TTS -> playback has finished for that turn, and republishes it as a
 * `voice.turn` chain span with `voice.latency.*` attributes and a `voice.stage.*` event per stage,
 * so the full pipeline breakdown shows up in Phoenix as a first-class summary rather than only
 * being reconstructable by hand from the separate transcribe/gemini/tts spans.
 *
 * Telemetry only: never affects the UX, so failures here are logged and swallowed by the caller
 * (see reportVoiceLatency in app/practice/page.tsx), not surfaced to the learner.
 */
export async function POST(req: NextRequest) {
  const requestId = newRequestId();
  const log = logger.child({ requestId, route: "telemetry/voice-latency" });

  const limited = enforceRateLimit(req, "voice-latency", requestId, { max: 120, windowMs: 60_000 });
  if (limited) return limited;

  let body;
  try {
    body = await parseJsonBody(req, VoiceLatencyReportBody);
  } catch (e) {
    if (e instanceof ValidationError) {
      return errorResponse(400, "invalid_body", "Invalid request body.", requestId, { details: e.details });
    }
    throw e;
  }

  // `null` means "this turn never reached that stage" (see VoiceLatencyReportBody) — drop those
  // rather than logging/tracing a fake zero.
  const metrics: Record<string, number> = {};
  for (const [key, value] of Object.entries(body.metrics ?? {})) {
    if (typeof value === "number" && Number.isFinite(value)) metrics[key] = value;
  }

  await traceChain("voice.turn", { metadata: { turnId: body.turnId } }, async (span) => {
    setVoiceLatencyMetrics(span, metrics, body.timestamps);
  });

  log.info("voice turn latency", { turnId: body.turnId, ...metrics });
  return NextResponse.json({ ok: true });
}
