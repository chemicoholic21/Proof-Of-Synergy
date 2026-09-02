/**
 * Builds the minimum sufficient LLM context for one turn — the piece that turns everything else
 * built in `lib/interview/` into an actual, bounded prompt instead of an ever-growing one. This
 * commit exists for cost control: every token sent to an LLM is billed and adds latency, and the
 * naive approach — hand the model the whole interview so far, plus the whole resume, on every
 * single turn — grows without bound as an interview goes on. `ContextBuilder` caps that growth
 * deterministically, on every call, by including only:
 *
 *   1. **Stable instructions** — the interviewer/scenario framing that never changes turn to turn
 *      (e.g. "You are interviewing a candidate for a backend engineering role."), included as-is.
 *   2. **Current interview state** — stage and difficulty, from `MemoryEngine.buildContextSummary()`
 *      (./MemoryEngine.ts), which is already a small, bounded summary by construction (see that
 *      file's own docstring on why it stores durable facts instead of raw history in the first
 *      place — this class is the payoff of that design).
 *   3. **Recent turns** — the last `maxRecentMessages` messages, further capped to
 *      `maxRecentChars` total, verbatim. Older turns are dropped, not summarized: anything about
 *      them worth carrying forward should already have been distilled into `MemoryEngine` as a
 *      durable fact by the time they scroll out of this window — that's what turns a fixed-size
 *      recent-turns window from "lossy" into "fine."
 *   4. **Topic-relevant memory** — `MemoryEngine.buildContextSummary({ topic })`, scoped to the
 *      turn's current topic rather than the whole session, so a long interview's memory summary
 *      doesn't itself grow without bound either.
 *
 * ## Excluding unrelated resume and interview information
 *
 * Today, `buildInterviewContext`/`interviewOpeningUserPrompt` (lib/prompts.ts) build one large,
 * static, resume-derived system prompt for a resume-based interview, and `app/api/gemini/route.ts`
 * sends that *entire* prompt on *every single turn* regardless of what's actually being discussed
 * right now — a candidate's five-page resume gets re-sent in full even for a turn about one
 * three-line project bullet. `ContextBuilder` is built to fix exactly that: it takes the resume
 * pre-split into small, topic-tagged `ResumeFact`s (that splitting is a separate concern, not this
 * file's job) and includes only the ones related to the current turn's topic, dropping the rest —
 * "unrelated resume and interview information," per this module's mandate. A topic-agnostic call
 * (no `currentTopic` given, e.g. generating the opening question) excludes resume facts entirely
 * rather than including all of them, since there's no relevance signal to filter by yet — still a
 * cost-control win, not a gap.
 *
 * `build()` is a pure function of its input: no I/O, no LLM calls, no mutation of the `MemoryEngine`
 * passed in. Its output is designed to plug directly into the injection points already built for
 * that purpose — `systemPromptExtra` on `ConversationEngine`/`EvidenceEvaluator`
 * (./ConversationEngine.ts, ./EvidenceEvaluator.ts) and `messages` as the turn history either one
 * expects — without requiring any change to either file.
 */

import type { LLMMessage } from "../providers/llm/types";
import type { MemoryEngine } from "./MemoryEngine";

/** One small, topic-tagged fact pulled from the candidate's resume — the unit `ContextBuilder`
 *  filters on, not the resume's raw text. Producing these from a resume is a separate concern. */
export interface ResumeFact {
  /** Short topic label, matched against `currentTopic` the same way `MemoryEngine` matches its
   *  own topic-scoped facts — case-insensitive, substring-tolerant (see `topicsRelated` below). */
  topic: string;
  /** The short, ready-to-inject snippet itself (e.g. one resume bullet or project description). */
  content: string;
}

export interface ContextBuilderOptions {
  /** Hard cap on how many of the most recent messages are kept at all, before the character
   *  budget below is even considered. Default 8 (about four user/assistant exchanges). */
  maxRecentMessages?: number;
  /** Character budget for the kept recent messages combined — a coarse proxy for token cost, not
   *  an exact count (see `approxTokens` on `BuiltContext`). Filled from the most recent message
   *  backward; the single most recent message is always kept even if it alone exceeds this
   *  budget, so a caller is never left with zero turns of context. Default 2000. */
  maxRecentChars?: number;
  /** Cap on how many topic-matching resume facts are included even if more match. Default 3. */
  maxResumeFacts?: number;
}

export interface ContextBuilderInput {
  /** Always included verbatim — see the module docstring. */
  stableInstructions?: string;
  /** Source of current interview state and topic-relevant memory (see the module docstring). */
  memory: MemoryEngine;
  /** The topic of the turn about to be generated. Omit for a topic-agnostic call (e.g. the
   *  opening question) — resume facts are then excluded entirely rather than all included. */
  currentTopic?: string;
  /** The candidate's resume, pre-split into topic-tagged facts (see `ResumeFact`). Only the ones
   *  related to `currentTopic` are included, up to `maxResumeFacts`. */
  resumeFacts?: ResumeFact[];
  /** The full turn history so far (user/assistant only — see `selectRecentTurns`). Only the most
   *  recent slice (see `ContextBuilderOptions`) is kept. */
  recentTurns: LLMMessage[];
}

