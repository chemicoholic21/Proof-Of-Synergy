import { NextRequest, NextResponse } from "next/server";
import { sarvamTTS } from "@/lib/sarvam";
import { TtsBody } from "@/lib/schemas";
import { logger } from "@/lib/logger";
import { newRequestId, errorResponse, enforceRateLimit, parseJsonBody, ValidationError } from "@/lib/http";

export const runtime = "nodejs";
export const maxDuration = 30;

// Bulbul text-to-speech. Reads an interview question aloud. Returns base64 WAV audio.
// On failure it returns { audio: null, source: "fallback", reason } so the client can fall back to
// the browser's built-in SpeechSynthesis — TTS is a non-critical convenience, so this degradation
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
    const audio = await sarvamTTS(text, language || "en-IN");
    return NextResponse.json({ audio, source: "sarvam" });
  } catch (e) {
    const reason = (e as Error).message;
    log.warn("tts fallback to client speech synthesis", { reason });
    return NextResponse.json({ audio: null, source: "fallback", reason });
  }
}
