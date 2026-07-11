import { NextRequest, NextResponse } from "next/server";
import { GemmaCoachingBody } from "@/lib/schemas";
import { analyzeWithGemma } from "@/lib/gemma";
import { logger } from "@/lib/logger";
import { newRequestId, errorResponse, enforceRateLimit, parseJsonBody, ValidationError } from "@/lib/http";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * POST /api/gemma - Gemma coaching analysis. Accepts a transcript (+ optional recent messages) and
 * returns coaching events and metrics computed by lib/gemma.
 */
export async function POST(req: NextRequest) {
  const requestId = newRequestId();
  const log = logger.child({ requestId, route: "gemma" });
  const limited = enforceRateLimit(req, "gemma", requestId, { max: 30, windowMs: 60_000 });
  if (limited) return limited;

  let body;
  try {
    body = await parseJsonBody(req, GemmaCoachingBody);
  } catch (e) {
    if (e instanceof ValidationError) return errorResponse(400, "invalid_body", "Invalid request body.", requestId, { details: e.details });
    throw e;
  }

  try {
    const recentMessages = body.recentMessages?.map((m) => ({ content: m.content }));
    const result = await analyzeWithGemma(body.transcript, recentMessages);
    log.info("gemma coaching complete", {
      transcriptChars: body.transcript.length,
      events: result.coachingEvents.length,
      engine: result.engine,
    });
    return NextResponse.json({ ...result, model: result.engine });
  } catch (e) {
    log.error("gemma analysis failed", { error: e });
    return errorResponse(502, "gemma_failed", `Gemma analysis failed: ${(e as Error).message}`, requestId);
  }
}
