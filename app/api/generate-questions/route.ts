import { NextRequest, NextResponse } from "next/server";
import { sarvamChat, extractValidatedJson, extractJsonArrayItems, sarvamConfigured } from "@/lib/sarvam";
import { QUESTION_GEN_SYSTEM, questionGenUser, questionGenAdaptiveUser } from "@/lib/prompts";
import { refineQuestions } from "@/lib/refine";
import { buildFallbackQuestions } from "@/lib/fallbackData";
import { InterviewQuestion } from "@/lib/types";
import { GenerateQuestionsBody, QuestionsLLMSchema } from "@/lib/schemas";
import { reason } from "@/lib/memory";
import type { RecallResult } from "@/lib/memory";
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

  let skills, candidateId: string | undefined, company: string | null | undefined;
  try {
    ({ skills, candidateId, company } = await parseJsonBody(req, GenerateQuestionsBody));
  } catch (e) {
    if (e instanceof ValidationError) {
      return errorResponse(400, "invalid_body", "Invalid request body.", requestId, { details: e.details });
    }
    throw e;
  }

  // recall(): consult the Career Knowledge Graph BEFORE generating. The LLM never designs an
  // interview blind when we have memory — this is the adaptive-difficulty seam.
  let memory: RecallResult | null = null;
  if (candidateId) {
    try {
      // withCognee: consult Cognee's own graph for a focus directive, not just the local mirror.
      memory = await reason(candidateId, { company: company ?? null, withCognee: true });
    } catch (e) {
      log.warn("recall unavailable, falling back to stateless generation", { error: (e as Error).message });
    }
  }
  const adaptive = Boolean(memory && !memory.isNew);

  try {
    const userPrompt = adaptive && memory ? questionGenAdaptiveUser(skills, memory) : questionGenUser(skills);
    const raw = await sarvamChat(QUESTION_GEN_SYSTEM, userPrompt, {
      temperature: 0.4,
      maxTokens: env.SARVAM_MAX_TOKENS, // ask for the tier max; clamped in sarvamChat
    });
    // The questions array can be long enough to hit the token cap mid-object. Parse strictly first;
    // if that fails on a truncated response, salvage the complete question objects instead of
    // discarding the whole generation.
    let out: { questions: { id?: number; text: string; targetSkill: string; rubric: string }[] };
    try {
      out = extractValidatedJson(raw, QuestionsLLMSchema);
    } catch (parseErr) {
      const salvaged = extractJsonArrayItems(raw);
      const parsed = QuestionsLLMSchema.safeParse({ questions: salvaged });
      if (!parsed.success || parsed.data.questions.length === 0) throw parseErr;
      log.warn("question JSON truncated, salvaged complete items", { recovered: parsed.data.questions.length });
      out = parsed.data;
    }

    // Normalize targetSkill back to an exact resume skill name, the reasoning model sometimes
    // echoes the full "Spark (Data, claimed advanced)" descriptor, which would break the
    // fraud-detector's skill matching downstream.
    const normalize = (value: string): string => {
      const low = (value || "").toLowerCase();
      const hit = skills.find((s) => low.includes(s.name.toLowerCase()));
      return hit ? hit.name : skills[0]?.name ?? value;
    };
    let questions: InterviewQuestion[] = out.questions
      .filter((q) => q.text && q.targetSkill)
      .map((q, i) => ({ id: i + 1, text: q.text, rubric: q.rubric ?? "", targetSkill: normalize(q.targetSkill) }));
    if (!questions.length) throw new Error("Model returned no usable questions.");

    // L2: adversarial reviewer rewrites weak (yes/no, definition-lookup, self-answering) questions.
    // Best-effort, so generation never fails because the reviewer did.
    let revised = 0;
    if (env.EVAL_VERIFY_LAYERS) ({ questions, revised } = await refineQuestions(questions));

    log.info("questions generated", { count: questions.length, revised, adaptive });
    return NextResponse.json({
      questions,
      source: "sarvam",
      adaptive,
      recall: memory
        ? {
            interviewCount: memory.interviewCount,
            focusDirectives: memory.focusDirectives,
            weakConcepts: memory.weakConcepts,
            forgottenConcepts: memory.forgottenConcepts,
            unverifiedSkills: memory.unverifiedSkills,
            masteredConcepts: memory.masteredConcepts,
            upcomingCompany: memory.upcomingCompany,
            cogneeInsight: memory.cogneeInsight ?? null,
          }
        : null,
    });
  } catch (e) {
    const message = (e as Error).message;
    log.error("question generation failed", { error: e });

    if (env.DEMO_MODE) {
      // Build questions from the candidate's REAL skills so the interview still reflects the
      // uploaded resume, and flag it as a fallback so the UI can say generation degraded.
      const questions = buildFallbackQuestions(skills);
      const reasonMsg = sarvamConfigured()
        ? `Question generation failed, using resume-derived demo questions: ${message}`
        : "SARVAM_API_KEY is not configured, using resume-derived demo questions (DEMO_MODE).";
      return NextResponse.json({ questions, source: "fallback", reason: reasonMsg, adaptive: false });
    }

    if (!sarvamConfigured()) {
      return errorResponse(503, "service_unconfigured", "Question generation is unavailable: SARVAM_API_KEY is not configured.", requestId);
    }
    return errorResponse(502, "generation_failed", `Question generation failed: ${message}`, requestId);
  }
}
