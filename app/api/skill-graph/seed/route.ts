import { NextRequest, NextResponse } from "next/server";
import { buildDashboard, buildDemoSkillGraph, saveSkillGraph } from "@/lib/skill-graph";
import { SeedSkillBody } from "@/lib/schemas";
import { logger } from "@/lib/logger";
import { newRequestId, errorResponse, enforceRateLimit, parseJsonBody, ValidationError } from "@/lib/http";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * One-click demo seed: three practice sessions across three weeks with a clear growth arc, so the
 * Skill Knowledge Graph can be shown without recording live audio first.
 */
export async function POST(req: NextRequest) {
  const requestId = newRequestId();
  const log = logger.child({ requestId, route: "skill-graph/seed" });
  const limited = enforceRateLimit(req, "skill-graph-seed", requestId, { max: 10, windowMs: 60_000 });
  if (limited) return limited;

  let body;
  try {
    body = await parseJsonBody(req, SeedSkillBody);
  } catch (e) {
    if (e instanceof ValidationError) return errorResponse(400, "invalid_body", "Invalid request body.", requestId, { details: e.details });
    throw e;
  }

  try {
    const g = buildDemoSkillGraph(body.learnerId, body.name ?? undefined);
    await saveSkillGraph(g);
    log.info("demo seeded", { learnerId: body.learnerId, sessions: Object.keys(g.sessions).length });
    return NextResponse.json({ ok: true, dashboard: buildDashboard(g), graph: g });
  } catch (e) {
    log.error("seed failed", { error: e });
    return errorResponse(502, "seed_failed", `seed failed: ${(e as Error).message}`, requestId);
  }
}
