import { NextRequest, NextResponse } from "next/server";
import { geminiChat, geminiConfigured } from "@/lib/gemini";
import {
  INTERVIEW_SYSTEM,
  buildInterviewContext,
  interviewOpeningUserPrompt,
  fallbackInterviewOpening,
} from "@/lib/prompts";
import { extractTextFromUpload, ResumeParseError, MAX_RESUME_BYTES } from "@/lib/resume";
import { logger } from "@/lib/logger";
import { newRequestId, errorResponse, enforceRateLimit } from "@/lib/http";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * POST /api/interview/prepare  (multipart/form-data)
 *
 * Fields:
 *   resume               - File  (PDF / .docx / .txt / .md)  [required unless resumeText given]
 *   resumeText           - text  (pasted resume)             [alternative to the file]
 *   jobDescription       - File                              [optional]
 *   jobDescriptionText   - text  (pasted JD)                 [optional]
 *   role                 - text  (target role/title)         [optional]
 *
 * Returns { systemPrompt, openingMessage, resumeChars, jobDescriptionIncluded, role }.
 * The systemPrompt is passed back to /api/gemini on every interview turn.
 */
export async function POST(req: NextRequest) {
  const requestId = newRequestId();
  const log = logger.child({ requestId, route: "interview/prepare" });
  const limited = enforceRateLimit(req, "interview-prepare", requestId, { max: 15, windowMs: 60_000 });
  if (limited) return limited;

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return errorResponse(400, "invalid_body", "Expected multipart/form-data.", requestId);
  }

  const resumeFile = form.get("resume");
  const resumeTextRaw = typeof form.get("resumeText") === "string" ? (form.get("resumeText") as string) : "";
  const jdFile = form.get("jobDescription");
  const jdTextRaw =
    typeof form.get("jobDescriptionText") === "string" ? (form.get("jobDescriptionText") as string) : "";
  const role = (typeof form.get("role") === "string" ? (form.get("role") as string) : "").trim().slice(0, 200);

  // --- Resume (required) ---
  let resumeText = "";
  try {
    if (resumeFile instanceof File && resumeFile.size > 0) {
      if (resumeFile.size > MAX_RESUME_BYTES) {
        return errorResponse(413, "file_too_large", "Your resume file is too large (max 8 MB).", requestId);
      }
      resumeText = await extractTextFromUpload(resumeFile);
    } else if (resumeTextRaw.trim()) {
      resumeText = resumeTextRaw.trim();
    }
  } catch (e) {
    const msg = e instanceof ResumeParseError ? e.message : "We couldn't read your resume. Please try another file.";
    log.warn("resume parse failed", { error: (e as Error).message });
    return errorResponse(400, "resume_parse_failed", msg, requestId);
  }

  if (resumeText.trim().length < 30) {
    return errorResponse(
      400,
      "resume_required",
      "We couldn't read enough text from your resume. Upload a PDF/Word file, or paste your resume text.",
      requestId
    );
  }

  // --- Job description (optional) ---
  let jobDescription = "";
  try {
    if (jdFile instanceof File && jdFile.size > 0) {
      jobDescription = await extractTextFromUpload(jdFile);
    } else if (jdTextRaw.trim()) {
      jobDescription = jdTextRaw.trim();
    }
  } catch (e) {
    // The JD is optional — never fail the request over it, just skip it.
    log.warn("job description parse failed, continuing without it", { error: (e as Error).message });
    jobDescription = "";
  }

  const systemPrompt = buildInterviewContext({ resumeText, jobDescription, role });

  // --- Opening question (model-generated, with a deterministic fallback) ---
  let openingMessage = "";
  if (geminiConfigured()) {
    try {
      const generated = await geminiChat(INTERVIEW_SYSTEM, interviewOpeningUserPrompt(systemPrompt), {
        temperature: 0.6,
        maxTokens: 300,
      });
      openingMessage = generated.trim();
    } catch (e) {
      log.warn("interview opening generation failed, using fallback", { error: (e as Error).message });
    }
  }
  if (!openingMessage) openingMessage = fallbackInterviewOpening(role);

  log.info("interview prepared", {
    resumeChars: resumeText.length,
    jobDescriptionIncluded: Boolean(jobDescription),
    role: role || null,
    generated: openingMessage !== fallbackInterviewOpening(role),
  });

  return NextResponse.json({
    systemPrompt,
    openingMessage,
    resumeChars: resumeText.length,
    jobDescriptionIncluded: Boolean(jobDescription),
    role: role || null,
  });
}
