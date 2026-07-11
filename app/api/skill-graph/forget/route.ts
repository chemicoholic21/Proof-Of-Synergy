import { NextRequest, NextResponse } from "next/server";
import { buildDashboard, forgetSkill, fromClient } from "@/lib/skill-graph";
import { ForgetSkillBody } from "@/lib/schemas";
import { logger } from "@/lib/logger";
import { newRequestId, errorResponse, enforceRateLimit, parseJsonBody, ValidationError } from "@/lib/http";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * forget() - learner-controlled deletion. Removes a skill, a session, or everything, both from
 * the local graph and (for "all") from the learner's Cognee dataset. Privacy is a feature.
 */
export async function POST(req: NextRequest) {
  const requestId = newRequestId();
  const log = logger.child({ requestId, route: "skill-graph/forget" });
  const limited = enforceRateLimit(req, "skill-graph-forget", requestId, { max: 20, windowMs: 60_000 });
  if (limited) return limited;

  let body;
  try {
    body = await parseJsonBody(req, ForgetSkillBody);
  } catch (e) {
    if (e instanceof ValidationError) return errorResponse(400, "invalid_body", "Invalid request body.", requestId, { details: e.details });
    throw e;
  }

  try {
    const { graph, removed } = await forgetSkill(body.learnerId, fromClient(body.learnerId, body.graph), body.target);
    log.info("forget complete", { learnerId: body.learnerId, target: body.target.type, removed: removed.length });
    return NextResponse.json({ ok: true, removed, dashboard: buildDashboard(graph), graph });
  } catch (e) {
    log.error("forget failed", { error: e });
    return errorResponse(502, "forget_failed", `forget() failed: ${(e as Error).message}`, requestId);
  }
}
