import { NextRequest, NextResponse } from "next/server";
import { reason } from "@/lib/memory";
import { cogneeConfigured, cogneeSearch } from "@/lib/memory/cognee/client";
import { RecallBody } from "@/lib/memory/api-schemas";
import { logger } from "@/lib/logger";
import { newRequestId, errorResponse, enforceRateLimit, parseJsonBody, ValidationError } from "@/lib/http";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * recall() endpoint — the Career Reasoner state. Used before generating an adaptive interview and
 * by the dashboard. When a real Cognee backend is configured we also attach its semantic answer.
 */
export async function POST(req: NextRequest) {
  const requestId = newRequestId();
  const log = logger.child({ requestId, route: "memory/recall" });
  const limited = enforceRateLimit(req, "memory-recall", requestId);
  if (limited) return limited;

  let body;
  try {
    body = await parseJsonBody(req, RecallBody);
  } catch (e) {
    if (e instanceof ValidationError) return errorResponse(400, "invalid_body", "Invalid request body.", requestId, { details: e.details });
    throw e;
  }

  try {
    const result = await reason(body.candidateId, { company: body.company ?? null });
    let cogneeInsight: string | null = null;
    if (cogneeConfigured() && !result.isNew) {
      cogneeInsight = await cogneeSearch(
        `What should the next interview focus on${body.company ? ` for a ${body.company} interview` : ""}? Consider weaknesses and forgotten topics.`,
        body.candidateId
      );
    }
    log.info("recall complete", { candidateId: body.candidateId, weak: result.weakConcepts.length, forgotten: result.forgottenConcepts.length });
    return NextResponse.json({ ...result, cogneeInsight, cogneeConfigured: cogneeConfigured() });
  } catch (e) {
    log.error("recall failed", { error: e });
    return errorResponse(502, "recall_failed", `recall() failed: ${(e as Error).message}`, requestId);
  }
}
