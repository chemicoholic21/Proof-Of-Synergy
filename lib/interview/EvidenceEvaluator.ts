/**
 * Evidence-based technical evaluation of one candidate answer — structured, grounded scoring
 * rather than a free-form written summary. This is a different kind of evaluation than
 * `EvaluationWorker.defaultEvaluate()` (./EvaluationWorker.ts), which produces a warm, holistic
 * communication summary (`{ summary, metrics, coachingEvents }`) via heuristics plus an LLM. This
 * class produces a scored, evidence-cited technical assessment instead:
 *
 *   {
 *     "technical_correctness": 8,
 *     "technical_depth": 7,
 *     "communication": 9,
 *     "evidence": [
 *       { "quote": "I used Redis for caching", "assessment": "demonstrates relevant experience" }
 *     ],
 *     "follow_up_opportunity": "Ask about cache invalidation"
 *   }
 *
 * The two are meant to compose, not compete: a future `EvaluationWorker`'s `evaluate()` could call
 * both and store both results on one `EvaluationJob`. Nothing here is wired into
 * `EvaluationQueue`/`EvaluationWorker` yet — this class is independent and self-contained, exactly
 * like `ConversationEngine`, whose structured-output pattern (JSON-only system prompt,
 * `extractValidatedJson` + a zod schema, one corrective retry) this class deliberately mirrors.
 *
 * ## Model choice
 *
 * Unlike `ConversationEngine` (`sarvam-105b-conversations`, tuned for natural real-time dialogue),
 * this class uses `SarvamLLM`'s own default model (`sarvam-105b` / `SARVAM_CHAT_MODEL`) — scoring
 * and evidence extraction benefit from careful reasoning, not conversational fluency, so there's
 * no reason to pay for (or tune toward) the conversational variant here.
 *
 * ## "Do not invent information the candidate did not provide"
 *
 * The evaluation prompt asks the model not to fabricate evidence, but this class does not just
 * trust that instruction — every `evidence[].quote` is checked against the candidate's actual
 * answer text (normalized: case/whitespace/quote-mark insensitive substring match) after parsing.
 * A quote that doesn't actually appear in the answer is dropped rather than passed through, and if
 * *every* quote in a response turns out to be fabricated this way, the whole response is treated
 * as invalid and retried — the same deterministic "don't fully trust the model" posture
 * `ResponsePlanner` already applies to `evaluation_required` and `ConversationEngine` applies to
 * response length.
 *
 * ## Failure handling: throw, never fabricate a score
 *
 * If a valid, evidence-grounded evaluation still can't be obtained after one corrective retry,
 * this class throws rather than returning a placeholder score (e.g. all zeros) — unlike
 * `ConversationEngine`'s `ACKNOWLEDGE` fallback, which is safe because it's just a conversational
 * transition with no scoring stakes, a fabricated *evaluation* would be actively misleading: it
 * could unfairly flatter or penalize a candidate's record. This mirrors `sarvamTranscribe`'s own
 * "never fabricate a learner's answer in production" stance (lib/sarvam.ts), extended to a
 * learner's *assessment*. A thrown error here composes naturally with `EvaluationQueue`'s own
 * retry/backoff (./EvaluationQueue.ts): if this class is used as (or from) an `EvaluateFn`, the
 * queue schedules a later attempt instead of ever persisting a made-up score.
 */

import { z } from "zod";
import { SarvamLLM } from "../providers/llm/SarvamLLM";
import type { LLMMessage, LLMProvider } from "../providers/llm/types";
import { extractValidatedJson } from "../sarvam";
import { logger } from "../logger";

const log = logger.child({ module: "evidence-evaluator" });

const DEFAULT_TEMPERATURE = 0.2; // scoring benefits from determinism far more than conversational variety
const DEFAULT_MAX_TOKENS = 500;

const EvidenceItemSchema = z.object({
  quote: z.string().trim().min(1, "quote must not be empty"),
  assessment: z.string().trim().min(1, "assessment must not be empty"),
});

const EvidenceEvaluationSchema = z.object({
  technical_correctness: z.number().min(0).max(10),
  technical_depth: z.number().min(0).max(10),
  communication: z.number().min(0).max(10),
  evidence: z.array(EvidenceItemSchema),
  follow_up_opportunity: z.string().trim().min(1, "follow_up_opportunity must not be empty"),
});

export type EvidenceItem = z.infer<typeof EvidenceItemSchema>;
export type EvidenceEvaluation = z.infer<typeof EvidenceEvaluationSchema>;

export interface EvidenceEvaluatorInput {
  /** The candidate's answer text — the only thing evidence is ever drawn from. */
  answer: string;
  /** The question actually asked, for judging relevance/correctness against. Strongly recommended:
   *  omitting it means the model evaluates the answer on its own merits with no reference point. */
  question?: string;
  /** Optional short topic label (e.g. `InterviewTurnResponse.topic`, ./ConversationEngine.ts). */
  topic?: string;
}

export interface EvidenceEvaluatorOptions {
  /** Defaults to a `SarvamLLM` with its own default model — see the module docstring on why this
   *  intentionally differs from `ConversationEngine`'s model choice. */
  llm?: LLMProvider;
  /** Extra evaluator context (e.g. a rubric, seniority level) appended after the built-in
   *  persona/rules and before the structured-output contract, which is never overridable. */
  systemPromptExtra?: string;
  temperature?: number;
  maxTokens?: number;
}

// Kept verbatim, as given — see the module docstring on why persona/rules and the structured-
// output contract are split the same way ConversationEngine.ts splits its own two prompt blocks.
const EVALUATOR_PERSONA_PROMPT = `You are an evidence-based technical interview evaluator.

Evaluate only the candidate's demonstrated answer.

Do not reward confidence without evidence.

For every score:

1. Identify evidence from the answer.
2. Identify missing evidence.
3. Separate factual correctness from communication quality.
4. Identify claims requiring follow-up.
5. Return structured JSON only.

Do not invent information the candidate did not provide.`;

