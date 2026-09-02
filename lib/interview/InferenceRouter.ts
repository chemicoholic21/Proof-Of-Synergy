/**
 * Cost-control triage: decides, deterministically and before any LLM is ever touched, how much
 * inference one candidate turn actually needs. This is the front door everything else in
 * `lib/interview/` sits behind — `ConversationEngine` (an LLM call), `EvidenceEvaluator` (a second,
 * more expensive LLM call), and `ContextBuilder`'s context window are each worth their cost only
 * for a turn that actually needs them. Most of the answer to "does this turn need an LLM at all?"
 * is knowable from the transcript text alone, with a plain classifier — no model call required to
 * find out whether a model call is warranted.
 *
 * For every turn, `route()` answers four questions:
 *
 *   1. **Does this need an LLM?** (`needsLLM`) — false for a repeat request, a bare
 *      acknowledgment, "I don't know," or a control phrase like "let's move on" / "end the
 *      interview." True for anything with actual technical content to respond to.
 *   2. **Does this need deep evaluation?** (`needsDeepEvaluation`) — true *only* for a substantive
 *      candidate answer. `EvidenceEvaluator`'s evidence-grounded scoring is the single most
 *      expensive step in this whole pipeline (two LLM calls in the worst case, per
 *      ./EvidenceEvaluator.ts); running it against "okay" or "can you repeat that?" would be pure
 *      waste, so every other category skips it outright.
 *   3. **Can this be deterministic?** (`isDeterministic`) — the complement of `needsLLM`, named
 *      explicitly because it's paired with an actual usable answer: when true,
 *      `deterministicResponse` is a ready-made, `ConversationEngine`-shaped
 *      `{ action, speech, topic, evaluation_required }` a caller can act on directly, in place of
 *      calling `ConversationEngine.nextTurn()` at all.
 *   4. **Can context be reduced?** (`reducedContext`) — true whenever the full context this turn
 *      would otherwise pull together (recent turns, topic memory, resume facts — see
 *      `ContextBuilder`, ./ContextBuilder.ts) is overkill for what's actually being responded to.
 *      `contextBudget` gives a caller a smaller `ContextBuilderOptions`-shaped override to use
 *      instead of the default window.
 *
 * ## Classification
 *
 * Every rule below is a plain string/word-count check — deterministic and free to run on every
 * turn, the same "don't spend an LLM call deciding whether to spend an LLM call" posture
 * `ResponsePlanner` and `DifficultyController` already take for their own decisions:
 *
 *   - **Empty/noise**: nothing said, or only filler sounds.
 *   - **Repeat request**: "can you repeat that?", "what was the question?", etc.
 *   - **End request**: "let's end here", "I'm done", "wrap it up."
 *   - **Skip request**: "let's move on", "next question", "can we skip this."
 *   - **Don't-know**: the *entire* utterance is "I don't know" / "not sure" / equivalent — anchored
 *     to the whole trimmed answer specifically so a genuinely substantive answer that merely
 *     *mentions* uncertainty ("I'm not sure if this is optimal, but here's my approach...") is
 *     never misclassified — it still has real content to respond to.
 *   - **Acknowledgment**: the entire utterance is a bare "okay"/"yes"/"got it"/etc., again anchored
 *     to the whole answer for the same reason.
 *   - **Short answer**: has some real content, but under `shortAnswerWordThreshold` words — still
 *     routed through the LLM (there's something to say back), just without deep evaluation or the
 *     full context window.
 *   - **Substantive answer**: everything else — the only category that gets the full pipeline.
 *
 * `route()` is pure and synchronous: no I/O, no LLM calls, no side effects.
 */

import type { InterviewAction } from "./ConversationEngine";

export const INPUT_CATEGORIES = [
  "EMPTY_OR_NOISE",
  "REPEAT_REQUEST",
  "END_REQUEST",
  "SKIP_REQUEST",
  "DONT_KNOW",
  "ACKNOWLEDGMENT",
  "SHORT_ANSWER",
  "SUBSTANTIVE_ANSWER",
] as const;

export type InputCategory = (typeof INPUT_CATEGORIES)[number];

