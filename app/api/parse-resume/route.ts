import { NextRequest, NextResponse } from "next/server";
import { extractText, getDocumentProxy } from "unpdf";
import { sarvamParse, sarvamChat, extractValidatedJson, sarvamConfigured } from "@/lib/sarvam";
import { RESUME_PARSE_SYSTEM, resumeParseUser } from "@/lib/prompts";
import { verifyResumeSkills } from "@/lib/refine";
import { FALLBACK_RESUME } from "@/lib/fallbackData";
import { ParsedResume } from "@/lib/types";
import { ParsedResumeLLMSchema } from "@/lib/schemas";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { newRequestId, errorResponse, enforceRateLimit } from "@/lib/http";

export const runtime = "nodejs";
export const maxDuration = 60;

const ACCEPTED = [".pdf", ".txt", ".png", ".jpg", ".jpeg", ".webp"];

async function extractPdfText(file: File): Promise<string> {
  const buf = new Uint8Array(await file.arrayBuffer());
  const pdf = await getDocumentProxy(buf);
  const { text } = await extractText(pdf, { mergePages: true });
  return Array.isArray(text) ? text.join("\n") : text;
}

export async function POST(req: NextRequest) {
  const requestId = newRequestId();
  const log = logger.child({ requestId, route: "parse-resume" });

  const limited = enforceRateLimit(req, "parse-resume", requestId);
  if (limited) return limited;

  let file: File | null = null;
  try {
    const form = await req.formData();
    file = form.get("file") as File | null;
  } catch {
    return errorResponse(400, "bad_request", "Expected multipart/form-data with a file.", requestId);
  }

  // ---- Input validation: presence, size, type ----
  if (!file) {
    return errorResponse(400, "no_file", "No file was uploaded.", requestId);
  }
  if (file.size === 0) {
    return errorResponse(400, "empty_file", "The uploaded file is empty.", requestId);
  }
  if (file.size > env.MAX_RESUME_BYTES) {
    return errorResponse(
      413,
      "file_too_large",
      `File exceeds the ${Math.round(env.MAX_RESUME_BYTES / (1024 * 1024))} MB limit.`,
      requestId
    );
  }
  const name = (file.name || "").toLowerCase();
  if (!ACCEPTED.some((ext) => name.endsWith(ext)) && !file.type.match(/^(text\/plain|application\/pdf|image\/)/)) {
    return errorResponse(
      415,
      "unsupported_type",
      `Unsupported file type. Accepted: ${ACCEPTED.join(", ")}.`,
      requestId
    );
  }

  try {
    // 1) Get raw text out of the uploaded file.
    let text: string;
    if (file.type === "text/plain" || name.endsWith(".txt")) {
      text = await file.text();
    } else if (file.type === "application/pdf" || name.endsWith(".pdf")) {
      text = await extractPdfText(file); // reliable local PDF text extraction
    } else {
      text = await sarvamParse(file, file.name); // images/other: Sarvam OCR
    }
    if (!text || text.trim().length < 20) throw new Error("Could not extract readable text from the document.");

    // 2) Sarvam structures the raw text into the resume schema, validated against ParsedResumeLLMSchema.
    // sarvam-105b is a reasoning model: the reasoning phase and the JSON answer share one
    // token budget. 2000 was too small (reasoning alone exhausted it -> finish_reason=length,
    // empty content). 5000 leaves room for the answer after the model finishes thinking.
    const raw = await sarvamChat(RESUME_PARSE_SYSTEM, resumeParseUser(text), {
      temperature: 0.2,
      maxTokens: 5000,
    });
    const parsed = extractValidatedJson(raw, ParsedResumeLLMSchema);

    // L1: a second agent grounds the extracted skills against the source text and drops any that
    // were hallucinated. Best-effort and never empties the list (see verifyResumeSkills).
    let dropped: string[] = [];
    if (env.EVAL_VERIFY_LAYERS) {
      ({ skills: parsed.skills, dropped } = await verifyResumeSkills(parsed.skills, text));
    }

    log.info("resume parsed", { skills: parsed.skills.length, dropped: dropped.length });
    return NextResponse.json({ ...parsed, source: "sarvam" } satisfies ParsedResume);
  } catch (e) {
    const message = (e as Error).message;
    log.error("resume parse failed", { error: e });

    // DEMO_MODE: degrade to clearly-labelled sample data so the app is demoable without a key.
    if (env.DEMO_MODE) {
      const reason = sarvamConfigured()
        ? `Resume parsing failed: ${message}`
        : "SARVAM_API_KEY is not configured, showing sample data (DEMO_MODE).";
      return NextResponse.json({ ...FALLBACK_RESUME, reason } satisfies ParsedResume);
    }

    // Production: fail honestly.
    if (!sarvamConfigured()) {
      return errorResponse(503, "service_unconfigured", "Resume parsing is unavailable: SARVAM_API_KEY is not configured.", requestId);
    }
    return errorResponse(502, "parse_failed", `Resume parsing failed: ${message}`, requestId);
  }
}
