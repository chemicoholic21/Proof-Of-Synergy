/**
 * Decides the interviewer's next move as one structured `InterviewTurnResponse`, instead of the
 * uncontrolled free-form text `generatePartnerReply`/`app/api/gemini/route.ts` return today.
 *
 * `VoiceSession` (lib/voice/VoiceSession.ts) explicitly leaves "manage conversation history or
 * scenario/system-prompt selection" to "one layer up" — `ConversationEngine` is that layer for the
 * decision-making step: a caller keeps the running `LLMMessage[]` history (ending with the
 * candidate's latest answer as the last `"user"` message) and asks `nextTurn()` what the
 * interviewer should do about it. What comes back is never raw prose to read aloud as-is; it's a
 * typed decision the rest of the pipeline can act on deterministically:
 *
 *   {
 *     "action": "FOLLOW_UP",
 *     "speech": "Can you explain that further?",
 *     "topic": "distributed systems",
 *     "evaluation_required": true
 *   }
 *
 * - `action` — what kind of turn this is (see `InterviewAction` below). A caller can use this to
 *   drive UI/telemetry (e.g. publish a different `InterviewEvent` for a wrap-up vs. a follow-up)
 *   without parsing the interviewer's words.
 * - `speech` — the only text meant to actually be read aloud (e.g. handed to
 *   `VoiceSession`'s `generateReply` → TTS). Kept short and natural on purpose — see "Keeping
 *   responses concise" below — never markdown, bullet points, or multi-paragraph prose.
 * - `topic` — a short label for what this turn is about, for logging/telemetry or to bias a
 *   later turn back toward the same subject.
 * - `evaluation_required` — whether this turn's candidate answer is substantive enough to be
 *   worth scoring (e.g. by `lib/coaching.ts`). `ConversationEngine` only signals this; it never
 *   calls an evaluator itself — running one, like managing history, is the caller's job.
 *
 * ## Model
 *
 * Uses `sarvam-105b-conversations` — Sarvam's post-trained variant of Sarvam-105B "for real-time
 * conversational workloads — voice agents, chatbots, and multi-turn dialogue where natural,
 * colloquial ... responses matter more than deep reasoning traces" (docs.sarvam.ai), rather than
 * the general `sarvam-105b`/`SARVAM_CHAT_MODEL` default `lib/sarvam.ts` and `lib/prompts.ts` use
 * for the rest of the app today. Calls go through `LLMProvider`/`SarvamLLM`
 * (lib/providers/llm/) rather than `lib/sarvam.ts` directly, so this file (and the model it talks
 * to) can be swapped or unit-tested without touching either.
 *
 * ## Getting structured output out of a chat model
 *
 * Sarvam's chat completions endpoint does support an OpenAI-compatible `response_format:
 * {type:"json_schema", ...}` for schema-constrained output (docs.sarvam.ai) — but plumbing that
 * through would mean adding a field to `LLMGenerateOptions` (lib/providers/llm/types.ts) purely
 * for this one caller, and even a provider that enforces a schema can still wrap output in prose
 * or fences. Instead this class uses the same defensive approach `lib/sarvam.ts` already applies
 * everywhere else in this codebase: a system prompt that demands JSON-only output, `extractJson`/
 * `extractValidatedJson` to robustly pull a JSON object out of whatever text actually comes back
 * (stripping code fences, ignoring surrounding prose), and a zod schema (`InterviewTurnResponse`
 * below) that rejects anything that doesn't match the exact contract above. One corrective retry
 * runs if the first attempt fails either step; a small, clearly-generic fallback response is
 * returned (never thrown) if the retry fails too — the same "never hard-stop the session over a
 * malformed model reply" posture `lib/tts-client.ts` already takes for a failed TTS call.
 *
 * ## Keeping responses concise
 *
 * The system prompt asks for 1–3 short spoken sentences, and `speech` is additionally clamped
 * with `lib/sarvam.ts`'s `clampSpeech` (same helper `sarvamTTS` already uses) so a model that
 * ignores the instruction still can't hand back a paragraph — trimmed at a sentence/word boundary,
 * never mid-word.
 */

