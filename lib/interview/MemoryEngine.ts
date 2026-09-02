/**
 * Structured, durable-fact memory for one interview session — what `ConversationEngine`
 * (./ConversationEngine.ts) needs to know about the candidate *so far* in order to decide what to
 * do next, kept as a small set of typed records instead of the raw conversation transcript.
 *
 * ## Why not just replay the conversation history?
 *
 * `ConversationEngine.nextTurn()` already accepts a full `LLMMessage[]` history and deliberately
 * leaves "manage conversation history" to the caller (see its docstring). Threading the whole,
 * ever-growing transcript into every turn's prompt works for small talk, but it's the wrong memory
 * mechanism for the *decisions* an interviewer actually needs to make turn to turn: has this topic
 * already been covered? does the candidate's story contradict something they said ten minutes ago?
 * should the questions get harder? Answering those from raw history means re-deriving the same
 * facts, from scratch, out of a growing wall of text, on every single turn. `MemoryEngine` instead
 * stores exactly the durable facts those decisions depend on — strengths, weaknesses, demonstrated
 * vs. merely claimed skills, covered topics, open questions, contradictions, and the current
 * difficulty level — updated incrementally as the interview proceeds, and retrievable in a small,
 * bounded summary regardless of how long the interview has run.
 *
 * This is a deliberate constraint, not an implementation detail: nothing in this class accepts or
 * stores a raw utterance, a full LLM message, or "the conversation so far." Every `record*` method
 * takes an already-distilled fact — a skill name, a one-line strength/weakness description, a
 * topic label, a contradiction pair. Turning a candidate's raw sentence into one of those facts is
 * the caller's job (e.g. something built from `EvidenceEvaluator`'s output — its scores and cited
 * evidence quotes map naturally onto strengths/weaknesses/demonstrated skills, and its
 * `follow_up_opportunity` onto an unanswered question), the same way distilling history into a
 * prompt is `ConversationEngine`'s caller's job today. The short evidence quotes some facts carry
 * (e.g. `evidenceQuote` on a demonstrated skill) are supporting citations for *that* fact, not a
 * transcript — they exist so a summary can say *why* a fact is believed, not to reconstruct what
 * was said.
 *
 * ## Retrieval
 *
 * `getFactsForTopic()` / `getFactsForStage()` scope the stored facts down to what's relevant right
 * now; `buildContextSummary()` renders a compact, natural-language digest of either (or everything,
 * with neither) — meant to be handed straight to `ConversationEngine` as `systemPromptExtra`. No
 * persistence, no cross-session storage: like `TurnManager`, this is in-process working memory for
 * one interview. A caller wanting a durable, cross-session learner model already has
 * `lib/skill-graph.ts` for that — this class is not a replacement for it, and nothing here writes
 * to it.
 */

export type InterviewStage = "OPENING" | "CORE" | "CLOSING";

const STAGE_ORDER: readonly InterviewStage[] = ["OPENING", "CORE", "CLOSING"];

const MIN_DIFFICULTY = 1;
const MAX_DIFFICULTY = 10;
const DEFAULT_DIFFICULTY = 5;

export interface CandidateTrait {
  description: string;
  topic?: string;
  stage: InterviewStage;
  timestamp: number;
  /** Short supporting citation for *this* fact — not a transcript. See the module docstring. */
  evidenceQuote?: string;
}

export interface SkillRecord {
  skill: string;
  topic?: string;
  stage: InterviewStage;
  timestamp: number;
  /** Present only for a demonstrated skill — the citation that distinguishes it from a merely
   *  claimed one. */
  evidenceQuote?: string;
}

export interface CoveredTopic {
  topic: string;
  stage: InterviewStage;
  firstCoveredAt: number;
  lastCoveredAt: number;
  /** How many times this topic came back up after its first mention. */
  timesRevisited: number;
}

export interface UnansweredQuestion {
  question: string;
  topic?: string;
  stage: InterviewStage;
  timestamp: number;
  reason?: string;
}

export interface Contradiction {
  earlierClaim: string;
  laterStatement: string;
  topic?: string;
  stage: InterviewStage;
  timestamp: number;
  note?: string;
}

export interface DifficultyChange {
  level: number;
  stage: InterviewStage;
  timestamp: number;
  reason?: string;
}

