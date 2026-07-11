import { NextRequest, NextResponse } from "next/server";
import { MetricsBody } from "@/lib/schemas";
import { extractDNA } from "@/lib/communication-metrics";
import { logger } from "@/lib/logger";
import { newRequestId, errorResponse, enforceRateLimit, parseJsonBody, ValidationError } from "@/lib/http";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * POST /api/coaching/metrics - compute communication DNA metrics from a transcript (+ optional
 * duration). Pure, cheap, no LLM call.
 */
export async function POST(req: NextRequest) {
  const requestId = newRequestId();
  const log = logger.child({ requestId, route: "coaching/metrics" });
  const limited = enforceRateLimit(req, "coaching-metrics", requestId, { max: 60, windowMs: 60_000 });
  if (limited) return limited;

  let body;
  try {
    body = await parseJsonBody(req, MetricsBody);
  } catch (e) {
    if (e instanceof ValidationError) return errorResponse(400, "invalid_body", "Invalid request body.", requestId, { details: e.details });
    throw e;
  }

  try {
    const metrics = extractDNA(body.transcript, body.durationSec);
    log.info("communication metrics computed", { wordCount: metrics.wordCount, confidence: metrics.confidence });
    return NextResponse.json({ metrics });
  } catch (e) {
    log.error("metrics computation failed", { error: e });
    return errorResponse(502, "metrics_failed", `Metrics computation failed: ${(e as Error).message}`, requestId);
  }
}