import { z } from "zod";
import { SarvamLLM } from "../providers/llm/SarvamLLM";
import type { LLMMessage, LLMProvider } from "../providers/llm/types";
import { clampSpeech, extractValidatedJson } from "../sarvam";
import { logger } from "../logger";

const log = logger.child({ module: "conversation-engine" });

/** Sarvam's post-trained variant for real-time conversational/voice-agent workloads. */
export const CONVERSATION_MODEL = "sarvam-105b-conversations";

/** A spoken response would run long past what a real interviewer would say in one breath beyond this. */
const MAX_SPEECH_CHARS = 320;

export const INTERVIEW_ACTIONS = [
  "FOLLOW_UP",
  "NEXT_QUESTION",
  "CLARIFY",
  "ACKNOWLEDGE",
  "REPEAT",
  "END_INTERVIEW",
] as const;

export type InterviewAction = (typeof INTERVIEW_ACTIONS)[number];

const InterviewTurnResponseSchema = z.object({
  action: z.enum(INTERVIEW_ACTIONS),
  speech: z.string().trim().min(1, "speech must not be empty"),
  topic: z.string().trim().min(1, "topic must not be empty"),
  evaluation_required: z.boolean(),
});

export type InterviewTurnResponse = z.infer<typeof InterviewTurnResponseSchema>;

export interface ConversationEngineOptions {
  /** Defaults to a `SarvamLLM` configured for `CONVERSATION_MODEL`. Inject any `LLMProvider` (a
   *  test double, or a different vendor entirely) to swap it out. */
  llm?: LLMProvider;
  /** Only used when `llm` isn't supplied — overrides which model the default `SarvamLLM` targets.
   *  Defaults to `CONVERSATION_MODEL`. */
  model?: string;
  /** Extra interviewer persona/context (e.g. resume-tailored instructions from
   *  `buildInterviewContext` in lib/prompts.ts) appended to the built-in schema instructions,
   *  which are never overridable — every response still has to match `InterviewTurnResponse`. */
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
}

const DEFAULT_TEMPERATURE = 0.6;
const DEFAULT_MAX_TOKENS = 400;

const BASE_SYSTEM_PROMPT = `You are conducting a live spoken technical interview. You must respond with structured decisions, never freeform prose.

For every candidate turn, choose exactly one action:
- FOLLOW_UP: the answer was relevant but shallow — ask a deeper question on the SAME topic.
- NEXT_QUESTION: the answer was adequate — move on to a NEW topic or question.
- CLARIFY: the answer was ambiguous, off-topic, or didn't address what was asked — ask the candidate to clarify or address it directly.
- ACKNOWLEDGE: a brief acknowledgment or transition with no new question (e.g. wrapping up a point before moving on).
- REPEAT: the candidate seems confused, didn't hear, or asked you to repeat yourself — restate the current question, reworded slightly if helpful.
- END_INTERVIEW: the interview should conclude now — give a short, warm closing statement.

Rules for "speech" (the words to actually say out loud):
- 1 to 3 short sentences. Natural, spoken, conversational language — never markdown, bullet points, headings, or multi-paragraph text.
- Never mention that you are an AI, a model, or that you are following instructions or a schema.
- Never repeat the candidate's entire answer back to them.

Set "evaluation_required" to true only when the candidate just gave a substantive, scorable technical answer worth evaluating. It is normally false for CLARIFY, REPEAT, and END_INTERVIEW turns, and for an ACKNOWLEDGE that isn't following a real answer.

Set "topic" to a short (2-5 word) label for what this turn is about.

Respond with ONLY a single JSON object, exactly this shape, and nothing else — no code fences, no commentary before or after it:
{"action": "FOLLOW_UP" | "NEXT_QUESTION" | "CLARIFY" | "ACKNOWLEDGE" | "REPEAT" | "END_INTERVIEW", "speech": string, "topic": string, "evaluation_required": boolean}`;

