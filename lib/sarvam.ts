// Thin Sarvam-native client. Callers decide how to handle failures: in production they surface an
// honest error; in DEMO_MODE they may fall back to clearly-labelled mock data.

import { env, sarvamConfigured } from "./env";

const SARVAM_BASE = "https://api.sarvam.ai";
const KEY = env.SARVAM_API_KEY || "";
// The hosted chat endpoint only accepts `sarvam-30b` / `sarvam-105b` (NOT the HuggingFace name
// `sarvam-m`, which 400s). Configurable in case the account only has 30b access.
const CHAT_MODEL = env.SARVAM_CHAT_MODEL;
// Sarvam reasoning models default to "medium" effort and burn the whole token budget thinking,
// leaving `content` empty -> the "finish_reason=length, empty content" bug. On the starter tier
// (max_tokens capped at 4096) even "low" effort exhausts the budget before any JSON is emitted, so
// we DISABLE reasoning by default (reasoning_effort: null). Every task here returns structured
// JSON or short coaching text, where thinking adds little. Override per-call or via
// SARVAM_REASONING_EFFORT if on a higher tier.
const REASONING_EFFORT = env.SARVAM_REASONING_EFFORT;

/** Map an effort string to the wire value. "none"/"off"/"null"/""/unknown -> null (disabled). */
function reasoningWireValue(effort: string | undefined): "low" | "medium" | "high" | null {
  const v = (effort ?? "").trim().toLowerCase();
  return v === "low" || v === "medium" || v === "high" ? v : null;
}

// Lightweight FIFO semaphore bounding concurrent Sarvam chat calls, so bursts of coaching
// requests never exceed the account tier's request rate limit.
let activeChatCalls = 0;
const chatQueue: Array<() => void> = [];

async function withChatSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (activeChatCalls >= env.SARVAM_MAX_CONCURRENCY) {
    await new Promise<void>((resolve) => chatQueue.push(resolve));
  }
  activeChatCalls++;
  try {
    return await fn();
  } finally {
    activeChatCalls--;
    chatQueue.shift()?.();
  }
}

export { sarvamConfigured };

function authHeaders(extra: Record<string, string> = {}) {
  return { "api-subscription-key": KEY, ...extra };
}

/** fetch() that actually aborts on timeout, the AbortController signal is wired into the request
 *  (the previous helper created a controller but never passed its signal, so it never timed out). */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  ms: number
): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      throw new Error(`Sarvam request timed out after ${ms}ms`);
    }
    throw e;
  } finally {
    clearTimeout(t);
  }
}

