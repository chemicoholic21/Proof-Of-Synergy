import { NextRequest, NextResponse } from "next/server";
import { ingestSessionEvent, ingestSession } from "@/lib/memory";
import { RememberBody } from "@/lib/memory/api-schemas";
import { logger } from "@/lib/logger";
import { newRequestId, errorResponse, enforceRateLimit, parseJsonBody, ValidationError } from "@/lib/http";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
  * remember() endpoint. Persists a learner profile or a completed practice session into the learner's
  * Communication Skill Graph and runs improve(). Returns the refreshed dashboard + improve summary so
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
    if (body.kind === "session") {
      const { dashboard, improve, graph } = await ingestSession(
        {
          learnerId: body.learnerId,
          name: body.name ?? null,
          skills: body.skills,
          experience: body.experience,
          education: body.education,
          milestones: body.milestones,
          rawText: body.rawText,
        },
        body.graph
      );
      log.info("remembered session profile", { learnerId: body.learnerId });
      return NextResponse.json({ ok: true, kind: "session", dashboard, improve, graph });
    }
    const { dashboard, improve, sessionIndex, graph } = await ingestSessionEvent(
      {
        learnerId: body.learnerId,
        name: body.name ?? null,
        partner: body.partner ?? null,
        answers: body.answers,
      },
      body.graph
    );
    log.info("remembered session event", { learnerId: body.learnerId, sessionIndex, milestones: improve.milestones });
    return NextResponse.json({ ok: true, kind: "sessionEvent", sessionIndex, dashboard, improve, graph });
  } catch (e) {
    log.error("remember failed", { error: e });
    return errorResponse(502, "remember_failed", `remember() failed: ${(e as Error).message}`, requestId);
  }
}