const RETRY_NUDGE: LLMMessage = {
  role: "user",
  content:
    "Your previous response was not a valid JSON object matching the required shape. Respond again with ONLY the JSON object — no prose, no code fences.",
};

function fallbackResponse(topic: string): InterviewTurnResponse {
  return {
    action: "ACKNOWLEDGE",
    speech: "Thanks for sharing that — let's continue.",
    topic,
    evaluation_required: false,
  };
}

/** Best-effort guess at "the current topic" for the fallback response, from whatever the caller's
 *  history already establishes (its own most recent non-empty content), else `"general"`. */
function inferFallbackTopic(messages: LLMMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const content = messages[i]?.content?.trim();
    if (content) return content.slice(0, 40);
  }
  return "general";
}

export class ConversationEngine {
  private readonly llm: LLMProvider;
  private readonly systemPromptExtra: string | undefined;
  private readonly temperature: number;
  private readonly maxTokens: number;

  constructor(opts: ConversationEngineOptions = {}) {
    this.llm = opts.llm ?? new SarvamLLM({ model: opts.model ?? CONVERSATION_MODEL });
    this.systemPromptExtra = opts.systemPrompt;
    this.temperature = opts.temperature ?? DEFAULT_TEMPERATURE;
    this.maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  }

  /**
   * Decide the interviewer's next action given the conversation so far. `messages` should be the
   * full turn history, ending with the candidate's latest answer as the last `"user"` message —
   * `ConversationEngine` never manages history itself (see the module docstring).
   *
   * Never rejects on a malformed model reply: one corrective retry runs first, and a generic,
   * clearly-labelled-in-logs fallback (`ACKNOWLEDGE`) is returned if that fails too. It *does*
   * reject if the underlying `LLMProvider` call itself fails (network error, aborted `signal`,
   * etc.) — that failure is the caller's to handle, the same way a failed LLM call is handled
   * upstream today.
   */
  async nextTurn(messages: LLMMessage[], opts: { signal?: AbortSignal } = {}): Promise<InterviewTurnResponse> {
    const system: LLMMessage = { role: "system", content: this.buildSystemPrompt() };
    const conversation = [system, ...messages];

    const first = await this.llm.generate(conversation, {
      temperature: this.temperature,
      maxTokens: this.maxTokens,
      signal: opts.signal,
    });
    const parsed = this.tryParse(first.text);
    if (parsed) return this.finalize(parsed);

    log.warn("conversation engine: invalid structured response, retrying once", {
      raw: first.text.slice(0, 200),
    });

    const retry = await this.llm.generate([...conversation, { role: "assistant", content: first.text }, RETRY_NUDGE], {
      temperature: Math.min(this.temperature, 0.2), // calmer resample on retry, same escalation idea as sarvamChatWithRetry
      maxTokens: this.maxTokens,
      signal: opts.signal,
    });
    const retryParsed = this.tryParse(retry.text);
    if (retryParsed) return this.finalize(retryParsed);

    log.warn("conversation engine: retry also produced an invalid response, falling back", {
      raw: retry.text.slice(0, 200),
    });
    return fallbackResponse(inferFallbackTopic(messages));
  }

  private buildSystemPrompt(): string {
    return this.systemPromptExtra ? `${BASE_SYSTEM_PROMPT}\n\n${this.systemPromptExtra}` : BASE_SYSTEM_PROMPT;
  }

  private tryParse(raw: string): InterviewTurnResponse | null {
    try {
      return extractValidatedJson(raw, InterviewTurnResponseSchema);
    } catch {
      return null;
    }
  }

  /** Enforces conciseness defensively even if the model ignores the prompt's instruction. */
  private finalize(response: InterviewTurnResponse): InterviewTurnResponse {
    return { ...response, speech: clampSpeech(response.speech, MAX_SPEECH_CHARS) };
  }
}