export interface BuiltContext {
  /** Ready to pass as `systemPromptExtra` to `ConversationEngine`/`EvidenceEvaluator`. */
  systemPromptExtra: string;
  /** Ready to pass as the turn history to either one. */
  messages: LLMMessage[];
  /** How much was left out, and why — for cost-control observability/auditing. */
  omitted: {
    olderTurns: number;
    unrelatedResumeFacts: number;
  };
  /** `Math.ceil(totalChars / 4)` — the usual rough English-text heuristic, not an exact count from
   *  the model's actual tokenizer. Good enough to sanity-check that context stays bounded turn
   *  over turn; not good enough to bill against precisely. */
  approxTokens: number;
}

const DEFAULT_MAX_RECENT_MESSAGES = 8;
const DEFAULT_MAX_RECENT_CHARS = 2000;
const DEFAULT_MAX_RESUME_FACTS = 3;

function normalize(text: string): string {
  return text.trim().toLowerCase();
}

/** Case-insensitive, substring-tolerant match in either direction — the same deterministic,
 *  no-embeddings-required heuristic `MemoryEngine` uses for its own topic matching, so "caching"
 *  and "caching strategy" are treated as the same topic without needing exact string equality. */
export function topicsRelated(a: string, b: string): boolean {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return false;
  return na.includes(nb) || nb.includes(na);
}

/**
 * Keeps at most `maxMessages` of the most recent, non-system messages in `turns`, then trims
 * further from the front (oldest of that slice) until the combined content length is at most
 * `maxChars` — except the single most recent message is always kept regardless of its own length,
 * so a caller is never handed zero turns of context.
 */
export function selectRecentTurns(
  turns: LLMMessage[],
  maxMessages: number,
  maxChars: number
): { kept: LLMMessage[]; omittedCount: number } {
  const conversational = turns.filter((t) => t.role !== "system");
  const tail = conversational.slice(-Math.max(0, maxMessages));
  const omittedByCount = conversational.length - tail.length;

  const kept: LLMMessage[] = [];
  let totalChars = 0;
  for (let i = tail.length - 1; i >= 0; i--) {
    const len = tail[i].content.length;
    if (kept.length > 0 && totalChars + len > maxChars) break;
    totalChars += len;
    kept.unshift(tail[i]);
  }
  return { kept, omittedCount: omittedByCount + (tail.length - kept.length) };
}

/** Filters `facts` down to the ones related to `topic` (see `topicsRelated`), capped at
 *  `maxFacts`. Excludes everything when `topic` is `undefined` — see the module docstring on why
 *  a topic-agnostic call has no resume facts at all rather than all of them. */
export function selectResumeFacts(
  facts: ResumeFact[],
  topic: string | undefined,
  maxFacts: number
): { kept: ResumeFact[]; omittedCount: number } {
  if (topic === undefined) return { kept: [], omittedCount: facts.length };
  const related = facts.filter((f) => topicsRelated(f.topic, topic));
  return { kept: related.slice(0, maxFacts), omittedCount: facts.length - Math.min(related.length, maxFacts) };
}

export class ContextBuilder {
  private readonly maxRecentMessages: number;
  private readonly maxRecentChars: number;
  private readonly maxResumeFacts: number;

  constructor(opts: ContextBuilderOptions = {}) {
    this.maxRecentMessages = opts.maxRecentMessages ?? DEFAULT_MAX_RECENT_MESSAGES;
    this.maxRecentChars = opts.maxRecentChars ?? DEFAULT_MAX_RECENT_CHARS;
    this.maxResumeFacts = opts.maxResumeFacts ?? DEFAULT_MAX_RESUME_FACTS;
  }

  /** Pure — no I/O, no LLM calls, and `input.memory` is only ever read, never mutated. */
  build(input: ContextBuilderInput): BuiltContext {
    const memorySummary = input.memory.buildContextSummary({ topic: input.currentTopic });
    const { kept: resumeFacts, omittedCount: unrelatedResumeFacts } = selectResumeFacts(
      input.resumeFacts ?? [],
      input.currentTopic,
      this.maxResumeFacts
    );
    const { kept: messages, omittedCount: olderTurns } = selectRecentTurns(
      input.recentTurns,
      this.maxRecentMessages,
      this.maxRecentChars
    );

    const sections = [
      input.stableInstructions?.trim(),
      memorySummary,
      resumeFacts.length > 0
        ? `Relevant candidate background: ${resumeFacts.map((f) => f.content).join(" ")}`
        : undefined,
    ].filter((s): s is string => Boolean(s && s.length > 0));

    const systemPromptExtra = sections.join("\n\n");
    const totalChars = systemPromptExtra.length + messages.reduce((sum, m) => sum + m.content.length, 0);

    return {
      systemPromptExtra,
      messages,
      omitted: { olderTurns, unrelatedResumeFacts },
      approxTokens: Math.ceil(totalChars / 4),
    };
  }
}
