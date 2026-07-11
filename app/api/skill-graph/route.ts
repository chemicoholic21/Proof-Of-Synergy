import { NextRequest, NextResponse } from "next/server";
import { buildDashboard, fromClient, loadOrInit, recallSkills } from "@/lib/skill-graph";
import { cogneeConfigured } from "@/lib/cognee";
import { SkillGraphBody, LearnerId } from "@/lib/schemas";
import { logger } from "@/lib/logger";
import { newRequestId, errorResponse, enforceRateLimit, parseJsonBody, ValidationError } from "@/lib/http";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * The Skill Knowledge Graph read-model.
 *
 * POST - durable path: the client sends its own graph (source of truth on serverless) and gets the
 * full dashboard payload derived from it.
 * GET  - local path: derive the dashboard from the server-side file store (reliable in local dev).
 */
export async function POST(req: NextRequest) {
  const requestId = newRequestId();
  const log = logger.child({ requestId, route: "skill-graph:POST" });
  const limited = enforceRateLimit(req, "skill-graph", requestId, { max: 60, windowMs: 60_000 });
  if (limited) return limited;

  let body;
  try {
    body = await parseJsonBody(req, SkillGraphBody);
  } catch (e) {
    if (e instanceof ValidationError) return errorResponse(400, "invalid_body", "Invalid request body.", requestId, { details: e.details });
    throw e;
  }

  try {
    const g = fromClient(body.learnerId, body.graph) ?? (await loadOrInit(body.learnerId, null));
    const dashboard = buildDashboard(g);
    log.info("skill graph served", { learnerId: body.learnerId, sessions: dashboard.sessionCount });
    return NextResponse.json({ dashboard, recall: recallSkills(g), cogneeConfigured: cogneeConfigured(), graph: g });
  } catch (e) {
    log.error("skill graph failed", { error: e });
    return errorResponse(502, "skill_graph_failed", `Skill graph failed: ${(e as Error).message}`, requestId);
  }
}

export async function GET(req: NextRequest) {
  const requestId = newRequestId();
  const log = logger.child({ requestId, route: "skill-graph:GET" });
  const limited = enforceRateLimit(req, "skill-graph", requestId, { max: 60, windowMs: 60_000 });
  if (limited) return limited;

  const learnerId = LearnerId.safeParse(req.nextUrl.searchParams.get("learnerId") ?? "");
  if (!learnerId.success) return errorResponse(400, "invalid_learner", "Missing or invalid learnerId.", requestId);

  try {
    const g = await loadOrInit(learnerId.data, null);
    log.info("skill graph served (file store)", { learnerId: learnerId.data });
    return NextResponse.json({ dashboard: buildDashboard(g), recall: recallSkills(g), cogneeConfigured: cogneeConfigured(), graph: g });
  } catch (e) {
    log.error("skill graph failed", { error: e });
    return errorResponse(502, "skill_graph_failed", `Skill graph failed: ${(e as Error).message}`, requestId);
  }
}
