import { NextRequest, NextResponse } from "next/server";
import { sarvamTranscribe } from "@/lib/sarvam";
import { FALLBACK_TRANSCRIPTS } from "@/lib/fallbackData";
import { Transcript } from "@/lib/types";

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
  const form = await req.formData();
  const qid = Number(form.get("questionId") || 0);
  try {
    const audio = form.get("audio") as File | null;
    if (!audio) throw new Error("no audio");
    const { text, language } = await sarvamTranscribe(audio, audio.name || "answer.webm");
    if (!text || text.trim().length < 2) throw new Error("empty transcript");
    const label = LANG_LABEL[language] || language;
    return NextResponse.json({
      text,
      language: label,
      languagesDetected: [label],
      source: "sarvam",
    } satisfies Transcript);
  } catch (e) {
    console.warn("[transcribe] fallback:", (e as Error).message);
    const fb = FALLBACK_TRANSCRIPTS[qid] || FALLBACK_TRANSCRIPTS[1];
    return NextResponse.json(fb);
  }
}
