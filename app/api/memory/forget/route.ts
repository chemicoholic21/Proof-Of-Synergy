import { NextRequest, NextResponse } from "next/server";
import { forgetMemory, dashboard } from "@/lib/memory";
import { ForgetBody } from "@/lib/memory/api-schemas";
import { logger } from "@/lib/logger";
import { newRequestId, errorResponse, enforceRateLimit, parseJsonBody, ValidationError } from "@/lib/http";

export const runtime = "nodejs";
export const maxDuration = 30;

/** forget() endpoint. Prunes a memory while preserving graph consistency. */
export async function POST(req: NextRequest) {
  const requestId = newRequestId();
  const log = logger.child({ requestId, route: "memory/forget" });
  const limited = enforceRateLimit(req, "memory-forget", requestId, { max: 20, windowMs: 60_000 });
  if (limited) return limited;

  let body;
  try {
    body = await parseJsonBody(req, ForgetBody);
  } catch (e) {
    if (e instanceof ValidationError) return errorResponse(400, "invalid_body", "Invalid request body.", requestId, { details: e.details });
    throw e;
  }

  try {
    const result = await forgetMemory(body.candidateId, body.target);
    const dash = body.target.type === "all" ? null : await dashboard(body.candidateId);
    log.info("forget complete", { candidateId: body.candidateId, target: body.target.type, ...result });
    return NextResponse.json({ ...result, dashboard: dash });
  } catch (e) {
    log.error("forget failed", { error: e });
    return errorResponse(502, "forget_failed", `forget() failed: ${(e as Error).message}`, requestId);
  }
}
