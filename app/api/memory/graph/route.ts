import { NextRequest, NextResponse } from "next/server";
import { recommendations, practiceMissions, recall } from "@/lib/memory";
import { loadOrInit } from "@/lib/memory/graph/store";
import { buildDashboard } from "@/lib/memory/derive";
import { cogneeConfigured } from "@/lib/memory/cognee/client";
import { CommGraph, emptyGraph } from "@/lib/memory/graph/model";
import { clock } from "@/lib/memory/graph/ops";
import { LearnerId, DashboardBody } from "@/lib/memory/api-schemas";
import { logger } from "@/lib/logger";
import { newRequestId, errorResponse, enforceRateLimit, parseJsonBody, ValidationError } from "@/lib/http";

export const runtime = "nodejs";
export const maxDuration = 30;

function payload(g: CommGraph, focus: string | null) {
  return {
    dashboard: buildDashboard(g),
    recommendations: recommendations(g, { limit: 8 }),
    missions: practiceMissions(g, { limit: 5 }),
    recall: recall(g, { focus }),
    cogneeConfigured: cogneeConfigured(),
  };
}

/** Loosely validate a client-provided graph object. */
function fromBody(learnerId: string, provided: unknown): CommGraph {
  const p = provided as Partial<CommGraph> | undefined;
  if (p && typeof p === "object" && p.nodes && p.edges) {
    return { ...emptyGraph(learnerId, p.name ?? null, clock()), nodes: p.nodes as CommGraph["nodes"], edges: p.edges as CommGraph["edges"], revision: p.revision ?? 0 };
  }
  return emptyGraph(learnerId, null, clock());
}

/**
  * POST - the durable path: the client sends its own graph (source of truth on serverless) and gets
  * the full dashboard payload derived from it. Use this so the dashboard shows the memory the client
  * accumulated regardless of which serverless instance handles the request.
  */
export async function POST(req: NextRequest) {
  const requestId = newRequestId();
  const log = logger.child({ requestId, route: "memory/graph:POST" });
  const limited = enforceRateLimit(req, "memory-graph", requestId, { max: 60, windowMs: 60_000 });
  if (limited) return limited;

  let body;
  try {
    body = await parseJsonBody(req, DashboardBody);
  } catch (e) {
    if (e instanceof ValidationError) return errorResponse(400, "invalid_body", "Invalid request body.", requestId, { details: e.details });
    throw e;
  }
  try {
    const g = fromBody(body.learnerId, body.graph);
    log.info("dashboard served (client graph)", { learnerId: body.learnerId, sessions: buildDashboard(g).sessionCount });
    return NextResponse.json(payload(g, body.focus ?? null));
  } catch (e) {
    log.error("dashboard failed", { error: e });
    return errorResponse(502, "dashboard_failed", `dashboard failed: ${(e as Error).message}`, requestId);
  }
}

/**
  * GET - legacy/local path: derive the dashboard from the server-side file store. Reliable in local
  * dev; on serverless it may be empty (per-instance /tmp), which is exactly why the client uses POST.
  */
export async function GET(req: NextRequest) {
  const requestId = newRequestId();
  const log = logger.child({ requestId, route: "memory/graph:GET" });
  const limited = enforceRateLimit(req, "memory-graph", requestId, { max: 60, windowMs: 60_000 });
  if (limited) return limited;

  const learnerId = req.nextUrl.searchParams.get("learnerId") ?? "";
  const parsed = LearnerId.safeParse(learnerId);
  if (!parsed.success) return errorResponse(400, "invalid_learner", "Missing or invalid learnerId.", requestId);
  const focus = req.nextUrl.searchParams.get("focus");

  try {
    const g = await loadOrInit(parsed.data, null);
    log.info("dashboard served (file store)", { learnerId: parsed.data });
    return NextResponse.json(payload(g, focus));
  } catch (e) {
    log.error("dashboard failed", { error: e });
    return errorResponse(502, "dashboard_failed", `dashboard failed: ${(e as Error).message}`, requestId);
  }
}
