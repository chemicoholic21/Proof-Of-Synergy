import { z } from "zod";

/**
 * Zod schemas for every trust boundary: incoming API request bodies AND the JSON the LLM returns.
 *
 * The LLM is an untrusted source, "parseable JSON" is not the same as "valid data". Validating its
 * output here means a malformed or adversarial response is rejected instead of silently flowing into
 * scores and, ultimately, an on-chain attestation.
 */

export const SkillLevel = z.enum(["beginner", "intermediate", "advanced", "expert"]);

export const ResumeSkillSchema = z.object({
  name: z.string().min(1).max(120),
  category: z.string().min(1).max(120),
  claimedLevel: SkillLevel.catch("intermediate"),
});

// ---- Resume parsing (LLM output) ----
export const ParsedResumeLLMSchema = z.object({
  name: z.string().max(200).nullable().catch(null),
  contact: z.string().max(300).nullable().catch(null),
  skills: z.array(ResumeSkillSchema).min(1).max(20),
  experience: z
    .array(
      z.object({
        role: z.string().max(200),
        company: z.string().max(200),
        years: z.coerce.number().min(0).max(80).catch(0),
      })
    )
    .max(50)
    .catch([]),
  education: z
    .array(
      z.object({
        degree: z.string().max(200),
        institution: z.string().max(200),
        year: z.coerce.number().int().nullable().catch(null),
      })
    )
    .max(50)
    .catch([]),
});

// ---- Question generation ----
export const GenerateQuestionsBody = z.object({
  skills: z.array(ResumeSkillSchema).min(1).max(20),
  // Optional: when present, question generation consults the candidate's Career Knowledge Graph
  // (recall) and produces an ADAPTIVE interview. Absent => original stateless behaviour.
  candidateId: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-zA-Z0-9_-]+$/)
    .optional(),
  company: z.string().max(120).nullable().optional(),
  // Client-held graph (durable source of truth on serverless) so recall() is adaptive cross-instance.
  graph: z.any().optional(),
});

// Some models ignore the wrapper and return a bare array of questions instead of
// { questions: [...] }. Accept both shapes by normalizing a top-level array first.
export const QuestionsLLMSchema = z.preprocess(
  (v) => (Array.isArray(v) ? { questions: v } : v),
  z.object({
    questions: z
      .array(
        z.object({
          id: z.coerce.number().int().optional(),
          text: z.string().min(1).max(2000),
          targetSkill: z.string().min(1).max(200),
          rubric: z.string().max(2000).catch(""),
        })
      )
      .min(1)
      .max(40),
  })
);

// ---- Evaluation ----
export const InterviewQuestionSchema = z.object({
  id: z.coerce.number().int(),
  text: z.string().min(1).max(2000),
  targetSkill: z.string().min(1).max(200),
  rubric: z.string().max(2000).default(""),
});

export const EvaluateBody = z.object({
  items: z
    .array(
      z.object({
        question: InterviewQuestionSchema,
        answer: z.string().max(20_000).default(""),
      })
    )
    .min(1)
    .max(40),
});

export const EvaluationLLMSchema = z.object({
  score: z.coerce.number(),
  feedback: z.string().max(4000).catch(""),
  strengths: z.array(z.string().max(500)).max(20).catch([]),
  improvements: z.array(z.string().max(500)).max(20).catch([]),
});

// ---- Multi-agent layer outputs (all LLM-produced, all validated at the trust boundary) ----

// L1: extraction verifier
export const ExtractionVerifyLLMSchema = z.object({
  unsupported: z
    .array(z.object({ name: z.string().max(200), reason: z.string().max(500).catch("") }))
    .max(20)
    .catch([]),
  missed: z
    .array(z.object({ name: z.string().max(200), evidence: z.string().max(500).catch("") }))
    .max(20)
    .catch([]),
});

// L2: question adversary
export const QuestionAdversaryLLMSchema = z.object({
  reviews: z
    .array(
      z.object({
        id: z.coerce.number().int().catch(0),
        verdict: z.enum(["keep", "revise"]).catch("keep"),
        issues: z.array(z.string().max(500)).max(10).catch([]),
        improved_question: z.string().max(2000).nullable().catch(null),
      })
    )
    .max(40)
    .catch([]),
});

// L3: judge panel - three diverse lenses
export const JudgeTechnicalLLMSchema = z.object({
  score: z.coerce.number(),
  justification: z.string().max(2000).catch(""),
});

export const JudgeCommunicationLLMSchema = z.object({
  score: z.coerce.number(),
  authenticity_flags: z.array(z.string().max(500)).max(20).catch([]),
  justification: z.string().max(2000).catch(""),
});

export const JudgeSkepticLLMSchema = z.object({
  deduction: z.coerce.number(),
  reasons: z.array(z.string().max(500)).max(20).catch([]),
});

// ---- TTS ----
export const TtsBody = z.object({
  text: z.string().min(1).max(2000),
  language: z.string().max(10).optional(),
});