/** Sarvam chat completion. Returns the assistant message content. */
async function sarvamChatOnce(
  system: string,
  user: string,
  opts: { temperature?: number; maxTokens?: number; timeoutMs?: number; reasoningEffort?: string }
): Promise<string> {
  // Clamp to the subscription tier ceiling: Sarvam 400s any request whose max_tokens exceeds the
  // plan limit (starter = 4096 for sarvam-105b), so never ask for more than the tier allows.
  const maxTokens = Math.min(opts.maxTokens ?? 4000, env.SARVAM_MAX_TOKENS);
  const res = await fetchWithTimeout(
    `${SARVAM_BASE}/v1/chat/completions`,
    {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({
        model: CHAT_MODEL,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: opts.temperature ?? 0.2,
        // Budget for the JSON answer, capped at the tier ceiling.
        max_tokens: maxTokens,
        // null disables reasoning entirely so `content` is populated directly (no token burn on a
        // thinking phase). Per-call override wins over the SARVAM_REASONING_EFFORT default.
        reasoning_effort: reasoningWireValue(opts.reasoningEffort ?? REASONING_EFFORT),
      }),
    },
    opts.timeoutMs ?? 45000
  );
  if (!res.ok) throw new Error(`Sarvam chat ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const message = data?.choices?.[0]?.message ?? {};
  // The answer is in `content`; reasoning (if any) goes to `reasoning_content`. Some deployments
  // also inline <think>…</think> into content, strip it defensively.
  let content = (message.content ?? "") as string;
  if (content) content = content.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  if (!content) {
    const finish = (data?.choices?.[0]?.finish_reason ?? "unknown") as string;
    const err = new Error(
      `Sarvam chat returned empty content (model=${CHAT_MODEL}, finish_reason=${finish})`
    ) as Error & { finishReason?: string };
    // `length` means the reasoning step consumed the whole token budget before any visible
    // content was emitted; the caller uses this to retry with a much larger budget.
    err.finishReason = finish;
    throw err;
  }
  return content;
}

/** Sarvam chat completion with one retry. The reasoning model occasionally returns empty
 *  content (all tokens consumed by the reasoning phase -> finish_reason=length); the retry
 *  escalates the token budget so the answer actually fits. */
export async function sarvamChat(
  system: string,
  user: string,
  opts: { temperature?: number; maxTokens?: number; timeoutMs?: number; reasoningEffort?: string } = {}
): Promise<string> {
  if (!KEY) throw new Error("SARVAM_API_KEY not set");
  // One slot covers both the attempt and its retry, so the bound is on logical requests rather
  // than individual HTTP calls.
  return withChatSlot(async () => {
    try {
      return await sarvamChatOnce(system, user, opts);
    } catch (e) {
      const finishReason = (e as Error & { finishReason?: string }).finishReason;
      // Log the real cause, otherwise a misconfigured model/key looks like a generic fallback.
      console.warn(
        `[sarvam] chat attempt 1 failed (finish_reason=${finishReason ?? "n/a"}), retrying:`,
        (e as Error).message
      );
      // On a `length` truncation the previous budget was too small for the reasoning model: jump to
      // the tier ceiling (sarvamChatOnce clamps it to SARVAM_MAX_TOKENS, so this can never 400).
      // Otherwise just retry at a calmer temperature with at least the default budget.
      const retryMaxTokens =
        finishReason === "length"
          ? env.SARVAM_MAX_TOKENS
          : Math.max(opts.maxTokens ?? 4000, 4000);
      return await sarvamChatOnce(system, user, {
        ...opts,
        temperature: Math.min(opts.temperature ?? 0.2, 0.2),
        maxTokens: retryMaxTokens,
      });
    }
  });
}

/** Saarika STT. Returns transcript + detected language. */
export async function sarvamTranscribe(
  audio: Blob,
  filename: string,
  timeoutMs = 20000
): Promise<{ text: string; language: string }> {
  if (!KEY) throw new Error("SARVAM_API_KEY not set");
  const form = new FormData();
  form.append("file", audio, filename);
  form.append("model", "saarika:v2.5");
  form.append("language_code", "unknown"); // auto-detect + code-mixing
  const res = await fetchWithTimeout(
    `${SARVAM_BASE}/speech-to-text`,
    {
      method: "POST",
      headers: authHeaders(),
      body: form,
    },
    timeoutMs
  );
  if (!res.ok) throw new Error(`Sarvam STT ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return {
    text: data?.transcript ?? "",
    language: data?.language_code ?? "unknown",
  };
}

/**
 * Trim `text` to at most `limit` characters at a natural boundary (sentence end, else last space)
 * so speech is never cut mid-word. Returns the text unchanged when it already fits.
 */
export function clampSpeech(text: string, limit: number): string {
  const t = text.trim();
  if (t.length <= limit) return t;
  const window = t.slice(0, limit);
  const lastSentence = Math.max(window.lastIndexOf(". "), window.lastIndexOf("? "), window.lastIndexOf("! "));
  if (lastSentence >= limit * 0.6) return window.slice(0, lastSentence + 1).trim();
  const lastSpace = window.lastIndexOf(" ");
  return (lastSpace > 0 ? window.slice(0, lastSpace) : window).trim();
}

/** Bulbul TTS. Synthesizes `text` into speech and returns base64-encoded WAV audio. */
export async function sarvamTTS(
  text: string,
  targetLanguageCode = "en-IN",
  timeoutMs = 20000
): Promise<string> {
  if (!KEY) throw new Error("SARVAM_API_KEY not set");
  const model = env.SARVAM_TTS_MODEL;
  const speaker = env.SARVAM_TTS_SPEAKER; // default v2 speaker
  const res = await fetchWithTimeout(
    `${SARVAM_BASE}/text-to-speech`,
    {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({
        // bulbul:v2 caps input at 1500 chars; trim at a clause/word boundary so a long question
        // is never cut mid-word.
        text: clampSpeech(text, 1450),
        target_language_code: targetLanguageCode,
        model,
        speaker,
        pace: 1.0,
      }),
    },
    timeoutMs
  );
  if (!res.ok) throw new Error(`Sarvam TTS ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const audio = data?.audios?.[0] as string | undefined;
  if (!audio) throw new Error("Sarvam TTS: empty audio");
  return audio; // base64 WAV
}

/**
 * Scan from `start` and return the index just past the balanced JSON value that begins there,
 * correctly skipping braces/brackets that appear inside string literals (and their escapes).
 * Returns -1 if no balanced value is found.
 */
function matchBalanced(s: string, start: number): number {
  const open = s[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/**
 * Robustly pull the first balanced JSON value out of an LLM response that may include prose or
 * code fences. Uses brace-matching that respects string literals, so braces inside string values
 * (or a trailing second object) do not corrupt the extracted slice.
 */
export function extractJson<T = unknown>(raw: string): T {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const source = fenced ? fenced[1] : raw;
  const objStart = source.indexOf("{");
  const arrStart = source.indexOf("[");
  let begin = -1;
  if (objStart !== -1 && arrStart !== -1) begin = Math.min(objStart, arrStart);
  else begin = Math.max(objStart, arrStart);
  if (begin === -1) throw new Error("No JSON found in LLM output");
  const end = matchBalanced(source, begin);
  const slice = end === -1 ? source.slice(begin) : source.slice(begin, end);
  return JSON.parse(slice) as T;
}

/**
 * Extract JSON from an LLM response and validate it against a Zod schema. The schema is the
 * contract: a structurally-valid-but-semantically-wrong response is rejected here rather than
 * flowing downstream into coaching signals.
 */
export function extractValidatedJson<T>(raw: string, schema: { parse: (v: unknown) => T }): T {
  return schema.parse(extractJson(raw));
}
