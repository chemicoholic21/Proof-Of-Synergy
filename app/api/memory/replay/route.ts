import { NextRequest, NextResponse } from "next/server";
import { memoryReplay } from "@/lib/memory";
import { loadOrInit } from "@/lib/memory/graph/store";
import { emptyGraph, CareerGraph } from "@/lib/memory/graph/model";
import { clock } from "@/lib/memory/graph/ops";
import { ReplayBody } from "@/lib/memory/api-schemas";
import { logger } from "@/lib/logger";
import { newRequestId, errorResponse, enforceRateLimit, parseJsonBody, ValidationError } from "@/lib/http";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * Memory Replay — every time the candidate answered a given skill/concept across all interviews,
 * so growth (or remaining weakness) is visible over months.
 */
export async function POST(req: NextRequest) {
  const requestId = newRequestId();
  const log = logger.child({ requestId, route: "memory/replay" });
  const limited = enforceRateLimit(req, "memory-replay", requestId, { max: 60, windowMs: 60_000 });
  if (limited) return limited;

  let body;
  try {
    body = await parseJsonBody(req, ReplayBody);
  } catch (e) {
    if (e instanceof ValidationError) return errorResponse(400, "invalid_body", "Invalid request body.", requestId, { details: e.details });
    throw e;
  }

  try {
    const p = body.graph as Partial<CareerGraph> | undefined;
    const g = p && p.nodes && p.edges
      ? { ...emptyGraph(body.candidateId, p.name ?? null, clock()), nodes: p.nodes as CareerGraph["nodes"], edges: p.edges as CareerGraph["edges"] }
      : await loadOrInit(body.candidateId, null);
    const entries = memoryReplay(g, body.concept);
    log.info("replay served", { candidateId: body.candidateId, concept: body.concept, entries: entries.length });
    return NextResponse.json({ concept: body.concept, entries });
  } catch (e) {
    log.error("replay failed", { error: e });
    return errorResponse(502, "replay_failed", `replay failed: ${(e as Error).message}`, requestId);
  }
}
