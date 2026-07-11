import { env, gemmaConfigured, sarvamConfigured } from "./env";
import { sarvamChat, extractValidatedJson } from "./sarvam";
import { GEMMA_COACHING_SYSTEM, gemmaCoachingUserPrompt } from "./prompts";
import { logger } from "./logger";
import { CoachingEvent } from "@/lib/types";

export { gemmaConfigured };

const log = logger.child({ module: "gemma" });

/** Which engine produced the coaching analysis - surfaced so a fallback is observable. */
export type GemmaEngine = "gemma-local" | "sarvam" | "heuristic";

export interface GemmaCoachingResult {
  fillerWords: string[];
  hesitations: string[];
  ramble: boolean;
  weakStructure: boolean;
  confidenceDrop: boolean;
  repetitivePhrases: string[];
  positiveHighlights: string[];
  suggestion: string;
  coachingEvents: CoachingEvent[];
  engine: GemmaEngine;
}

// ---------------------------------------------------------------------------
// Local Gemma via GEMMA_URL. This is the privacy-first path: the learner's
// transcript never leaves the machine. Two server protocols are auto-detected:
//   - Ollama          (/api/tags, /api/chat)              e.g. http://localhost:11434
//   - OpenAI-compatible (/v1/models, /v1/chat/completions) e.g. LM Studio on http://localhost:1234
// GEMMA_MODEL is treated as a hint: if the server doesn't list it exactly, the
// closest local Gemma model is used (LM Studio ids look like "google/gemma-3n-e2b",
// Ollama tags like "gemma3:4b" - nobody should have to spell these perfectly).
// ---------------------------------------------------------------------------

type GemmaProtocol = "ollama" | "openai";
let detected: { protocol: GemmaProtocol; model: string } | null = null;

async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") throw new Error(`Gemma request timed out after ${ms}ms`);
    throw e;
  } finally {
    clearTimeout(t);
  }
}

function gemmaBase(): string {
  return (env.GEMMA_URL || "").replace(/\/+$/, "");
}

/** Pick the best model id from what the server actually serves. */
function pickModel(available: string[]): string {
  const wanted = env.GEMMA_MODEL.toLowerCase();
  const norm = (s: string) => s.toLowerCase();
  return (
    available.find((m) => norm(m) === wanted) ??
    available.find((m) => norm(m).includes(wanted) || wanted.includes(norm(m))) ??
    available.find((m) => norm(m).includes("gemma")) ??
    available[0] ??
    env.GEMMA_MODEL
  );
}

/** Detect which protocol GEMMA_URL speaks and which model to use. Cached per process. */
async function detectGemma(): Promise<{ protocol: GemmaProtocol; model: string } | null> {
  if (detected) return detected;
  if (!gemmaConfigured()) return null;
  // Ollama native
  try {
    const res = await fetchWithTimeout(`${gemmaBase()}/api/tags`, { method: "GET" }, 5000);
    if (res.ok) {
      const data = (await res.json()) as { models?: { name: string }[] };
      const names = (data.models ?? []).map((m) => m.name);
      if (names.length || !res.headers.get("content-type")?.includes("html")) {
        detected = { protocol: "ollama", model: pickModel(names) };
        log.info("gemma endpoint detected", detected);
        return detected;
      }
    }
  } catch {
    /* try the next protocol */
  }
  // OpenAI-compatible (LM Studio, llama.cpp server, vLLM, ...)
  try {
    const res = await fetchWithTimeout(`${gemmaBase()}/v1/models`, { method: "GET" }, 5000);
    if (res.ok) {
      const data = (await res.json()) as { data?: { id: string }[] };
      const ids = (data.data ?? []).map((m) => m.id);
      detected = { protocol: "openai", model: pickModel(ids) };
      log.info("gemma endpoint detected", detected);
      return detected;
    }
  } catch {
    /* unreachable */
  }
  return null;
}

