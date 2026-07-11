import { z } from "zod";
import { SkillLevel } from "@/lib/schemas";

/** Zod schemas for the memory API trust boundary. */

const LearnerId = z.string().min(1).max(80).regex(/^[a-zA-Z0-9_-]+$/, "learnerId must be url-safe");

const MemorySkill = z.object({
  name: z.string().min(1).max(120),
  category: z.string().max(120).optional(),
  level: SkillLevel.catch("intermediate"),
});

const MemoryMessage = z.object({
  id: z.string().min(1).max(100),
  role: z.enum(["learner", "coach", "partner"]),
  content: z.string().min(1).max(10000),
  timestamp: z.coerce.number(),
});

const MemoryPracticeSession = z.object({
  sessionId: z.string().min(1).max(100),
  scenarioId: z.string().min(1).max(100),
  learnerId: LearnerId,
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().optional(),
  messages: z.array(MemoryMessage).min(1),
});

const RememberSessionBody = z.object({
  learnerId: LearnerId,
  scenarioId: z.string().min(1).max(100),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime(),
  messages: z.array(MemoryMessage).min(1),
  graph: z.any().optional(),
});

const RecallBody = z.object({
  learnerId: LearnerId,
  scenarioId: z.string().max(100).nullable().optional(),
  graph: z.any().optional(),
});

const ForgetBody = z.object({
  learnerId: LearnerId,
  target: z.discriminatedUnion("type", [
    z.object({ type: z.literal("session"), index: z.coerce.number().int().min(1) }),
    z.object({ type: z.literal("all") }),
  ]),
  graph: z.any().optional(),
});

const ReplayBody = z.object({
  learnerId: LearnerId,
  skill: z.string().min(1).max(100),
  graph: z.any().optional(),
});

const SeedBody = z.object({
  learnerId: LearnerId,
  name: z.string().max(200).optional(),
});

export { RememberSessionBody, RecallBody, ForgetBody, ReplayBody, SeedBody, LearnerId };