import { NextResponse } from "next/server";
import { SCENARIOS } from "@/lib/scenarios";
import { ScenarioSchema } from "@/lib/schemas";
import { logger } from "@/lib/logger";
import { newRequestId, enforceRateLimit } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/scenarios - list the available practice scenarios. No auth required. */
export async function GET(req: Request) {
  const requestId = newRequestId();
  const limited = enforceRateLimit(req, "scenarios", requestId, { max: 120, windowMs: 60_000 });
  if (limited) return limited;

  // Normalize against the schema so the contract stays explicit.
  const scenarios = SCENARIOS.map((s) => ScenarioSchema.parse(s));
  logger.debug("scenarios listed", { requestId, count: scenarios.length });
  return NextResponse.json({ scenarios, count: scenarios.length });
}
