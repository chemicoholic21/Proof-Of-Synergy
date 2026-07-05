import { NextRequest, NextResponse } from "next/server";
import { recommendations, learningMissions, recall } from "@/lib/memory";
import { loadOrInit } from "@/lib/memory/graph/store";
import { buildDashboard } from "@/lib/memory/derive";
import { cogneeConfigured } from "@/lib/memory/cognee/client";
import { CareerGraph, emptyGraph } from "@/lib/memory/graph/model";
import { clock } from "@/lib/memory/graph/ops";
import { CandidateId, DashboardBody } from "@/lib/memory/api-schemas";
import { logger } from "@/lib/logger";
import { newRequestId, errorResponse, enforceRateLimit, parseJsonBody, ValidationError } from "@/lib/http";

export const runtime = "nodejs";
export const maxDuration = 30;

function payload(g: CareerGraph, company: string | null) {
  return {
    dashboard: buildDashboard(g),
    recommendations: recommendations(g, { company }),
    missions: learningMissions(g, { company }),
    recall: recall(g, { company }),
    cogneeConfigured: cogneeConfigured(),
  };
}

/** Loosely validate a client-provided graph object. */
function fromBody(candidateId: string, provided: unknown): CareerGraph {
  const p = provided as Partial<CareerGraph> | undefined;
  if (p && typeof p === "object" && p.nodes && p.edges) {
    return { ...emptyGraph(candidateId, p.name ?? null, clock()), nodes: p.nodes as CareerGraph["nodes"], edges: p.edges as CareerGraph["edges"], revision: p.revision ?? 0 };
  }
  return emptyGraph(candidateId, null, clock());
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
    const g = fromBody(body.candidateId, body.graph);
    log.info("dashboard served (client graph)", { candidateId: body.candidateId, interviews: buildDashboard(g).interviewCount });
    return NextResponse.json(payload(g, body.company ?? null));
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

  const candidateId = req.nextUrl.searchParams.get("candidateId") ?? "";
  const parsed = CandidateId.safeParse(candidateId);
  if (!parsed.success) return errorResponse(400, "invalid_candidate", "Missing or invalid candidateId.", requestId);
  const company = req.nextUrl.searchParams.get("company");

  try {
    const g = await loadOrInit(parsed.data, null);
    log.info("dashboard served (file store)", { candidateId: parsed.data });
    return NextResponse.json(payload(g, company));
  } catch (e) {
    log.error("dashboard failed", { error: e });
    return errorResponse(502, "dashboard_failed", `dashboard failed: ${(e as Error).message}`, requestId);
  }
}