/** Chat with the local Gemma model over whichever protocol the endpoint speaks. */
async function gemmaLocalChat(system: string, user: string): Promise<string> {
  const target = await detectGemma();
  if (!target) throw new Error(`Gemma endpoint unreachable at ${gemmaBase()}`);

  if (target.protocol === "ollama") {
    const res = await fetchWithTimeout(
      `${gemmaBase()}/api/chat`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: target.model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          stream: false,
          format: "json",
          options: { temperature: 0.2 },
        }),
      },
      60000
    );
    if (!res.ok) throw new Error(`Gemma (Ollama) ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const content = data?.message?.content as string | undefined;
    if (!content) throw new Error("Gemma (Ollama) returned empty content");
    return content;
  }

  // OpenAI-compatible: JSON is requested via the prompt; extractJson tolerates prose/fences.
  const res = await fetchWithTimeout(
    `${gemmaBase()}/v1/chat/completions`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: target.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: 0.2,
        max_tokens: 900,
        stream: false,
      }),
    },
    60000
  );
  if (!res.ok) throw new Error(`Gemma (OpenAI-compatible) ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content as string | undefined;
  if (!content) throw new Error("Gemma (OpenAI-compatible) returned empty content");
  return content;
}

/** Liveness probe used by /api/health: endpoint up, which protocol, which model resolved. */
export async function gemmaPing(): Promise<{ ok: boolean; model: string | null; protocol: GemmaProtocol | null }> {
  if (!gemmaConfigured()) return { ok: false, model: null, protocol: null };
  detected = null; // re-detect on every health check so a restarted server is picked up
  const target = await detectGemma();
  return target ? { ok: true, model: target.model, protocol: target.protocol } : { ok: false, model: null, protocol: null };
}

const FILLER_RE = /\b(um+|uh+|erm+|hmm+|like|basically|actually|kind of|sort of|you know|i mean|so yeah|literally)\b/gi;
const HESITATION_RE = /\b(i think|maybe|probably|i guess|i'm not sure|possibly|i believe)\b/gi;
const REPETITION_RE = /(\b\w+\b)(?=.*\b\1\b)/gi;

function detectFillers(text: string): string[] {
  const matches = text.match(FILLER_RE) || [];
  const counts = new Map<string, number>();
  for (const m of matches) {
    counts.set(m.toLowerCase(), (counts.get(m.toLowerCase()) || 0) + 1);
  }
  return Array.from(counts.entries())
    .filter(([, c]) => c >= 2)
    .map(([word]) => word);
}

function detectHesitations(text: string): string[] {
  const matches = text.match(HESITATION_RE) || [];
  const counts = new Map<string, number>();
  for (const m of matches) {
    counts.set(m.toLowerCase(), (counts.get(m.toLowerCase()) || 0) + 1);
  }
  return Array.from(counts.entries())
    .filter(([, c]) => c >= 2)
    .map(([word]) => word);
}

function detectRepetition(text: string): string[] {
  const words = text.toLowerCase().split(/\s+/);
  const counts = new Map<string, number>();
  for (const w of words) {
    counts.set(w, (counts.get(w) || 0) + 1);
  }
  return Array.from(counts.entries())
    .filter(([, c]) => c >= 4)
    .map(([word]) => word);
}

function detectRambling(text: string): boolean {
  const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 0);
  if (sentences.length < 3) return false;
  const avgLength = text.length / sentences.length;
  return avgLength > 120;
}

function detectWeakStructure(text: string): boolean {
  const hasIntro = /^(so|well|okay|right|first|let me|i want to)/i.test(text.trim());
  const hasConclusion = /^(so|therefore|in summary|to summarize|ultimately|the key|what i'm saying)/i.test(text.trim());
  const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 0);
  return sentences.length >= 4 && !hasIntro && !hasConclusion;
}

function detectConfidenceDrop(text: string): boolean {
  const hedgeCount = (text.match(HESITATION_RE) || []).length;
  const fillerCount = (text.match(FILLER_RE) || []).length;
  return hedgeCount >= 3 || fillerCount >= 5;
}