/** `ConversationEngine.nextTurn()`-shaped response a caller can use directly, skipping the LLM
 *  call entirely, when `RoutingDecision.isDeterministic` is `true`. */
export interface DeterministicResponse {
  action: InterviewAction;
  speech: string;
  topic: string;
  evaluation_required: false;
}

export interface ContextBudget {
  maxRecentMessages: number;
  maxRecentChars: number;
}

export interface RoutingDecision {
  category: InputCategory;
  needsLLM: boolean;
  needsDeepEvaluation: boolean;
  isDeterministic: boolean;
  reducedContext: boolean;
  reason: string;
  /** Present only when `isDeterministic` is `true`. */
  deterministicResponse?: DeterministicResponse;
  /** Present only when `reducedContext` is `true` — a smaller window than `ContextBuilder`'s own
   *  defaults, suitable for a turn that needs the LLM but not its full context. */
  contextBudget?: ContextBudget;
}

export interface InferenceRoutingInput {
  /** The candidate's latest answer text. */
  transcript: string;
  /** Current topic, for tagging a deterministic response the same way `ConversationEngine`'s own
   *  replies are tagged. Defaults to `"general"`. */
  topic?: string;
  /** The question just asked, if any — used to phrase a repeat request's canned speech. */
  lastQuestion?: string;
}

export interface InferenceRouterOptions {
  /** Below this word count (and not matching a more specific deterministic pattern), an answer
   *  with real content is still "short" rather than "substantive." Default 12. */
  shortAnswerWordThreshold?: number;
  /** At or below this word count, a control-phrase pattern (repeat/end/skip) is still considered a
   *  match — keeps a long substantive answer that happens to contain one of those words from being
   *  misclassified. Default 20. */
  controlPhraseMaxWords?: number;
  /** The `contextBudget` handed back whenever `reducedContext` is `true`. Default
   *  `{ maxRecentMessages: 2, maxRecentChars: 400 }` — a small fraction of `ContextBuilder`'s own
   *  defaults (8 messages / 2000 chars). */
  reducedContextBudget?: ContextBudget;
}

const DEFAULT_SHORT_ANSWER_WORD_THRESHOLD = 12;
const DEFAULT_CONTROL_PHRASE_MAX_WORDS = 20;
const DEFAULT_REDUCED_CONTEXT_BUDGET: ContextBudget = { maxRecentMessages: 2, maxRecentChars: 400 };

const ACKNOWLEDGMENT_PHRASES = new Set([
  "ok",
  "okay",
  "yes",
  "yeah",
  "yep",
  "yup",
  "sure",
  "got it",
  "gotcha",
  "alright",
  "all right",
  "understood",
  "right",
  "cool",
  "thanks",
  "thank you",
  "noted",
  "makes sense",
  "sounds good",
]);

