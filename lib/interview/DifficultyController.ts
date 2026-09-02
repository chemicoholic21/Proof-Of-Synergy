/**
 * Deterministic controller for adaptive interview difficulty: given one answer's
 * `EvidenceEvaluation` (./EvidenceEvaluator.ts) and the topic coverage/contradiction/strength
 * history already recorded in `MemoryEngine` (./MemoryEngine.ts), decides what the *next* question
 * should do — go harder, probe the same topic deeper, back off to reinforce fundamentals, clear up
 * a contradiction, or move on to a new topic.
 *
 * This is a rules engine, not another LLM call: the same `(evaluation, topic, memory-state)` input
 * always produces the same `DifficultyDecision`, which is exactly what makes an interview's
 * difficulty curve auditable and tunable (via `DifficultyControllerOptions`'s thresholds) instead
 * of an opaque, unrepeatable model judgment call. `ConversationEngine` (./ConversationEngine.ts)
 * still owns *phrasing* the next question — this class's job ends at deciding the strategy behind
 * it, handed to `ConversationEngine` as `systemPromptExtra` (e.g. "Ask a harder follow-up on the
 * same topic, since the candidate has now given two strong answers on it.").
 *
 * `decide()` is pure: it only *reads* from `MemoryEngine` (`getFactsForTopic()`) and never mutates
 * it, and it returns a *recommended* `difficultyDelta` rather than calling
 * `memory.adjustDifficulty()` itself — applying it (and recording the answer's own strengths/
 * weaknesses/skills as new durable facts) is the caller's job, the same separation of "decide" from
 * "mutate state" `ResponsePlanner` and `ContextBuilder` already keep.
 *
 * ## The five rules, in priority order
 *
 * 1. **Contradiction -> clarification.** If `MemoryEngine` already has a recorded contradiction on
 *    this topic, resolving it always comes first — pressing ahead with harder questions while a
 *    known inconsistency sits unaddressed would be a strange way to interview. This rule preempts
 *    every other one, regardless of how the current answer scored.
 * 2. **Weak fundamentals -> simpler follow-up.** A `technical_correctness` below
 *    `weakCorrectnessThreshold` means the answer got something fundamentally wrong — building on
 *    that with a harder question would compound the problem, so the next one should be easier.
 * 3. **Repeated strength -> move deeper.** A *strong* answer (see rule 4) on a topic that already
 *    has `repeatedStrengthCount - 1` or more recorded strengths gets a dedicated outcome instead of
 *    the plain "harder" one below: `DEEPEN_TOPIC` signals going further into the *same* topic
 *    specifically, rather than just raising the difficulty dial in the abstract.
 * 4. **Strong answer -> increase difficulty.** High `technical_correctness` *and*
 *    `technical_depth` (both at or above their thresholds) on a topic without that history yet.
 * 5. **Partial answer -> probe depth.** Correct enough (`technical_correctness` at or above the
 *    weak threshold) but shallow (`technical_depth` below `partialDepthThreshold`) — worth another
 *    pass on the same question/topic before moving on, at the same difficulty.
 *
 * Anything that clears the weak/partial bars without being strong (a solid, unremarkable answer)
 * falls through every rule above to `CHANGE_TOPIC` — there's nothing specific to correct for, so
 * the default is to keep the interview moving rather than lingering on a topic with nothing left to
 * probe.
 */

import type { EvidenceEvaluation } from "./EvidenceEvaluator";
import type { MemoryEngine } from "./MemoryEngine";

export const DIFFICULTY_DIRECTIVES = [
  "CLARIFY_CONTRADICTION",
  "SIMPLIFY",
  "DEEPEN_TOPIC",
  "INCREASE_DIFFICULTY",
  "PROBE_DEPTH",
  "CHANGE_TOPIC",
] as const;

export type DifficultyDirective = (typeof DIFFICULTY_DIRECTIVES)[number];

export interface DifficultyDecision {
  directive: DifficultyDirective;
  /** Human-readable explanation of why this directive was chosen, citing the actual scores/counts
   *  involved — for logging, debugging, or surfacing to a human reviewing the interview's flow. */
  reason: string;
  /** Recommended change to `MemoryEngine`'s difficulty level (positive = harder, negative =
   *  easier, 0 = unchanged). Applying it is the caller's job — see the module docstring. */
  difficultyDelta: number;
  /** Whether the next question should stay on the same topic. `false` only for `CHANGE_TOPIC`. */
  stayOnTopic: boolean;
}

export interface DifficultyControllerOptions {
  /** `technical_correctness` at or above this (out of 10) counts toward a "strong" answer. Default 8. */
  strongCorrectnessThreshold?: number;
  /** `technical_depth` at or above this (out of 10) counts toward a "strong" answer. Default 7. */
  strongDepthThreshold?: number;
  /** `technical_correctness` below this (out of 10) is "weak fundamentals." Default 5. */
  weakCorrectnessThreshold?: number;
  /** `technical_depth` below this (out of 10), on an otherwise-not-weak answer, is "partial."
   *  Default 6. */
  partialDepthThreshold?: number;
  /** How many strong answers on the same topic (including the current one) before "repeated
   *  strength" fires instead of the plain "strong answer" rule. Default 2. */
  repeatedStrengthCount?: number;
  /** Magnitude applied to `difficultyDelta` for a strengthen/weaken decision. Default 1. */
  difficultyStep?: number;
}

