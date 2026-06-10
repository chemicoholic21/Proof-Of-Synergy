import { NextRequest, NextResponse } from "next/server";
import { extractText, getDocumentProxy } from "unpdf";
import { sarvamParse, sarvamChat, extractJson } from "@/lib/sarvam";
import { RESUME_PARSE_SYSTEM, resumeParseUser } from "@/lib/prompts";
import { FALLBACK_RESUME } from "@/lib/fallbackData";
import { sarvamConfigured } from "@/lib/sarvam";
import { ParsedResume } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

async function extractPdfText(file: File): Promise<string> {
  const buf = new Uint8Array(await file.arrayBuffer());
  const pdf = await getDocumentProxy(buf);
  const { text } = await extractText(pdf, { mergePages: true });
  return Array.isArray(text) ? text.join("\n") : text;
}

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get("file") as File | null;
    if (!file) throw new Error("no file");

    // 1) Get raw text out of the uploaded file.
    const name = (file.name || "").toLowerCase();
    let text: string;
    if (file.type === "text/plain" || name.endsWith(".txt")) {
      text = await file.text();
    } else if (file.type === "application/pdf" || name.endsWith(".pdf")) {
      text = await extractPdfText(file); // reliable local PDF text extraction
    } else {
      text = await sarvamParse(file, file.name); // images/other: Sarvam OCR (else falls back)
    }
    if (!text || text.trim().length < 20) throw new Error("empty extracted text");

    // 2) Sarvam-105b structures the raw text into the resume schema (Prompt 1).
    const raw = await sarvamChat(RESUME_PARSE_SYSTEM, resumeParseUser(text), {
      temperature: 0.2,
      maxTokens: 2000,
    });
    const parsed = extractJson<Omit<ParsedResume, "source">>(raw);
    if (!parsed.skills?.length) throw new Error("no skills parsed");

    return NextResponse.json({ ...parsed, source: "sarvam" } satisfies ParsedResume);
  } catch (e) {
    // Graceful degradation, but NOT silent: the reason is returned so the UI can explain why
    // the uploaded document was not used (most commonly: SARVAM_API_KEY is not configured).
    const reason = sarvamConfigured()
      ? `Resume parsing failed: ${(e as Error).message}`
      : "SARVAM_API_KEY is not configured — set it in .env.local to parse your real document.";
    console.warn("[parse-resume] fallback:", reason);
    return NextResponse.json({ ...FALLBACK_RESUME, reason } satisfies ParsedResume);
  }
}
