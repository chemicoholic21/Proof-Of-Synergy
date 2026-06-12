import { NextRequest, NextResponse } from "next/server";
import { sarvamTranscribe, sarvamConfigured } from "@/lib/sarvam";
import { FALLBACK_TRANSCRIPTS } from "@/lib/fallbackData";
import { Transcript } from "@/lib/types";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { newRequestId, errorResponse, enforceRateLimit } from "@/lib/http";

export const runtime = "nodejs";
export const maxDuration = 60;

const LANG_LABEL: Record<string, string> = {
  "en-IN": "English",
  "hi-IN": "Hindi",
  "kn-IN": "Kannada",
  "ta-IN": "Tamil",
  "te-IN": "Telugu",
  "mr-IN": "Marathi",
  "bn-IN": "Bengali",
  unknown: "English",
};

export async function POST(req: NextRequest) {
  const requestId = newRequestId();
  const log = logger.child({ requestId, route: "transcribe" });

  const limited = enforceRateLimit(req, "transcribe", requestId);
  if (limited) return limited;

  let qid = 0;
  let audio: File | null = null;
  try {
    const form = await req.formData();
    qid = Number(form.get("questionId") || 0);
    audio = form.get("audio") as File | null;
  } catch {
    return errorResponse(400, "bad_request", "Expected multipart/form-data with audio.", requestId);
  }

  if (!audio) {
    return errorResponse(400, "no_audio", "No audio was provided.", requestId);
  }
  if (audio.size === 0) {
    return errorResponse(400, "empty_audio", "The audio recording is empty.", requestId);
  }
  if (audio.size > env.MAX_AUDIO_BYTES) {
    return errorResponse(
      413,
      "audio_too_large",
      `Audio exceeds the ${Math.round(env.MAX_AUDIO_BYTES / (1024 * 1024))} MB limit.`,
      requestId
    );
  }

  try {
    const { text, language } = await sarvamTranscribe(audio, audio.name || "answer.webm");
    if (!text || text.trim().length < 2) throw new Error("Empty transcript returned.");
    const label = LANG_LABEL[language] || language;
    log.info("transcription complete", { questionId: qid, language: label });
    return NextResponse.json({
      text,
      language: label,
      languagesDetected: [label],
      source: "sarvam",
    } satisfies Transcript);
  } catch (e) {
    const message = (e as Error).message;
    log.error("transcription failed", { questionId: qid, error: e });

    // INTEGRITY: never fabricate a candidate's answer in production.
    if (env.DEMO_MODE) {
      const fb = FALLBACK_TRANSCRIPTS[qid] || FALLBACK_TRANSCRIPTS[1];
      return NextResponse.json(fb);
    }
    if (!sarvamConfigured()) {
      return errorResponse(503, "service_unconfigured", "Transcription is unavailable: SARVAM_API_KEY is not configured.", requestId);
    }
    return errorResponse(502, "transcription_failed", `Transcription failed: ${message}`, requestId);
  }
}
