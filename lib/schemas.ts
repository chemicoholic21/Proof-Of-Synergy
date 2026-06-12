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
});

export const QuestionsLLMSchema = z.object({
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
});

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

// ---- TTS ----
export const TtsBody = z.object({
  text: z.string().min(1).max(2000),
  language: z.string().max(10).optional(),
});

// ---- Mint ----
export const SkillVerdictSchema = z.object({
  skill: z.string().min(1).max(200),
  claimedLevel: SkillLevel,
  observedConfidence: z.coerce.number().int().min(0).max(100),
  status: z.enum(["strong", "verified", "exaggerated"]),
  flag: z.string().max(500).nullable().default(null),
});

export const MintBody = z.object({
  verdicts: z.array(SkillVerdictSchema).min(1).max(20),
  overall: z.coerce.number().int().min(0).max(100).default(0),
  name: z.string().max(200).default("Anonymous"),
  // Explicit candidate consent is required before anything is published publicly on-chain.
  consent: z.boolean().default(false),
});

// ---- Gate check ----
export const GateCheckBody = z.object({
  subject: z.string().regex(/^0x[0-9a-fA-F]{40}$/, "subject must be a 0x address"),
  skill: z.string().min(1).max(200),
  minConfidence: z.coerce.number().int().min(0).max(100),
});

// ---- Tx receipt ----
export const TxReceiptBody = z.object({
  hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/, "hash must be a 0x-prefixed 32-byte hex string"),
});
