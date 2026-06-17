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
  // Saarika's real-time STT caps each clip at 30s, so a long answer arrives as several ordered
  // <=25s segments (field name "audio", repeated). getAll handles both single and multi-segment.
  let segments: File[] = [];
  try {
    const form = await req.formData();
    qid = Number(form.get("questionId") || 0);
    segments = form.getAll("audio").filter((v): v is File => v instanceof File);
  } catch {
    return errorResponse(400, "bad_request", "Expected multipart/form-data with audio.", requestId);
  }

  if (segments.length === 0) {
    return errorResponse(400, "no_audio", "No audio was provided.", requestId);
  }
  const totalBytes = segments.reduce((n, s) => n + s.size, 0);
  if (totalBytes === 0) {
    return errorResponse(400, "empty_audio", "The audio recording is empty.", requestId);
  }
  if (totalBytes > env.MAX_AUDIO_BYTES) {
    return errorResponse(
      413,
      "audio_too_large",
      `Audio exceeds the ${Math.round(env.MAX_AUDIO_BYTES / (1024 * 1024))} MB limit.`,
      requestId
    );
  }

  try {
    // Transcribe each segment (skipping empties) and stitch the transcripts back in order.
    const parts: string[] = [];
    const languages: string[] = [];
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (seg.size === 0) continue;
      const { text, language } = await sarvamTranscribe(seg, seg.name || `answer-${i}.webm`);
      const trimmed = (text || "").trim();
      if (trimmed) parts.push(trimmed);
      const label = LANG_LABEL[language] || language;
      if (label && !languages.includes(label)) languages.push(label);
    }

    const fullText = parts.join(" ").trim();
    if (fullText.length < 2) throw new Error("Empty transcript returned.");
    const primaryLanguage = languages[0] || "English";
    log.info("transcription complete", { questionId: qid, segments: segments.length, languages });
    return NextResponse.json({
      text: fullText,
      language: primaryLanguage,
      languagesDetected: languages.length ? languages : [primaryLanguage],
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
