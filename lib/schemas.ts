import { z } from "zod";

export const SkillLevel = z.enum(["beginner", "intermediate", "advanced", "expert"]);

export const SkillSchema = z.object({
  name: z.string().min(1).max(120),
  category: z.string().min(1).max(120),
  level: SkillLevel.catch("intermediate"),
});

export const ScenarioSchema = z.object({
  id: z.string().min(1).max(80),
  title: z.string().min(1).max(200),
  description: z.string().max(1000),
  difficulty: z.enum(["beginner", "intermediate", "advanced"]),
  tags: z.array(z.string().max(40)).max(20),
  systemPrompt: z.string().min(1).max(4000),
  openingMessage: z.string().min(1).max(1000),
});

export const CoachingEventSchema = z.object({
  type: z.enum(["filler", "hesitation", "ramble", "weak-structure", "confidence-drop", "repetition", "positive"]),
  text: z.string().max(500),
  timestamp: z.coerce.number(),
  suggestion: z.string().max(500).optional(),
});

export const ConversationMessageSchema = z.object({
  role: z.enum(["user", "assistant", "coach"]),
  content: z.string().min(1).max(10000),
  timestamp: z.coerce.number(),
  coachingNote: z.string().max(1000).optional(),
});

export const SessionResultSchema = z.object({
  scenarioId: z.string().min(1).max(80),
  durationSec: z.coerce.number().min(0),
  messages: z.array(ConversationMessageSchema).min(1),
  coachingEvents: z.array(CoachingEventSchema),
  metrics: z.object({
    wordCount: z.coerce.number(),
    fillerCount: z.coerce.number(),
    fillerRate: z.coerce.number(),
    hedgeCount: z.coerce.number(),
    vocabularyRichness: z.coerce.number(),
    avgSentenceLength: z.coerce.number(),
    confidenceMarkers: z.coerce.number(),
    confidence: z.coerce.number(),
    technicalDepth: z.coerce.number(),
    speechRateWpm: z.coerce.number().nullable(),
    topFillers: z.array(z.object({ word: z.string(), count: z.coerce.number() })).max(10),
  }),
  summary: z.string().max(4000),
});

export const TtsBody = z.object({
  text: z.string().min(1).max(2000),
  language: z.string().max(10).optional(),
});

export const GeminiChatBody = z.object({
  messages: z.array(ConversationMessageSchema).min(1).max(100),
  scenarioId: z.string().min(1).max(80),
  systemPrompt: z.string().max(4000).optional(),
});

export const GemmaCoachingBody = z.object({
  transcript: z.string().min(1).max(20000),
  recentMessages: z.array(ConversationMessageSchema).max(20).optional(),
  metrics: z.object({
    wordCount: z.coerce.number(),
    fillerCount: z.coerce.number(),
    hedgeCount: z.coerce.number(),
    confidence: z.coerce.number(),
  }).optional(),
});

// ---------------------------------------------------------------------------
// Skill graph (Proof of Synergy 2.0) schemas.
// ---------------------------------------------------------------------------

/** URL-safe learner identifier. The client persists it in localStorage. */
export const LearnerId = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-zA-Z0-9_-]+$/, "learnerId must be url-safe");

export const SkillGraphSkill = z.object({
  id: z.string(),
  name: z.string(),
  category: z.string().default("communication"),
  level: z.enum(["beginner", "intermediate", "advanced", "expert"]).catch("intermediate"),
  confidence: z.coerce.number().min(0).max(100),
  exposure: z.coerce.number().min(0),
  sessions: z.coerce.number().min(0),
  lastPracticedAt: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const SkillGraphSession = z.object({
  id: z.string(),
  scenarioId: z.string(),
  scenarioTitle: z.string(),
  completedAt: z.string(),
  durationSec: z.coerce.number().min(0),
  wordCount: z.coerce.number().min(0),
  confidence: z.coerce.number().min(0).max(100),
  fillerCount: z.coerce.number().min(0),
  coachingEvents: z.coerce.number().min(0),
  skills: z.array(z.string()),
  summary: z.string().default(""),
});

export const SkillGraph = z.object({
  learnerId: z.string(),
  name: z.string().nullable().optional(),
  skills: z.record(SkillGraphSkill),
  sessions: z.record(SkillGraphSession),
  createdAt: z.string(),
  updatedAt: z.string(),
  revision: z.coerce.number(),
});

export const RememberSessionBody = z.object({
  learnerId: LearnerId,
  name: z.string().max(200).nullable().optional(),
  session: SessionResultSchema,
  graph: SkillGraph.optional(),
});

export const RecallSkillBody = z.object({
  learnerId: LearnerId,
  skillName: z.string().max(200).optional(),
  graph: SkillGraph.optional(),
});

export const SkillGraphBody = z.object({
  learnerId: LearnerId,
  graph: SkillGraph.optional(),
});

export const ForgetSkillBody = z.object({
  learnerId: LearnerId,
  target: z.discriminatedUnion("type", [
    z.object({ type: z.literal("skill"), name: z.string().min(1).max(160) }),
    z.object({ type: z.literal("session"), id: z.string().min(1).max(160) }),
    z.object({ type: z.literal("all") }),
  ]),
  graph: SkillGraph.optional(),
});

export const ReplaySkillBody = z.object({
  learnerId: LearnerId,
  skill: z.string().min(1).max(160),
  graph: SkillGraph.optional(),
});

export const SeedSkillBody = z.object({
  learnerId: LearnerId,
  name: z.string().max(200).optional(),
});

export const CoachingSummaryBody = z.object({
  scenarioTitle: z.string().min(1).max(200),
  wordCount: z.coerce.number().min(0),
  confidence: z.coerce.number().min(0).max(100),
  fillerCount: z.coerce.number().min(0),
  coachingEvents: z
    .array(z.object({ type: z.string(), text: z.string() }))
    .max(50)
    .default([]),
});

export const MetricsBody = z.object({
  transcript: z.string().min(1).max(40000),
  durationSec: z.coerce.number().min(0).max(86400).optional(),
});
