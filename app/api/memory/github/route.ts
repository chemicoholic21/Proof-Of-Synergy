import { NextRequest, NextResponse } from "next/server";
import { ingestGithub } from "@/lib/memory";
import { GithubBody } from "@/lib/memory/api-schemas";
import { logger } from "@/lib/logger";
import { newRequestId, errorResponse, enforceRateLimit, parseJsonBody, ValidationError } from "@/lib/http";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * remember() a GitHub profile as a third, independent evidence source. Fetches public repos and
 * ingests the technologies they actually ship, so the Reality Gap can compare resume claims against
 * real code.
 */
export async function POST(req: NextRequest) {
  const requestId = newRequestId();
  const log = logger.child({ requestId, route: "memory/github" });
  const limited = enforceRateLimit(req, "memory-github", requestId, { max: 15, windowMs: 60_000 });
  if (limited) return limited;

  let body;
  try {
    body = await parseJsonBody(req, GithubBody);
  } catch (e) {
    if (e instanceof ValidationError) return errorResponse(400, "invalid_body", "Invalid request body.", requestId, { details: e.details });
    throw e;
  }

  try {
    const { dashboard, profile } = await ingestGithub(body.candidateId, body.username);
    log.info("github remembered", { candidateId: body.candidateId, username: profile.username, repos: profile.repoCount });
    return NextResponse.json({ ok: true, profile, dashboard });
  } catch (e) {
    const msg = (e as Error).message;
    log.warn("github ingest failed", { error: msg });
    // 404 / rate-limit are user-actionable, surface as 400 with the message.
    return errorResponse(400, "github_failed", msg, requestId);
  }
}
