import { NextRequest, NextResponse } from "next/server";
import { sarvamChat, extractValidatedJson, sarvamConfigured } from "@/lib/sarvam";
import { EVAL_SYSTEM, evalUser } from "@/lib/prompts";
import { FALLBACK_EVALUATIONS } from "@/lib/fallbackData";
import { QuestionEvaluation } from "@/lib/types";
import { EvaluateBody, EvaluationLLMSchema } from "@/lib/schemas";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { newRequestId, errorResponse, enforceRateLimit, parseJsonBody, ValidationError } from "@/lib/http";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const requestId = newRequestId();
  const log = logger.child({ requestId, route: "evaluate" });

  const limited = enforceRateLimit(req, "evaluate", requestId);
  if (limited) return limited;

  let items;
  try {
    ({ items } = await parseJsonBody(req, EvaluateBody));
  } catch (e) {
    if (e instanceof ValidationError) {
      return errorResponse(400, "invalid_body", "Invalid request body.", requestId, { details: e.details });
    }
    throw e;
  }

  if (!env.DEMO_MODE && !sarvamConfigured()) {
    return errorResponse(503, "service_unconfigured", "Evaluation is unavailable: SARVAM_API_KEY is not configured.", requestId);
  }

  try {
    const evaluations: QuestionEvaluation[] = await Promise.all(
      items.map(async ({ question, answer }) => {
        try {
          const raw = await sarvamChat(
            EVAL_SYSTEM,
            evalUser(question.text, question.targetSkill, question.rubric, answer),
            { temperature: 0.3 }
          );
          const out = extractValidatedJson(raw, EvaluationLLMSchema);
          const score = Math.max(0, Math.min(100, Math.round(out.score)));
          return {
            questionId: question.id,
            targetSkill: question.targetSkill,
            score,
            feedback: out.feedback,
            strengths: out.strengths,
            improvements: out.improvements,
          };
        } catch (e) {
          // INTEGRITY: a failed evaluation must never become a fabricated score in production,
          // because that score drives an on-chain attestation. Only DEMO_MODE substitutes samples.
          if (!env.DEMO_MODE) throw e;
          log.warn("evaluation fallback (DEMO_MODE)", { questionId: question.id, error: (e as Error).message });
          const fb = FALLBACK_EVALUATIONS[question.id] || {
            questionId: question.id,
            targetSkill: question.targetSkill,
            score: 75,
            feedback: "Reasonable answer.",
            strengths: [],
            improvements: [],
          };
          return { ...fb, questionId: question.id, targetSkill: question.targetSkill };
        }
      })
    );

    log.info("evaluation complete", { count: evaluations.length });
    return NextResponse.json({ evaluations });
  } catch (e) {
    log.error("evaluation failed", { error: e });
    return errorResponse(502, "evaluation_failed", `Evaluation failed: ${(e as Error).message}`, requestId);
  }
}
