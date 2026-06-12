// Thin Sarvam-native client. Callers decide how to handle failures: in production they surface an
// honest error; in DEMO_MODE they may fall back to clearly-labelled mock data.

import { env, sarvamConfigured } from "./env";

const SARVAM_BASE = "https://api.sarvam.ai";
const KEY = env.SARVAM_API_KEY || "";
// The hosted chat endpoint only accepts `sarvam-30b` / `sarvam-105b` (NOT the HuggingFace name
// `sarvam-m`, which 400s). Configurable in case the account only has 30b access.
const CHAT_MODEL = env.SARVAM_CHAT_MODEL;
// Sarvam reasoning models default to "medium" effort and will burn the whole token budget
// thinking, leaving `content` empty (the bug behind the silent fallback). Keep it low.
const REASONING_EFFORT = env.SARVAM_REASONING_EFFORT;

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
  opts: { temperature?: number; maxTokens?: number; timeoutMs?: number }
): Promise<string> {
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
        // Generous budget so the JSON answer is never truncated after the (low) reasoning step.
        max_tokens: opts.maxTokens ?? 4000,
        // First-class param to keep reasoning minimal so `content` is actually populated.
        reasoning_effort: REASONING_EFFORT,
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
    const finish = data?.choices?.[0]?.finish_reason ?? "unknown";
    throw new Error(`Sarvam chat returned empty content (model=${CHAT_MODEL}, finish_reason=${finish})`);
  }
  return content;
}

/** Sarvam chat completion with one retry, the reasoning model occasionally returns empty
 *  content; a single retry makes it reliable. */
export async function sarvamChat(
  system: string,
  user: string,
  opts: { temperature?: number; maxTokens?: number; timeoutMs?: number } = {}
): Promise<string> {
  if (!KEY) throw new Error("SARVAM_API_KEY not set");
  try {
    return await sarvamChatOnce(system, user, opts);
  } catch (e) {
    // Log the real cause, otherwise a misconfigured model/key looks like a generic fallback.
    console.warn("[sarvam] chat attempt 1 failed, retrying:", (e as Error).message);
    // Retry once at lower temperature with a larger budget.
    return await sarvamChatOnce(system, user, {
      ...opts,
      temperature: Math.min(opts.temperature ?? 0.2, 0.2),
      maxTokens: Math.max(opts.maxTokens ?? 4000, 4000),
    });
  }
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
        // bulbul:v2 caps input at 1500 chars; trim defensively so long questions still speak.
        text: text.slice(0, 1450),
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

/** Sarvam Parse (OCR). Returns extracted text/markdown from a document. */
export async function sarvamParse(file: Blob, filename: string, timeoutMs = 25000): Promise<string> {
  if (!KEY) throw new Error("SARVAM_API_KEY not set");
  const form = new FormData();
  form.append("file", file, filename);
  form.append("page_number", "1");
  form.append("sarvam_mode", "small");
  const res = await fetchWithTimeout(
    `${SARVAM_BASE}/parse/parsepdf`,
    {
      method: "POST",
      headers: authHeaders(),
      body: form,
    },
    timeoutMs
  );
  if (!res.ok) throw new Error(`Sarvam Parse ${res.status}: ${await res.text()}`);
  const data = await res.json();
  // Parse returns base64-encoded XML/markdown depending on mode; normalize to text.
  const out = data?.output ?? data?.content ?? "";
  try {
    return Buffer.from(out, "base64").toString("utf-8") || out;
  } catch {
    return out;
  }
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
  const candidate = fenced ? fenced[1] : raw;
  const objStart = candidate.indexOf("{");
  const arrStart = candidate.indexOf("[");
  let begin = -1;
  if (objStart !== -1 && arrStart !== -1) begin = Math.min(objStart, arrStart);
  else begin = Math.max(objStart, arrStart);
  if (begin === -1) throw new Error("No JSON found in LLM output");
  const end = matchBalanced(candidate, begin);
  const slice = end === -1 ? candidate.slice(begin) : candidate.slice(begin, end);
  return JSON.parse(slice) as T;
}

/**
 * Extract JSON from an LLM response and validate it against a Zod schema. The schema is the
 * contract: a structurally-valid-but-semantically-wrong response is rejected here rather than
 * flowing downstream into scores and on-chain attestations.
 */
export function extractValidatedJson<T>(raw: string, schema: { parse: (v: unknown) => T }): T {
  return schema.parse(extractJson(raw));
}
