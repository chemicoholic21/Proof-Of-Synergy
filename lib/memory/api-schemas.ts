import { z } from "zod";
import { SkillLevel } from "@/lib/schemas";

/** Zod schemas for the memory API trust boundary. */

const CandidateId = z.string().min(1).max(80).regex(/^[a-zA-Z0-9_-]+$/, "candidateId must be url-safe");

const MemorySkill = z.object({
  name: z.string().min(1).max(120),
  category: z.string().max(120).optional(),
  claimedLevel: SkillLevel.catch("intermediate"),
});

const MemoryProject = z.object({
  name: z.string().min(1).max(160),
  technologies: z.array(z.string().max(80)).max(30).optional(),
  summary: z.string().max(2000).optional(),
});

const RememberAnswer = z.object({
  questionId: z.coerce.number().int(),
  questionText: z.string().min(1).max(2000),
  targetSkill: z.string().min(1).max(200),
  rubric: z.string().max(2000).optional(),
  transcript: z.string().max(20000).default(""),
  language: z.string().max(40).optional(),
  score: z.coerce.number().min(0).max(100),
  feedback: z.string().max(4000).optional(),
  strengths: z.array(z.string().max(500)).max(20).optional(),
  improvements: z.array(z.string().max(500)).max(20).optional(),
  durationSec: z.coerce.number().min(0).max(3600).optional(),
});

export const RememberBody = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("resume"),
    candidateId: CandidateId,
    name: z.string().max(200).nullable().optional(),
    skills: z.array(MemorySkill).min(1).max(30),
    experience: z.array(z.object({ role: z.string().max(200), company: z.string().max(200), years: z.coerce.number().min(0).max(80) })).max(50).optional(),
    education: z.array(z.object({ degree: z.string().max(200), institution: z.string().max(200), year: z.coerce.number().int().nullable() })).max(50).optional(),
    projects: z.array(MemoryProject).max(30).optional(),
    rawText: z.string().max(50000).optional(),
  }),
  z.object({
    kind: z.literal("interview"),
    candidateId: CandidateId,
    name: z.string().max(200).nullable().optional(),
    company: z.string().max(120).nullable().optional(),
    answers: z.array(RememberAnswer).min(1).max(40),
  }),
]);

export const RecallBody = z.object({
  candidateId: CandidateId,
  company: z.string().max(120).nullable().optional(),
});

export const ForgetBody = z.object({
  candidateId: CandidateId,
  target: z.discriminatedUnion("type", [
    z.object({ type: z.literal("interview"), index: z.coerce.number().int().min(1) }),
    z.object({ type: z.literal("resume"), version: z.coerce.number().int().min(1) }),
    z.object({ type: z.literal("company"), name: z.string().min(1).max(120) }),
    z.object({ type: z.literal("project"), name: z.string().min(1).max(160) }),
    z.object({ type: z.literal("all") }),
  ]),
});

export const ReplayBody = z.object({
  candidateId: CandidateId,
  concept: z.string().min(1).max(200),
});

export const SeedBody = z.object({
  candidateId: CandidateId,
  name: z.string().max(200).optional(),
});

export { CandidateId };