const DONT_KNOW_RE =
  /^(i\s+)?(don'?t know|dont know|dunno|not sure|no idea|no clue|i'?m not sure|i have no idea|i can'?t answer that|pass)$/i;

const REPEAT_RE =
  /\b(repeat (that|it|the question)|say (that|it) again|come again|what was the question|didn'?t (hear|catch) (that|you)|could you repeat|one more time)\b/i;

const END_RE = /\b(end the interview|end this interview|i'?m done|let'?s (end|stop|wrap)( it)?( up)?|wrap it up|that'?s all( from me)?|i'?d like to (stop|end))\b/i;

const SKIP_RE = /\b(next question|move on|let'?s (move on|continue|skip)|can we skip|skip this( one| question)?|different question)\b/i;

function words(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean);
}

function normalizeForExactMatch(text: string): string {
  return text.trim().toLowerCase().replace(/[.!?,]+$/g, "").trim();
}

function classify(transcript: string, maxControlWords: number, shortAnswerWordThreshold: number): InputCategory {
  const trimmed = transcript.trim();
  const wordCount = words(trimmed).length;

  if (wordCount === 0) return "EMPTY_OR_NOISE";

  const normalized = normalizeForExactMatch(trimmed);
  if (DONT_KNOW_RE.test(normalized)) return "DONT_KNOW";
  if (ACKNOWLEDGMENT_PHRASES.has(normalized)) return "ACKNOWLEDGMENT";

  if (wordCount <= maxControlWords) {
    if (END_RE.test(trimmed)) return "END_REQUEST";
    if (REPEAT_RE.test(trimmed)) return "REPEAT_REQUEST";
    if (SKIP_RE.test(trimmed)) return "SKIP_REQUEST";
  }

  return wordCount < shortAnswerWordThreshold ? "SHORT_ANSWER" : "SUBSTANTIVE_ANSWER";
}

export class InferenceRouter {
  private readonly shortAnswerWordThreshold: number;
  private readonly controlPhraseMaxWords: number;
  private readonly reducedContextBudget: ContextBudget;

  constructor(opts: InferenceRouterOptions = {}) {
    this.shortAnswerWordThreshold = opts.shortAnswerWordThreshold ?? DEFAULT_SHORT_ANSWER_WORD_THRESHOLD;
    this.controlPhraseMaxWords = opts.controlPhraseMaxWords ?? DEFAULT_CONTROL_PHRASE_MAX_WORDS;
    this.reducedContextBudget = opts.reducedContextBudget ?? DEFAULT_REDUCED_CONTEXT_BUDGET;
  }

  /** Pure and synchronous — see the module docstring. */
  route(input: InferenceRoutingInput): RoutingDecision {
    const topic = input.topic ?? "general";
    const category = classify(input.transcript, this.controlPhraseMaxWords, this.shortAnswerWordThreshold);

    switch (category) {
      case "EMPTY_OR_NOISE":
        return this.deterministic(category, topic, {
          action: "REPEAT",
          speech: "Sorry, I didn't catch that — could you say that again?",
          reason: "No usable content in the transcript — nothing here for an LLM to reason about.",
        });

      case "REPEAT_REQUEST":
        return this.deterministic(category, topic, {
          action: "REPEAT",
          speech: input.lastQuestion ? `Sure — ${input.lastQuestion}` : "Sure — let me say that again.",
          reason: "The candidate explicitly asked for the question to be repeated — a scripted repeat, not a new model decision.",
        });

      case "END_REQUEST":
        return this.deterministic(category, topic, {
          action: "END_INTERVIEW",
          speech: "Understood — let's wrap up here. Thanks for your time today.",
          reason: "The candidate explicitly asked to end the interview.",
        });

      case "SKIP_REQUEST":
        return this.deterministic(category, topic, {
          action: "NEXT_QUESTION",
          speech: "No problem, let's move to a different question.",
          reason: "The candidate explicitly asked to move on — no reasoning needed about whether to.",
        });

      case "DONT_KNOW":
        return this.deterministic(category, topic, {
          action: "NEXT_QUESTION",
          speech: "That's alright — let's move to a different question.",
          reason: "The candidate's entire answer was a plain \"I don't know\" (or equivalent) — nothing substantive to evaluate or respond to.",
        });

      case "ACKNOWLEDGMENT":
        return this.deterministic(category, topic, {
          action: "ACKNOWLEDGE",
          speech: "Got it.",
          reason: "The entire utterance was a bare acknowledgment with no technical content.",
        });

      case "SHORT_ANSWER":
        return {
          category,
          needsLLM: true,
          needsDeepEvaluation: false,
          isDeterministic: false,
          reducedContext: true,
          reason: "Short answer with some real content — still needs the LLM to respond, but too brief to warrant deep evaluation or the full context window.",
          contextBudget: this.reducedContextBudget,
        };

      case "SUBSTANTIVE_ANSWER":
        return {
          category,
          needsLLM: true,
          needsDeepEvaluation: true,
          isDeterministic: false,
          reducedContext: false,
          reason: "Substantive candidate answer — full pipeline: LLM response, deep evidence-based evaluation, and full context.",
        };
    }
  }

  private deterministic(
    category: InputCategory,
    topic: string,
    opts: { action: InterviewAction; speech: string; reason: string }
  ): RoutingDecision {
    return {
      category,
      needsLLM: false,
      needsDeepEvaluation: false,
      isDeterministic: true,
      reducedContext: true,
      reason: opts.reason,
      deterministicResponse: { action: opts.action, speech: opts.speech, topic, evaluation_required: false },
      contextBudget: this.reducedContextBudget,
    };
  }
}