export async function analyzeWithGemma(transcript: string, recentMessages?: { content: string }[]): Promise<GemmaCoachingResult> {
  const fillerWords = detectFillers(transcript);
  const hesitations = detectHesitations(transcript);
  const repetitivePhrases = detectRepetition(transcript);

  interface LlmCoaching {
    fillerWords: string[];
    hesitations: string[];
    ramble: boolean;
    weakStructure: boolean;
    confidenceDrop: boolean;
    repetitivePhrases: string[];
    positiveHighlights: string[];
    suggestion: string;
  }
  let llmResult: LlmCoaching | null = null;
  let engine: GemmaEngine = "heuristic";

  // Engine order is a privacy ladder: local Gemma first (transcript stays on the machine),
  // then Sarvam as a hosted lift, then pure heuristics - coaching never blocks the session.
  const parse = { parse: (v: unknown) => v as LlmCoaching };
  const userPrompt = gemmaCoachingUserPrompt(transcript, recentMessages);
  if (gemmaConfigured()) {
    try {
      llmResult = extractValidatedJson(await gemmaLocalChat(GEMMA_COACHING_SYSTEM, userPrompt), parse);
      engine = "gemma-local";
    } catch (e) {
      log.warn("local gemma analysis failed, falling back", { error: (e as Error).message });
    }
  }
  if (!llmResult && sarvamConfigured()) {
    try {
      llmResult = extractValidatedJson(
        await sarvamChat(GEMMA_COACHING_SYSTEM, userPrompt, { temperature: 0.2, maxTokens: 800 }),
        parse
      );
      engine = "sarvam";
    } catch {
      log.warn("gemma llm analysis skipped, using heuristic-only");
    }
  }

  const ramble = llmResult?.ramble ?? detectRambling(transcript);
  const weakStructure = llmResult?.weakStructure ?? detectWeakStructure(transcript);
  const confidenceDrop = llmResult?.confidenceDrop ?? detectConfidenceDrop(transcript);
  const positiveHighlights = llmResult?.positiveHighlights ?? [];
  const suggestion = llmResult?.suggestion || "Keep going. Try to slow down slightly and structure your answer with a clear opening.";

  const coachingEvents: CoachingEvent[] = [];

  for (const f of fillerWords) {
    coachingEvents.push({
      type: "filler",
      text: `Filler word: "${f}"`,
      timestamp: Date.now(),
      suggestion: `Try pausing instead of saying "${f}".`,
    });
  }
  if (ramble) {
    coachingEvents.push({
      type: "ramble",
      text: "Response was quite long and could lose the listener.",
      timestamp: Date.now(),
      suggestion: "Try to structure your answer in 2-3 concise points.",
    });
  }
  if (weakStructure) {
    coachingEvents.push({
      type: "weak-structure",
      text: "Answer lacked a clear structure.",
      timestamp: Date.now(),
      suggestion: "Start with your main point, then give an example, then summarize.",
    });
  }
  if (confidenceDrop) {
    coachingEvents.push({
      type: "confidence-drop",
      text: "Hesitation markers detected.",
      timestamp: Date.now(),
      suggestion: "Own your expertise. Use 'I did X' instead of 'I think I did X'.",
    });
  }
  for (const p of repetitivePhrases) {
    coachingEvents.push({
      type: "repetition",
      text: `Repeated phrase: "${p}"`,
      timestamp: Date.now(),
      suggestion: `Vary your language instead of repeating "${p}".`,
    });
  }
  for (const h of positiveHighlights.slice(0, 3)) {
    coachingEvents.push({
      type: "positive",
      text: h,
      timestamp: Date.now(),
    });
  }

  return {
    fillerWords: [...new Set([...fillerWords, ...(llmResult?.fillerWords || [])])],
    hesitations: [...new Set([...hesitations, ...(llmResult?.hesitations || [])])],
    ramble,
    weakStructure,
    confidenceDrop,
    repetitivePhrases: [...new Set([...repetitivePhrases, ...(llmResult?.repetitivePhrases || [])])],
    positiveHighlights,
    suggestion,
    coachingEvents,
    engine,
  };
}
