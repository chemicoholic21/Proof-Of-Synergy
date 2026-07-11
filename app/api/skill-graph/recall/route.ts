import { NextRequest, NextResponse } from "next/server";
import { cogneeSkillInsight, fromClient, loadOrInit, recallSkills } from "@/lib/skill-graph";
import { cogneeConfigured } from "@/lib/cognee";
import { RecallSkillBody } from "@/lib/schemas";
import { logger } from "@/lib/logger";
import { newRequestId, errorResponse, enforceRateLimit, parseJsonBody, ValidationError } from "@/lib/http";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * recall() - the learner's skill state (strong / weak / fading) plus, when Cognee is configured,
 * a graph-grounded answer to "what should I practice next?".
 */
export async function POST(req: NextRequest) {
  const requestId = newRequestId();
  const log = logger.child({ requestId, route: "skill-graph/recall" });
  const limited = enforceRateLimit(req, "skill-graph-recall", requestId);
  if (limited) return limited;

  let body;
  try {
    body = await parseJsonBody(req, RecallSkillBody);
  } catch (e) {
    if (e instanceof ValidationError) return errorResponse(400, "invalid_body", "Invalid request body.", requestId, { details: e.details });
    throw e;
  }

  try {
    const g = fromClient(body.learnerId, body.graph) ?? (await loadOrInit(body.learnerId, null));
    const result = recallSkills(g, body.skillName);
    const cogneeInsight = result.skills.length > 0 ? await cogneeSkillInsight(body.learnerId) : null;
    log.info("recall complete", {
      learnerId: body.learnerId,
      weak: result.weak.length,
      fading: result.fading.length,
      cognee: Boolean(cogneeInsight),
    });
    return NextResponse.json({ ...result, cogneeInsight, cogneeConfigured: cogneeConfigured() });
  } catch (e) {
    log.error("recall failed", { error: e });
    return errorResponse(502, "recall_failed", `recall() failed: ${(e as Error).message}`, requestId);
  }
}
