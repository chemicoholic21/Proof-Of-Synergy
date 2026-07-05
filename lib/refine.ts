// L1 + L2 verification layers. These are GENERATOR -> VERIFIER pairs: a second agent (ideally a
// cheaper/different model) checks the first agent's output. They are deliberately BEST-EFFORT -
// a verifier failure must never break the core pipeline, so every entry point falls back to the
// unverified result and logs why. External verification (not self-critique) is the kind that
// actually helps (Huang et al., ICLR 2024).

import { sarvamChat, extractValidatedJson } from "./sarvam";
import {
  EXTRACTION_VERIFY_SYSTEM,
  extractionVerifyUser,
  QUESTION_ADVERSARY_SYSTEM,
  questionAdversaryUser,
} from "./prompts";
import { ExtractionVerifyLLMSchema, QuestionAdversaryLLMSchema } from "./schemas";
import { ResumeSkill, InterviewQuestion } from "./types";
import { logger } from "./logger";

const log = logger.child({ module: "refine" });

/**
 * L1: drop hallucinated skills that are not grounded in the source resume text. Conservative:
 * only removes a skill when doing so still leaves at least one skill, so an over-eager verifier
 * can never empty the result. Returns the (possibly trimmed) skills plus the dropped names.
 */
export async function verifyResumeSkills(
  skills: ResumeSkill[],
  sourceText: string
): Promise<{ skills: ResumeSkill[]; dropped: string[] }> {
  try {
    const raw = await sarvamChat(
      EXTRACTION_VERIFY_SYSTEM,
      extractionVerifyUser(sourceText, skills),
      { temperature: 0.1, maxTokens: 2000 }
    );
    const out = extractValidatedJson(raw, ExtractionVerifyLLMSchema);
    const unsupported = new Set(out.unsupported.map((u) => u.name.toLowerCase().trim()));
    if (unsupported.size === 0) return { skills, dropped: [] };

    const kept = skills.filter((s) => !unsupported.has(s.name.toLowerCase().trim()));
    // Never let the verifier remove everything; if it would, keep the original extraction.
    if (kept.length === 0) return { skills, dropped: [] };

    const dropped = skills.filter((s) => !kept.includes(s)).map((s) => s.name);
    if (dropped.length) log.info("extraction verifier dropped unsupported skills", { dropped });
    return { skills: kept, dropped };
  } catch (e) {
    log.warn("extraction verifier skipped (best-effort)", { error: (e as Error).message });
    return { skills, dropped: [] };
  }
}

/**
 * L2: ask an adversarial reviewer to flag weak questions (yes/no, definition-lookup,
 * self-answering) and substitute its improved version when one is offered. Best-effort: returns
 * the original questions unchanged on any failure.
 */
export async function refineQuestions(
  questions: InterviewQuestion[]
): Promise<{ questions: InterviewQuestion[]; revised: number }> {
  try {
    const raw = await sarvamChat(
      QUESTION_ADVERSARY_SYSTEM,
      questionAdversaryUser(questions.map((q) => ({ id: q.id, text: q.text, targetSkill: q.targetSkill }))),
      { temperature: 0.3, maxTokens: 3000 }
    );
    const out = extractValidatedJson(raw, QuestionAdversaryLLMSchema);
    const byId = new Map(out.reviews.map((r) => [r.id, r]));

    let revised = 0;
    const next = questions.map((q) => {
      const review = byId.get(q.id);
      if (review?.verdict === "revise" && review.improved_question && review.improved_question.trim()) {
        revised++;
        return { ...q, text: review.improved_question.trim() };
      }
      return q;
    });
    if (revised) log.info("question adversary revised weak questions", { revised });
    return { questions: next, revised };
  } catch (e) {
    log.warn("question adversary skipped (best-effort)", { error: (e as Error).message });
    return { questions, revised: 0 };
  }
}
