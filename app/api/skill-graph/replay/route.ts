import { NextRequest, NextResponse } from "next/server";
import { fromClient, loadOrInit, practiceReplay } from "@/lib/skill-graph";
import { ReplaySkillBody } from "@/lib/schemas";
import { logger } from "@/lib/logger";
import { newRequestId, errorResponse, enforceRateLimit, parseJsonBody, ValidationError } from "@/lib/http";

export const runtime = "nodejs";
export const maxDuration = 30;

/** replay() - how one skill evolved across every practice session, so growth is visible over time. */
export async function POST(req: NextRequest) {
  const requestId = newRequestId();
  const log = logger.child({ requestId, route: "skill-graph/replay" });
  const limited = enforceRateLimit(req, "skill-graph-replay", requestId, { max: 60, windowMs: 60_000 });
  if (limited) return limited;

  let body;
  try {
    body = await parseJsonBody(req, ReplaySkillBody);
  } catch (e) {
    if (e instanceof ValidationError) return errorResponse(400, "invalid_body", "Invalid request body.", requestId, { details: e.details });
    throw e;
  }

  try {
    const g = fromClient(body.learnerId, body.graph) ?? (await loadOrInit(body.learnerId, null));
    const result = practiceReplay(g, body.skill);
    log.info("replay served", { learnerId: body.learnerId, skill: body.skill, entries: result.entries.length });
    return NextResponse.json(result);
  } catch (e) {
    log.error("replay failed", { error: e });
    return errorResponse(502, "replay_failed", `replay failed: ${(e as Error).message}`, requestId);
  }
}
