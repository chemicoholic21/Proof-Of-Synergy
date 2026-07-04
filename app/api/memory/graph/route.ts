import { NextRequest, NextResponse } from "next/server";
import { dashboard, recommendations, learningMissions, recall } from "@/lib/memory";
import { loadOrInit } from "@/lib/memory/graph/store";
import { cogneeConfigured } from "@/lib/memory/cognee/client";
import { CandidateId } from "@/lib/memory/api-schemas";
import { logger } from "@/lib/logger";
import { newRequestId, errorResponse, enforceRateLimit } from "@/lib/http";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * The whole Career Intelligence Dashboard payload for a candidate: graph view, reality gap, skill
 * evidence, communication + improvement trends, recommendations, learning missions and the recall
 * reasoner state. Everything the dashboard renders is derived from the graph here.
 */
export async function GET(req: NextRequest) {
  const requestId = newRequestId();
  const log = logger.child({ requestId, route: "memory/graph" });
  const limited = enforceRateLimit(req, "memory-graph", requestId, { max: 60, windowMs: 60_000 });
  if (limited) return limited;

  const candidateId = req.nextUrl.searchParams.get("candidateId") ?? "";
  const parsed = CandidateId.safeParse(candidateId);
  if (!parsed.success) return errorResponse(400, "invalid_candidate", "Missing or invalid candidateId.", requestId);
  const company = req.nextUrl.searchParams.get("company");

  try {
    const g = await loadOrInit(parsed.data, null);
    const dash = await dashboard(parsed.data);
    const recs = recommendations(g, { company });
    const missions = learningMissions(g, { company });
    const reasoner = recall(g, { company });
    log.info("dashboard served", { candidateId: parsed.data, interviews: dash.interviewCount });
    return NextResponse.json({
      dashboard: dash,
      recommendations: recs,
      missions,
      recall: reasoner,
      cogneeConfigured: cogneeConfigured(),
    });
  } catch (e) {
    log.error("dashboard failed", { error: e });
    return errorResponse(502, "dashboard_failed", `dashboard failed: ${(e as Error).message}`, requestId);
  }
}
