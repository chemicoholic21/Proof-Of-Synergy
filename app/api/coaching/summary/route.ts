import { NextRequest, NextResponse } from "next/server";
import { CoachingSummaryBody } from "@/lib/schemas";
import { summaryUserPrompt, SUMMARY_SYSTEM, generateWithSarvam, generateWithGemini } from "@/lib/prompts";
import { sarvamConfigured } from "@/lib/env";
import { logger } from "@/lib/logger";
import { newRequestId, errorResponse, enforceRateLimit, parseJsonBody, ValidationError } from "@/lib/http";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * POST /api/coaching/summary - generate a warm, specific session summary from the session's metrics
 * and coaching events using Sarvam (default) or Gemini as the backing model.
 */
export async function POST(req: NextRequest) {
  const requestId = newRequestId();
  const log = logger.child({ requestId, route: "coaching/summary" });
  const limited = enforceRateLimit(req, "coaching-summary", requestId, { max: 30, windowMs: 60_000 });
  if (limited) return limited;

  let body;
  try {
    body = await parseJsonBody(req, CoachingSummaryBody);
  } catch (e) {
    if (e instanceof ValidationError) return errorResponse(400, "invalid_body", "Invalid request body.", requestId, { details: e.details });
    throw e;
  }

  const prompt = summaryUserPrompt({
    fillerCount: body.fillerCount,
    confidence: body.confidence,
    wordCount: body.wordCount,
    scenarioTitle: body.scenarioTitle,
    coachingEvents: body.coachingEvents,
  });

  const useSarvam = sarvamConfigured();
  try {
    const summary = useSarvam
      ? await generateWithSarvam(SUMMARY_SYSTEM, prompt, { temperature: 0.5, maxTokens: 600 })
      : await generateWithGemini(SUMMARY_SYSTEM, prompt, { temperature: 0.5, maxTokens: 600 });
    log.info("session summary generated", { scenarioTitle: body.scenarioTitle, model: useSarvam ? "sarvam" : "gemini" });
    return NextResponse.json({ summary, model: useSarvam ? "sarvam" : "gemini" });
  } catch (e) {
    log.error("summary generation failed, using heuristic fallback", { error: e });
    const summary =
      `You practiced "${body.scenarioTitle}". You spoke ${body.wordCount} words with a confidence score of ` +
      `${body.confidence}/100 and ${body.fillerCount} filler words detected. Keep practicing to sharpen structure and reduce hesitations.`;
    return NextResponse.json({ summary, model: "heuristic" });
  }
}
