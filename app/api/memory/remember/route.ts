import { NextRequest, NextResponse } from "next/server";
import { ingestInterview, ingestResume } from "@/lib/memory";
import { RememberBody } from "@/lib/memory/api-schemas";
import { logger } from "@/lib/logger";
import { newRequestId, errorResponse, enforceRateLimit, parseJsonBody, ValidationError } from "@/lib/http";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * remember() endpoint. Persists a resume version or a completed interview into the candidate's
 * Career Knowledge Graph and runs improve(). Returns the refreshed dashboard + improve summary so
 * the UI can animate the graph growing.
 */
export async function POST(req: NextRequest) {
  const requestId = newRequestId();
  const log = logger.child({ requestId, route: "memory/remember" });
  const limited = enforceRateLimit(req, "memory-remember", requestId);
  if (limited) return limited;

  let body;
  try {
    body = await parseJsonBody(req, RememberBody);
  } catch (e) {
    if (e instanceof ValidationError) return errorResponse(400, "invalid_body", "Invalid request body.", requestId, { details: e.details });
    throw e;
  }

  try {
    if (body.kind === "resume") {
      const { dashboard, improve } = await ingestResume({
        candidateId: body.candidateId,
        name: body.name ?? null,
        skills: body.skills,
        experience: body.experience,
        education: body.education,
        projects: body.projects,
        rawText: body.rawText,
      });
      log.info("remembered resume", { candidateId: body.candidateId });
      return NextResponse.json({ ok: true, kind: "resume", dashboard, improve });
    }
    const { dashboard, improve, interviewIndex } = await ingestInterview({
      candidateId: body.candidateId,
      name: body.name ?? null,
      company: body.company ?? null,
      answers: body.answers,
    });
    log.info("remembered interview", { candidateId: body.candidateId, interviewIndex, milestones: improve.milestones });
    return NextResponse.json({ ok: true, kind: "interview", interviewIndex, dashboard, improve });
  } catch (e) {
    log.error("remember failed", { error: e });
    return errorResponse(502, "remember_failed", `remember() failed: ${(e as Error).message}`, requestId);
  }
}
