import { NextRequest, NextResponse } from "next/server";
import { buildDemoGraph } from "@/lib/memory/demo";
import { saveGraph } from "@/lib/memory/graph/store";
import { buildDashboard } from "@/lib/memory/derive";
import { SeedBody } from "@/lib/memory/api-schemas";
import { logger } from "@/lib/logger";
import { newRequestId, errorResponse, enforceRateLimit, parseJsonBody, ValidationError } from "@/lib/http";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * One-click demo seed: builds a six-month career history (resume + three interviews across Stripe
 * and Google, with a clear growth arc) so the hackathon demo never needs manual data entry.
 */
export async function POST(req: NextRequest) {
  const requestId = newRequestId();
  const log = logger.child({ requestId, route: "memory/seed" });
  const limited = enforceRateLimit(req, "memory-seed", requestId, { max: 10, windowMs: 60_000 });
  if (limited) return limited;

  let body;
  try {
    body = await parseJsonBody(req, SeedBody);
  } catch (e) {
    if (e instanceof ValidationError) return errorResponse(400, "invalid_body", "Invalid request body.", requestId, { details: e.details });
    throw e;
  }

  try {
    const g = buildDemoGraph(body.candidateId, body.name ?? "Aarav Sharma");
    await saveGraph(g);
    log.info("demo seeded", { candidateId: body.candidateId, nodes: Object.keys(g.nodes).length });
    return NextResponse.json({ ok: true, dashboard: buildDashboard(g) });
  } catch (e) {
    log.error("seed failed", { error: e });
    return errorResponse(502, "seed_failed", `seed failed: ${(e as Error).message}`, requestId);
  }
}