export interface InterviewMemorySnapshot {
  stage: InterviewStage;
  difficultyLevel: number;
  difficultyHistory: DifficultyChange[];
  strengths: CandidateTrait[];
  weaknesses: CandidateTrait[];
  demonstratedSkills: SkillRecord[];
  claimedSkills: SkillRecord[];
  coveredTopics: CoveredTopic[];
  unansweredQuestions: UnansweredQuestion[];
  contradictions: Contradiction[];
}

/** Facts scoped to one topic, plus whether the topic itself has been covered at all. */
export interface TopicMemory {
  topic: string;
  covered: boolean;
  coveredInfo?: CoveredTopic;
  strengths: CandidateTrait[];
  weaknesses: CandidateTrait[];
  demonstratedSkills: SkillRecord[];
  claimedSkills: SkillRecord[];
  unansweredQuestions: UnansweredQuestion[];
  contradictions: Contradiction[];
}

/** Facts recorded while the interview was in one particular stage. */
export interface StageMemory {
  stage: InterviewStage;
  strengths: CandidateTrait[];
  weaknesses: CandidateTrait[];
  demonstratedSkills: SkillRecord[];
  claimedSkills: SkillRecord[];
  coveredTopics: CoveredTopic[];
  unansweredQuestions: UnansweredQuestion[];
  contradictions: Contradiction[];
}

export interface MemoryEngineOptions {
  /** Default `"OPENING"`. */
  initialStage?: InterviewStage;
  /** Default 5 (of 1-10). */
  initialDifficulty?: number;
}

function normalizeTopic(topic: string): string {
  return topic.trim().toLowerCase();
}

function clampDifficulty(level: number): number {
  return Math.min(MAX_DIFFICULTY, Math.max(MIN_DIFFICULTY, Math.round(level)));
}

function formatList(label: string, items: string[]): string | null {
  if (items.length === 0) return null;
  return `${label}: ${items.join("; ")}.`;
}

export class MemoryEngine {
  private currentStage: InterviewStage;
  private difficultyLevel: number;
  private readonly difficultyHistory: DifficultyChange[] = [];

  private readonly strengths: CandidateTrait[] = [];
  private readonly weaknesses: CandidateTrait[] = [];
  private readonly demonstratedSkills: SkillRecord[] = [];
  private readonly claimedSkills: SkillRecord[] = [];
  private readonly coveredTopics = new Map<string, CoveredTopic>();
  private readonly unansweredQuestions: UnansweredQuestion[] = [];
  private readonly contradictions: Contradiction[] = [];

  constructor(opts: MemoryEngineOptions = {}) {
    this.currentStage = opts.initialStage ?? "OPENING";
    this.difficultyLevel = clampDifficulty(opts.initialDifficulty ?? DEFAULT_DIFFICULTY);
  }

  // -- Interview stage --------------------------------------------------------------------------

  get stage(): InterviewStage {
    return this.currentStage;
  }

  /** True if `to` is a forward (or same) move in `OPENING -> CORE -> CLOSING` — the interview
   *  never moves backward through its own stages. */
  canAdvanceTo(to: InterviewStage): boolean {
    return STAGE_ORDER.indexOf(to) >= STAGE_ORDER.indexOf(this.currentStage);
  }

  /** Advance to `stage`. Throws if `stage` would move the interview backward. */
  advanceStage(stage: InterviewStage): void {
    if (!this.canAdvanceTo(stage)) {
      throw new Error(`MemoryEngine: cannot move from stage ${this.currentStage} back to ${stage}.`);
    }
    this.currentStage = stage;
  }

  /** Same as `advanceStage()`, but returns `false` instead of throwing on a backward move. */
  tryAdvanceStage(stage: InterviewStage): boolean {
    if (!this.canAdvanceTo(stage)) return false;
    this.currentStage = stage;
    return true;
  }

  // -- Difficulty level ---------------------------------------------------------------------------

  getDifficulty(): number {
    return this.difficultyLevel;
  }

