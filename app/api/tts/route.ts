import { NextRequest, NextResponse } from "next/server";
import { sarvamTTS } from "@/lib/sarvam";

export const runtime = "nodejs";
export const maxDuration = 30;

// Bulbul text-to-speech. Reads an interview question aloud so the candidate can listen
// instead of only reading. Returns base64 WAV audio. On any failure it returns
// { audio: null, source: "fallback", reason } so the client can fall back to the browser's
// built-in SpeechSynthesis — degradation is explicit, never silent.
export async function POST(req: NextRequest) {
  try {
    const { text, language } = await req.json();
    if (!text || typeof text !== "string" || !text.trim()) {
      throw new Error("no text");
    }
    const audio = await sarvamTTS(text, language || "en-IN");
    return NextResponse.json({ audio, source: "sarvam" });
  } catch (e) {
    const reason = (e as Error).message;
    console.warn("[tts] fallback:", reason);
    return NextResponse.json({ audio: null, source: "fallback", reason });
  }
}
