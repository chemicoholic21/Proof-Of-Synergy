import { z } from "zod";

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

/**
 * The client-provided graph is intentionally validated as `unknown` here, not with a strict
 * schema: the browser may hold a graph written by an older build, and a stale localStorage blob
 * must never 400 the whole request (which would block saving new progress). Structural
 * sanitization happens in `fromClient()` (lib/skill-graph.ts), which falls back to the server
 * store / an empty graph when the shape doesn't match - self-healing instead of failing.
 */
const ClientGraph = z.unknown().optional();

export const RememberSessionBody = z.object({
  learnerId: LearnerId,
  name: z.string().max(200).nullable().optional(),
  session: SessionResultSchema,
  graph: ClientGraph,
});

export const RecallSkillBody = z.object({
  learnerId: LearnerId,
  skillName: z.string().max(200).optional(),
  graph: ClientGraph,
});

export const SkillGraphBody = z.object({
  learnerId: LearnerId,
  graph: ClientGraph,
});

export const ForgetSkillBody = z.object({
  learnerId: LearnerId,
  target: z.discriminatedUnion("type", [
    z.object({ type: z.literal("skill"), name: z.string().min(1).max(160) }),
    z.object({ type: z.literal("session"), id: z.string().min(1).max(160) }),
    z.object({ type: z.literal("all") }),
  ]),
  graph: ClientGraph,
});

export const ReplaySkillBody = z.object({
  learnerId: LearnerId,
  skill: z.string().min(1).max(160),
  graph: ClientGraph,
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
