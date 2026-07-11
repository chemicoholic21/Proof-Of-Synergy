import { NextRequest, NextResponse } from "next/server";
import { buildDashboard, fromClient, rememberSession } from "@/lib/skill-graph";
import { RememberSessionBody } from "@/lib/schemas";
import { logger } from "@/lib/logger";
import { newRequestId, errorResponse, enforceRateLimit, parseJsonBody, ValidationError } from "@/lib/http";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * remember() - fold a completed practice session into the learner's Skill Knowledge Graph and
 * mirror it into Cognee. Returns the updated graph (the client persists it) plus the refreshed
 * dashboard so the UI can show the graph growing.
 */
export async function POST(req: NextRequest) {
  const requestId = newRequestId();
  const log = logger.child({ requestId, route: "skill-graph/remember" });
  const limited = enforceRateLimit(req, "skill-graph-remember", requestId);
  if (limited) return limited;

  let body;
  try {
    body = await parseJsonBody(req, RememberSessionBody);
  } catch (e) {
    if (e instanceof ValidationError) return errorResponse(400, "invalid_body", "Invalid request body.", requestId, { details: e.details });
    throw e;
  }

  try {
    const { graph, sessionId, skillIds } = await rememberSession({
      learnerId: body.learnerId,
      name: body.name ?? null,
      session: body.session,
      graph: fromClient(body.learnerId, body.graph),
    });
    log.info("session remembered", { learnerId: body.learnerId, sessionId, skills: skillIds.length });
    return NextResponse.json({ ok: true, sessionId, skillIds, dashboard: buildDashboard(graph), graph });
  } catch (e) {
    log.error("remember failed", { error: e });
    return errorResponse(502, "remember_failed", `remember() failed: ${(e as Error).message}`, requestId);
  }
}