  /** Set the difficulty level directly, clamped to 1-10. Returns the (clamped) level actually set. */
  setDifficulty(level: number, reason?: string): number {
    this.difficultyLevel = clampDifficulty(level);
    this.difficultyHistory.push({ level: this.difficultyLevel, stage: this.currentStage, timestamp: Date.now(), reason });
    return this.difficultyLevel;
  }

  /** Adjust the difficulty level by `delta` (positive = harder), clamped to 1-10. Returns the new level. */
  adjustDifficulty(delta: number, reason?: string): number {
    return this.setDifficulty(this.difficultyLevel + delta, reason);
  }

  // -- Recording durable facts ---------------------------------------------------------------------

  recordStrength(input: { description: string; topic?: string; evidenceQuote?: string }): void {
    this.strengths.push({ ...input, stage: this.currentStage, timestamp: Date.now() });
  }

  recordWeakness(input: { description: string; topic?: string; evidenceQuote?: string }): void {
    this.weaknesses.push({ ...input, stage: this.currentStage, timestamp: Date.now() });
  }

  /** A skill the candidate actually showed evidence of, not just mentioned. */
  recordDemonstratedSkill(input: { skill: string; topic?: string; evidenceQuote?: string }): void {
    this.demonstratedSkills.push({ ...input, stage: this.currentStage, timestamp: Date.now() });
  }

  /** A skill the candidate merely mentioned/asserted, with no supporting evidence (yet). */
  recordClaimedSkill(input: { skill: string; topic?: string }): void {
    this.claimedSkills.push({ ...input, stage: this.currentStage, timestamp: Date.now() });
  }

  /** Mark `topic` as covered. Calling this again for the same topic (normalized: trimmed,
   *  case-insensitive) records a revisit rather than a duplicate entry. */
  recordCoveredTopic(topic: string): CoveredTopic {
    const key = normalizeTopic(topic);
    const now = Date.now();
    const existing = this.coveredTopics.get(key);
    if (existing) {
      existing.lastCoveredAt = now;
      existing.timesRevisited += 1;
      return existing;
    }
    const record: CoveredTopic = { topic, stage: this.currentStage, firstCoveredAt: now, lastCoveredAt: now, timesRevisited: 0 };
    this.coveredTopics.set(key, record);
    return record;
  }

  isTopicCovered(topic: string): boolean {
    return this.coveredTopics.has(normalizeTopic(topic));
  }

  recordUnansweredQuestion(input: { question: string; topic?: string; reason?: string }): void {
    this.unansweredQuestions.push({ ...input, stage: this.currentStage, timestamp: Date.now() });
  }

  /** Remove the first unanswered question matching `question` (normalized: trimmed,
   *  case-insensitive exact match), e.g. once the candidate eventually addresses it. Returns
   *  whether a matching question was found and removed. */
  resolveUnansweredQuestion(question: string): boolean {
    const key = normalizeTopic(question);
    const index = this.unansweredQuestions.findIndex((q) => normalizeTopic(q.question) === key);
    if (index === -1) return false;
    this.unansweredQuestions.splice(index, 1);
    return true;
  }

  hasUnansweredQuestions(topic?: string): boolean {
    if (topic === undefined) return this.unansweredQuestions.length > 0;
    const key = normalizeTopic(topic);
    return this.unansweredQuestions.some((q) => q.topic !== undefined && normalizeTopic(q.topic) === key);
  }

  recordContradiction(input: { earlierClaim: string; laterStatement: string; topic?: string; note?: string }): void {
    this.contradictions.push({ ...input, stage: this.currentStage, timestamp: Date.now() });
  }

  // -- Retrieval ------------------------------------------------------------------------------------

  /** A deep-cloned snapshot of everything stored — safe for a caller to hold onto or serialize
   *  without risk of it changing underneath them. */
  getSnapshot(): InterviewMemorySnapshot {
    return structuredClone({
      stage: this.currentStage,
      difficultyLevel: this.difficultyLevel,
      difficultyHistory: this.difficultyHistory,
      strengths: this.strengths,
      weaknesses: this.weaknesses,
      demonstratedSkills: this.demonstratedSkills,
      claimedSkills: this.claimedSkills,
      coveredTopics: [...this.coveredTopics.values()],
      unansweredQuestions: this.unansweredQuestions,
      contradictions: this.contradictions,
    });
  }

