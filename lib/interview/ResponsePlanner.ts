/**
 * Deterministic policy layer between `ConversationEngine`'s structured decision and everything
 * downstream that has to act on it (TTS, `VoiceSession`'s turn transitions, background scoring).
 *
 * `ConversationEngine.nextTurn()` already validates that a reply matches
 * `{ action, speech, topic, evaluation_required }` — but "the shape is valid" isn't the same as
 * "here is exactly what the voice pipeline should do about it." `ResponsePlanner` answers that:
 * given one `InterviewTurnResponse`, it deterministically decides —
 *
 *   - **whether to speak at all** (`shouldSpeak`) — a defensive check, not a trust of the model:
 *     an all-whitespace `speech` produces nothing to say, regardless of what `action` claims.
 *   - **how much text actually reaches TTS** (`ttsText`) — trimmed to a per-action word budget
 *     (see `DEFAULT_MAX_WORDS_BY_ACTION`) tuned to the interviewer system prompt's own "prefer 10
 *     to 40 words" / "do not give long lectures" rules (lib/interview/ConversationEngine.ts). That
 *     prompt rule and `ConversationEngine`'s own character-based `clampSpeech` safety net are both
 *     best-effort asks of the model; this is the deterministic enforcement layer that guarantees
 *     it regardless of what the model actually returned.
 *   - **whether the turn expects a user answer** (`expectsUserAnswer`) — purely a function of
 *     `action`: a question-asking action (`FOLLOW_UP`/`NEXT_QUESTION`/`CLARIFY`/`REPEAT`) does,
 *     `ACKNOWLEDGE`/`END_INTERVIEW` don't. A caller (e.g. `VoiceSession`) uses this to decide
 *     whether to reopen the mic after this turn's audio finishes.
 *   - **whether background evaluation is required** (`requiresEvaluation`) — mostly a pass-through
 *     of `evaluation_required`, but with a deterministic override: `REPEAT` and `END_INTERVIEW`
 *     never trigger evaluation, no matter what the model set that field to, since structurally
 *     neither turn is scoring a technical answer. This is the same "don't fully trust the model's
 *     own judgment call" posture `ConversationEngine` already applies to the response's shape,
 *     extended to one of its individual field's *values*.
 *
 * No LLM calls, no I/O, no mutable state — `plan()` is a pure function of its input, which is what
 * "deterministic" means here: the same `InterviewTurnResponse` always produces the same `ResponsePlan`.
 */

import type { InterviewAction, InterviewTurnResponse } from "./ConversationEngine";

export interface ResponsePlan {
  /** Carried through from the input for convenience — a consumer often wants this alongside the
   *  plan without re-reading the original `InterviewTurnResponse`. */
  action: InterviewAction;
  topic: string;
  /** Whether there is anything worth sending to TTS at all. */
  shouldSpeak: boolean;
  /** The text to actually send to TTS — `""` when `shouldSpeak` is `false`. Never longer than the
   *  configured per-action word budget (see `ResponsePlannerOptions.maxWordsByAction`). */
  ttsText: string;
  /** Whether, after this turn's audio finishes, the pipeline should reopen the mic and wait for a
   *  candidate response. `false` when there was nothing to say. */
  expectsUserAnswer: boolean;
  /** True only for `END_INTERVIEW` — a dedicated flag so a caller doesn't have to compare against
   *  `action` itself to detect the end of the session. */
  endsInterview: boolean;
  /** Whether background evaluation (e.g. `lib/coaching.ts`) should run for the candidate's answer
   *  that preceded this turn. */
  requiresEvaluation: boolean;
}

/** Actions whose speech itself poses a question or prompt the candidate is expected to answer. */
const ACTIONS_EXPECTING_ANSWER: ReadonlySet<InterviewAction> = new Set([
  "FOLLOW_UP",
  "NEXT_QUESTION",
  "CLARIFY",
  "REPEAT",
]);

/** Actions that structurally can never be evaluating a technical answer, regardless of what
 *  `evaluation_required` says. */
const ACTIONS_NEVER_REQUIRING_EVALUATION: ReadonlySet<InterviewAction> = new Set(["REPEAT", "END_INTERVIEW"]);

/**
 * Per-action word budgets for `ttsText`, tuned to the interviewer system prompt's "prefer 10 to 40
 * words" rule: `ACKNOWLEDGE` is a brief transition and gets less room than that; `REPEAT` restates
 * an existing question and gets the same room as asking one fresh; `END_INTERVIEW` is a closing
 * statement and gets a little more room to be warm without turning into a lecture.
 */
export const DEFAULT_MAX_WORDS_BY_ACTION: Readonly<Record<InterviewAction, number>> = {
  FOLLOW_UP: 40,
  NEXT_QUESTION: 40,
  CLARIFY: 40,
  ACKNOWLEDGE: 20,
  REPEAT: 40,
  END_INTERVIEW: 60,
};

export interface ResponsePlannerOptions {
  /** Overrides the default word budget for one or more actions; unspecified actions keep their
   *  `DEFAULT_MAX_WORDS_BY_ACTION` value. */
  maxWordsByAction?: Partial<Record<InterviewAction, number>>;
}

/**
 * Trim `text` to at most `maxWords` words. Prefers ending at the last sentence boundary within the
 * kept window (so a trim doesn't cut off mid-thought more than it has to); otherwise cuts cleanly
 * at a word boundary (never mid-word) and appends an ellipsis so a shortened reply doesn't read as
 * if it were the model's complete, intended sentence.
 */
export function clampWords(text: string, maxWords: number): string {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return text.trim();

  const truncated = words.slice(0, maxWords).join(" ");
  const lastSentenceEnd = Math.max(truncated.lastIndexOf(". "), truncated.lastIndexOf("? "), truncated.lastIndexOf("! "));
  if (lastSentenceEnd >= 0) return truncated.slice(0, lastSentenceEnd + 1).trim();
  return `${truncated}…`;
}

export class ResponsePlanner {
  private readonly maxWordsByAction: Record<InterviewAction, number>;

  constructor(opts: ResponsePlannerOptions = {}) {
    this.maxWordsByAction = { ...DEFAULT_MAX_WORDS_BY_ACTION, ...opts.maxWordsByAction };
  }

  /** Deterministically turn one `ConversationEngine` decision into a `ResponsePlan`. Pure — never
   *  throws, never performs I/O, and the same input always produces the same output. */
  plan(response: InterviewTurnResponse): ResponsePlan {
    const trimmedSpeech = response.speech.trim();
    const shouldSpeak = trimmedSpeech.length > 0;
    const ttsText = shouldSpeak ? clampWords(trimmedSpeech, this.maxWordsByAction[response.action]) : "";

    return {
      action: response.action,
      topic: response.topic,
      shouldSpeak,
      ttsText,
      expectsUserAnswer: shouldSpeak && ACTIONS_EXPECTING_ANSWER.has(response.action),
      endsInterview: response.action === "END_INTERVIEW",
      requiresEvaluation: response.evaluation_required && !ACTIONS_NEVER_REQUIRING_EVALUATION.has(response.action),
    };
  }
}