export interface DifficultyDecisionInput {
  evaluation: EvidenceEvaluation;
  /** The topic the just-evaluated answer was about — used to look up this topic's contradiction/
   *  strength history in `memory`. */
  topic: string;
  memory: MemoryEngine;
}

const DEFAULTS = {
  strongCorrectnessThreshold: 8,
  strongDepthThreshold: 7,
  weakCorrectnessThreshold: 5,
  partialDepthThreshold: 6,
  repeatedStrengthCount: 2,
  difficultyStep: 1,
} as const;

export class DifficultyController {
  private readonly strongCorrectnessThreshold: number;
  private readonly strongDepthThreshold: number;
  private readonly weakCorrectnessThreshold: number;
  private readonly partialDepthThreshold: number;
  private readonly repeatedStrengthCount: number;
  private readonly difficultyStep: number;

  constructor(opts: DifficultyControllerOptions = {}) {
    this.strongCorrectnessThreshold = opts.strongCorrectnessThreshold ?? DEFAULTS.strongCorrectnessThreshold;
    this.strongDepthThreshold = opts.strongDepthThreshold ?? DEFAULTS.strongDepthThreshold;
    this.weakCorrectnessThreshold = opts.weakCorrectnessThreshold ?? DEFAULTS.weakCorrectnessThreshold;
    this.partialDepthThreshold = opts.partialDepthThreshold ?? DEFAULTS.partialDepthThreshold;
    this.repeatedStrengthCount = opts.repeatedStrengthCount ?? DEFAULTS.repeatedStrengthCount;
    this.difficultyStep = opts.difficultyStep ?? DEFAULTS.difficultyStep;
  }

  /** Pure — only reads `input.memory`, never mutates it, and always returns the same decision for
   *  the same input. See the module docstring for the five rules, in priority order. */
  decide(input: DifficultyDecisionInput): DifficultyDecision {
    const { evaluation, topic, memory } = input;
    const facts = memory.getFactsForTopic(topic);

    if (facts.contradictions.length > 0) {
      const c = facts.contradictions[0];
      return {
        directive: "CLARIFY_CONTRADICTION",
        reason: `A contradiction on "${topic}" is still unresolved: earlier said "${c.earlierClaim}", later said "${c.laterStatement}". Address it before moving on.`,
        difficultyDelta: 0,
        stayOnTopic: true,
      };
    }

    const isWeak = evaluation.technical_correctness < this.weakCorrectnessThreshold;
    if (isWeak) {
      return {
        directive: "SIMPLIFY",
        reason: `Technical correctness (${evaluation.technical_correctness}/10) is below the weak-fundamentals threshold (${this.weakCorrectnessThreshold}) — reinforce fundamentals with a simpler follow-up rather than building on a shaky answer.`,
        difficultyDelta: -this.difficultyStep,
        stayOnTopic: true,
      };
    }

    const isStrong =
      evaluation.technical_correctness >= this.strongCorrectnessThreshold &&
      evaluation.technical_depth >= this.strongDepthThreshold;
    if (isStrong) {
      const priorStrengthsOnTopic = facts.strengths.length;
      if (priorStrengthsOnTopic + 1 >= this.repeatedStrengthCount) {
        return {
          directive: "DEEPEN_TOPIC",
          reason: `This is the ${ordinal(priorStrengthsOnTopic + 1)} strong answer recorded on "${topic}" (correctness ${evaluation.technical_correctness}/10, depth ${evaluation.technical_depth}/10) — go further into this topic specifically rather than just raising difficulty in the abstract.`,
          difficultyDelta: this.difficultyStep,
          stayOnTopic: true,
        };
      }
      return {
        directive: "INCREASE_DIFFICULTY",
        reason: `Strong answer (correctness ${evaluation.technical_correctness}/10, depth ${evaluation.technical_depth}/10, both at or above their thresholds) — raise the difficulty of the next question.`,
        difficultyDelta: this.difficultyStep,
        stayOnTopic: true,
      };
    }

    const isPartial = evaluation.technical_depth < this.partialDepthThreshold;
    if (isPartial) {
      return {
        directive: "PROBE_DEPTH",
        reason: `Correctness (${evaluation.technical_correctness}/10) is acceptable but depth (${evaluation.technical_depth}/10) is below the partial-answer threshold (${this.partialDepthThreshold}) — probe the same topic deeper before moving on.`,
        difficultyDelta: 0,
        stayOnTopic: true,
      };
    }

    return {
      directive: "CHANGE_TOPIC",
      reason: `Solid, unremarkable answer on "${topic}" (correctness ${evaluation.technical_correctness}/10, depth ${evaluation.technical_depth}/10) with no contradiction or repeated-strength signal — move on to another topic.`,
      difficultyDelta: 0,
      stayOnTopic: false,
    };
  }
}

function ordinal(n: number): string {
  const suffixes: Record<number, string> = { 1: "st", 2: "nd", 3: "rd" };
  const mod100 = n % 100;
  const suffix = mod100 >= 11 && mod100 <= 13 ? "th" : (suffixes[n % 10] ?? "th");
  return `${n}${suffix}`;
}