  /** Every stored fact whose `topic` matches `topic` (normalized: trimmed, case-insensitive),
   *  plus whether `topic` itself has been marked covered. */
  getFactsForTopic(topic: string): TopicMemory {
    const key = normalizeTopic(topic);
    const matches = (t?: string) => t !== undefined && normalizeTopic(t) === key;
    return structuredClone({
      topic,
      covered: this.coveredTopics.has(key),
      coveredInfo: this.coveredTopics.get(key),
      strengths: this.strengths.filter((f) => matches(f.topic)),
      weaknesses: this.weaknesses.filter((f) => matches(f.topic)),
      demonstratedSkills: this.demonstratedSkills.filter((f) => matches(f.topic)),
      claimedSkills: this.claimedSkills.filter((f) => matches(f.topic)),
      unansweredQuestions: this.unansweredQuestions.filter((f) => matches(f.topic)),
      contradictions: this.contradictions.filter((f) => matches(f.topic)),
    });
  }

  /** Every stored fact that was recorded while the interview was in `stage`. */
  getFactsForStage(stage: InterviewStage): StageMemory {
    return structuredClone({
      stage,
      strengths: this.strengths.filter((f) => f.stage === stage),
      weaknesses: this.weaknesses.filter((f) => f.stage === stage),
      demonstratedSkills: this.demonstratedSkills.filter((f) => f.stage === stage),
      claimedSkills: this.claimedSkills.filter((f) => f.stage === stage),
      coveredTopics: [...this.coveredTopics.values()].filter((f) => f.stage === stage),
      unansweredQuestions: this.unansweredQuestions.filter((f) => f.stage === stage),
      contradictions: this.contradictions.filter((f) => f.stage === stage),
    });
  }

  /**
   * A compact, natural-language digest of the stored facts — meant to be handed to
   * `ConversationEngine` as `systemPromptExtra` so it can make an informed next-turn decision
   * without ever seeing the raw conversation history. Scoped to `opts.topic` and/or `opts.stage`
   * when given; otherwise summarizes everything stored so far. Sections with nothing to say are
   * omitted rather than printed empty.
   */
  buildContextSummary(opts: { topic?: string; stage?: InterviewStage } = {}): string {
    const topicView = opts.topic !== undefined ? this.getFactsForTopic(opts.topic) : undefined;
    const stageView = opts.stage !== undefined ? this.getFactsForStage(opts.stage) : undefined;

    const strengths = topicView?.strengths ?? stageView?.strengths ?? this.strengths;
    const weaknesses = topicView?.weaknesses ?? stageView?.weaknesses ?? this.weaknesses;
    const demonstrated = topicView?.demonstratedSkills ?? stageView?.demonstratedSkills ?? this.demonstratedSkills;
    const claimed = topicView?.claimedSkills ?? stageView?.claimedSkills ?? this.claimedSkills;
    const unanswered = topicView?.unansweredQuestions ?? stageView?.unansweredQuestions ?? this.unansweredQuestions;
    const contradictions = topicView?.contradictions ?? stageView?.contradictions ?? this.contradictions;
    const coveredTopics = stageView?.coveredTopics ?? (opts.topic === undefined ? [...this.coveredTopics.values()] : []);

    const lines = [
      `Interview stage: ${opts.stage ?? this.currentStage}. Current difficulty: ${this.difficultyLevel}/${MAX_DIFFICULTY}.`,
      opts.topic !== undefined
        ? `Topic "${opts.topic}" ${topicView?.covered ? "has" : "has not"} already been covered.`
        : formatList("Topics already covered", coveredTopics.map((t) => t.topic)),
      formatList("Demonstrated skills (with evidence)", demonstrated.map((s) => s.skill)),
      formatList("Claimed but not yet demonstrated", claimed.map((s) => s.skill)),
      formatList("Known strengths", strengths.map((s) => s.description)),
      formatList("Known weaknesses", weaknesses.map((w) => w.description)),
      formatList("Open follow-ups", unanswered.map((q) => q.question)),
      formatList(
        "Contradictions to probe",
        contradictions.map((c) => `earlier said "${c.earlierClaim}", later said "${c.laterStatement}"`)
      ),
    ].filter((line): line is string => Boolean(line));

    return lines.join(" ");
  }
}