const STRUCTURED_OUTPUT_PROMPT = `Score the candidate's answer on three independent 0-10 scales:
- "technical_correctness": is what they said factually/technically accurate?
- "technical_depth": how deep, specific, and detailed is the answer, versus surface-level or buzzword-only?
- "communication": how clearly and effectively did they explain it — independent of whether it was correct?

For "evidence": quote short, verbatim (or near-verbatim) fragments directly from the candidate's
answer only — never from the question, and never anything the candidate did not actually say. Pair
each quote with a one-sentence assessment of what it demonstrates. A quote that cannot be found in
the answer will be discarded, so only quote things actually present in the answer text.

For "follow_up_opportunity": name ONE specific claim or gap in the answer worth probing further —
never a generic remark like "ask more questions."

Respond with ONLY a single JSON object, exactly this shape, and nothing else — no code fences, no commentary before or after it:
{"technical_correctness": number, "technical_depth": number, "communication": number, "evidence": [{"quote": string, "assessment": string}], "follow_up_opportunity": string}`;

const RETRY_NUDGE: LLMMessage = {
  role: "user",
  content:
    "Your previous response was not a valid JSON object matching the required shape, or every quote in it was not actually present in the candidate's answer. Respond again with ONLY the JSON object, quoting only things the candidate actually said.",
};

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/** True if `quote` (normalized: case/whitespace/quote-mark insensitive) actually occurs in `answer`. */
export function isQuoteGrounded(answer: string, quote: string): boolean {
  const normalizedQuote = normalize(quote).replace(/^["']|["']$/g, "");
  if (!normalizedQuote) return false;
  return normalize(answer).includes(normalizedQuote);
}

export class EvidenceEvaluator {
  private readonly llm: LLMProvider;
  private readonly systemPromptExtra: string | undefined;
  private readonly temperature: number;
  private readonly maxTokens: number;

  constructor(opts: EvidenceEvaluatorOptions = {}) {
    this.llm = opts.llm ?? new SarvamLLM();
    this.systemPromptExtra = opts.systemPromptExtra;
    this.temperature = opts.temperature ?? DEFAULT_TEMPERATURE;
    this.maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  }

  /**
   * Produce an evidence-grounded evaluation of `input.answer`. Throws (never fabricates a score)
   * if a valid, grounded response still can't be obtained after one corrective retry — see the
   * module docstring. Also rejects if the underlying `LLMProvider` call itself fails.
   */
  async evaluate(input: EvidenceEvaluatorInput, opts: { signal?: AbortSignal } = {}): Promise<EvidenceEvaluation> {
    const system: LLMMessage = { role: "system", content: this.buildSystemPrompt() };
    const user: LLMMessage = { role: "user", content: this.buildUserPrompt(input) };
    const conversation = [system, user];

    const first = await this.llm.generate(conversation, {
      temperature: this.temperature,
      maxTokens: this.maxTokens,
      signal: opts.signal,
    });
    const firstResult = this.tryParseAndGround(first.text, input.answer);
    if (firstResult) return firstResult;

    log.warn("evidence evaluator: invalid or ungrounded response, retrying once", {
      raw: first.text.slice(0, 200),
    });

    const retry = await this.llm.generate([...conversation, { role: "assistant", content: first.text }, RETRY_NUDGE], {
      temperature: Math.min(this.temperature, 0.1), // calmer resample on retry, same idea as ConversationEngine's own retry
      maxTokens: this.maxTokens,
      signal: opts.signal,
    });
    const retryResult = this.tryParseAndGround(retry.text, input.answer);
    if (retryResult) return retryResult;

    throw new Error(
      "EvidenceEvaluator: could not obtain a valid, evidence-grounded evaluation after retrying once."
    );
  }

  private buildSystemPrompt(): string {
    const base = this.systemPromptExtra
      ? `${EVALUATOR_PERSONA_PROMPT}\n\n${this.systemPromptExtra}`
      : EVALUATOR_PERSONA_PROMPT;
    return `${base}\n\n${STRUCTURED_OUTPUT_PROMPT}`;
  }

  private buildUserPrompt(input: EvidenceEvaluatorInput): string {
    const lines = [
      input.question ? `Question asked: ${input.question}` : "Question asked: (not provided)",
      input.topic ? `Topic: ${input.topic}` : undefined,
      "",
      "Candidate's answer:",
      input.answer,
    ].filter((line): line is string => line !== undefined);
    return lines.join("\n");
  }

  /** Parses and validates `raw`, then grounds every evidence quote against `answer`. Returns
   *  `null` (triggering a retry) if the JSON is invalid/doesn't match the schema, or if grounding
   *  discards every single evidence item the model claimed to find. */
  private tryParseAndGround(raw: string, answer: string): EvidenceEvaluation | null {
    let parsed: EvidenceEvaluation;
    try {
      parsed = extractValidatedJson(raw, EvidenceEvaluationSchema);
    } catch {
      return null;
    }

    const grounded = parsed.evidence.filter((e) => isQuoteGrounded(answer, e.quote));
    if (parsed.evidence.length > 0 && grounded.length === 0) {
      // Every claimed quote was fabricated — treat the whole response as untrustworthy, not just
      // "evidence-free."
      return null;
    }
    if (grounded.length < parsed.evidence.length) {
      log.warn("evidence evaluator: dropped ungrounded evidence quote(s)", {
        dropped: parsed.evidence.length - grounded.length,
        kept: grounded.length,
      });
    }
    return { ...parsed, evidence: grounded };
  }
}
