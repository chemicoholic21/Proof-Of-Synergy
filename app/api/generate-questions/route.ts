import { NextRequest, NextResponse } from "next/server";
import { sarvamChat, extractValidatedJson, sarvamConfigured } from "@/lib/sarvam";
import { QUESTION_GEN_SYSTEM, questionGenUser } from "@/lib/prompts";
import { FALLBACK_QUESTIONS } from "@/lib/fallbackData";
import { InterviewQuestion } from "@/lib/types";
import { GenerateQuestionsBody, QuestionsLLMSchema } from "@/lib/schemas";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { newRequestId, errorResponse, enforceRateLimit, parseJsonBody, ValidationError } from "@/lib/http";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const requestId = newRequestId();
  const log = logger.child({ requestId, route: "generate-questions" });

  const limited = enforceRateLimit(req, "generate-questions", requestId);
  if (limited) return limited;

  let skills;
  try {
    ({ skills } = await parseJsonBody(req, GenerateQuestionsBody));
  } catch (e) {
    if (e instanceof ValidationError) {
      return errorResponse(400, "invalid_body", "Invalid request body.", requestId, { details: e.details });
    }
    throw e;
  }

  try {
    const raw = await sarvamChat(QUESTION_GEN_SYSTEM, questionGenUser(skills), {
      temperature: 0.4,
      maxTokens: 3000,
    });
    const out = extractValidatedJson(raw, QuestionsLLMSchema);

    // Normalize targetSkill back to an exact resume skill name, the reasoning model sometimes
    // echoes the full "Spark (Data, claimed advanced)" descriptor, which would break the
    // fraud-detector's skill matching downstream.
    const normalize = (value: string): string => {
      const low = (value || "").toLowerCase();
      const hit = skills.find((s) => low.includes(s.name.toLowerCase()));
      return hit ? hit.name : skills[0]?.name ?? value;
    };
    const questions: InterviewQuestion[] = out.questions
      .filter((q) => q.text && q.targetSkill)
      .map((q, i) => ({ id: i + 1, text: q.text, rubric: q.rubric ?? "", targetSkill: normalize(q.targetSkill) }));
    if (!questions.length) throw new Error("Model returned no usable questions.");

    log.info("questions generated", { count: questions.length });
    return NextResponse.json({ questions });
  } catch (e) {
    const message = (e as Error).message;
    log.error("question generation failed", { error: e });

    if (env.DEMO_MODE) {
      const names = new Set(skills.map((s) => s.name.toLowerCase()));
      let qs = FALLBACK_QUESTIONS.filter((q) => names.has(q.targetSkill.toLowerCase()));
      if (qs.length < 2) qs = FALLBACK_QUESTIONS;
      return NextResponse.json({ questions: qs.map((q, i) => ({ ...q, id: i + 1 })) });
    }

    if (!sarvamConfigured()) {
      return errorResponse(503, "service_unconfigured", "Question generation is unavailable: SARVAM_API_KEY is not configured.", requestId);
    }
    return errorResponse(502, "generation_failed", `Question generation failed: ${message}`, requestId);
  }
}
