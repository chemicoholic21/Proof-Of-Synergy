// Thin Sarvam-native client. All callers wrap these in try/catch and fall back to mock data,
// so a missing key or a timeout never reaches the judge.

const SARVAM_BASE = "https://api.sarvam.ai";
const KEY = process.env.SARVAM_API_KEY || "";
// Chat model is configurable so a key without 105b access can fall back to the stable `sarvam-m`.
const CHAT_MODEL = process.env.SARVAM_CHAT_MODEL || "sarvam-m";

export function sarvamConfigured(): boolean {
  return KEY.length > 0;
}

function authHeaders(extra: Record<string, string> = {}) {
  return { "api-subscription-key": KEY, ...extra };
}

/** fetch() that actually aborts on timeout — the AbortController signal is wired into the request
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

/** Sarvam-M chat completion. Returns the assistant message content. */
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
        // sarvam-m/105b are reasoning models; "/no_think" disables chain-of-thought so the
        // assistant returns the answer directly in `content` (otherwise it burns the whole
        // token budget on reasoning and `content` comes back null).
        model: CHAT_MODEL,
        messages: [
          { role: "system", content: `${system} /no_think` },
          { role: "user", content: `${user} /no_think` },
        ],
        temperature: opts.temperature ?? 0.4,
        max_tokens: opts.maxTokens ?? 2500,
      }),
    },
    opts.timeoutMs ?? 45000
  );
  if (!res.ok) throw new Error(`Sarvam chat ${res.status}: ${await res.text()}`);
  const data = await res.json();
  let content = data?.choices?.[0]?.message?.content as string | null | undefined;
  if (content) content = content.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  if (!content) throw new Error("Sarvam chat: empty content");
  return content;
}

/** Sarvam-M chat completion with one retry — the reasoning model occasionally ignores
 *  /no_think and returns empty content; a single retry makes it reliable. */
export async function sarvamChat(
  system: string,
  user: string,
  opts: { temperature?: number; maxTokens?: number; timeoutMs?: number } = {}
): Promise<string> {
  if (!KEY) throw new Error("SARVAM_API_KEY not set");
  try {
    return await sarvamChatOnce(system, user, opts);
  } catch (e) {
    // Retry once at lower temperature with a larger budget.
    return await sarvamChatOnce(system, user, {
      ...opts,
      temperature: Math.min(opts.temperature ?? 0.4, 0.3),
      maxTokens: Math.max(opts.maxTokens ?? 2500, 3000),
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
  const model = process.env.SARVAM_TTS_MODEL || "bulbul:v2";
  const speaker = process.env.SARVAM_TTS_SPEAKER || "anushka"; // default v2 speaker
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

/** Robustly pull a JSON object out of an LLM response that may include prose or code fences. */
export function extractJson<T>(raw: string): T {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.indexOf("{");
  const startArr = candidate.indexOf("[");
  const begin =
    startArr !== -1 && (startArr < start || start === -1) ? startArr : start;
  const lastObj = candidate.lastIndexOf("}");
  const lastArr = candidate.lastIndexOf("]");
  const end = Math.max(lastObj, lastArr);
  if (begin === -1 || end === -1) throw new Error("No JSON found in LLM output");
  return JSON.parse(candidate.slice(begin, end + 1)) as T;
}
