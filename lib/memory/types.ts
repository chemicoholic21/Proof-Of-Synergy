/**
 * Canonical models exchanged with the memory layer. These are stable; the graph representation may
 * evolve underneath them.
 */

import { SkillLevel } from "@/lib/types";

export interface MemorySkill {
  name: string;
  category?: string;
  level: SkillLevel;
}

export interface MemoryPracticeSession {
  sessionId: string;
  scenarioId: string;
  learnerId: string;
  startedAt: string;
  endedAt?: string;
  messages: MemoryMessage[];
}

export interface MemoryMessage {
  id: string;
  role: "learner" | "coach" | "partner";
  content: string;
  timestamp: number;
}

/** What remember() needs to ingest a completed practice session. */
export interface RememberSessionInput {
  learnerId: string;
  scenarioId: string;
  startedAt: string;
  endedAt: string;
  messages: MemoryMessage[];
}

/** The Skill Reasoner's answer - everything a practice session or dashboard needs. */
export interface RecallResult {
  learnerId: string;
  isNew: boolean; // no session history yet
  weakSkills: RecalledSkill[]; // low confidence
  forgottenSkills: RecalledSkill[]; // decayed retention (spaced repetition due)
  practicedSkills: string[]; // skills that were practiced in recent sessions
  masteredSkills: string[]; // stop asking basics about these
  upcomingScenario: string | null;
  sessionCount: number;
  /** ready-made natural-language directives to steer scenario generation */
  focusDirectives: string[];
  /** optional Cognee semantic answer when a real backend is configured */
  cogneeInsight?: string | null;
}

export interface RecalledSkill {
  name: string;
  level: number; // 0-100
  retention: number; // 0-100 (100 = freshly reinforced)
  lastSeenDays: number;
  reason: string;
}