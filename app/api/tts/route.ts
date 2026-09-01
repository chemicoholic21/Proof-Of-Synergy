import { NextRequest, NextResponse } from "next/server";
import { sarvamTTS } from "@/lib/sarvam";
import { TtsBody } from "@/lib/schemas";
import { logger } from "@/lib/logger";
import { traceChain, setVoiceLatencyMetrics } from "@/lib/tracing";
import { newRequestId, errorResponse, enforceRateLimit, parseJsonBody, ValidationError } from "@/lib/http";

export const runtime = "nodejs";
export const maxDuration = 30;

// Bulbul text-to-speech. Reads a practice prompt aloud. Returns base64 WAV audio.
// On failure it returns { audio: null, source: "fallback", reason } so the client can fall back to
// the browser's built-in SpeechSynthesis, TTS is a non-critical convenience, so this degradation
// is acceptable in all modes and the explicit `source` flag keeps it observable.
export async function POST(req: NextRequest) {
  const requestId = newRequestId();
  const log = logger.child({ requestId, route: "tts" });

  const limited = enforceRateLimit(req, "tts", requestId, { max: 60, windowMs: 60_000 });
  if (limited) return limited;

  let text: string;
  let language: string | undefined;
  try {
    ({ text, language } = await parseJsonBody(req, TtsBody));
  } catch (e) {
    if (e instanceof ValidationError) {
      return errorResponse(400, "invalid_body", "Invalid request body.", requestId, { details: e.details });
    }
    throw e;
  }

  try {
    return await traceChain("tts", { input: text, metadata: { language: language || "en-IN" } }, async (span) => {
      // Bulbul returns the whole clip in one response (not streamed), so `tts_first_audio` lands at
      // the same instant as `tts_end` — ttsTimeToFirstAudioMs will equal the full call time until
      // Sarvam (or a switch to a streaming TTS provider) supports incremental audio.
      const ttsStart = Date.now();
      const audio = await sarvamTTS(text, language || "en-IN");
      const ttsEnd = Date.now();
      const timing = { tts_start: ttsStart, tts_first_audio: ttsEnd, tts_end: ttsEnd };
      setVoiceLatencyMetrics(span, {}, timing);
      log.info("tts complete", { chars: text.length, ttsMs: ttsEnd - ttsStart });
      return NextResponse.json({ audio, source: "sarvam", timing });
    });
  } catch (e) {
    const reason = (e as Error).message;
    log.warn("tts fallback to client speech synthesis", { reason });
    return NextResponse.json({ audio: null, source: "fallback", reason });
  }
}
