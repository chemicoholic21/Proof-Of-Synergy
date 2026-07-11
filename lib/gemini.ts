import { env, geminiConfigured } from "./env";
import { logger } from "./logger";

export { geminiConfigured };

const log = logger.child({ module: "gemini" });

let activeCalls = 0;
const chatQueue: Array<() => void> = [];

async function withChatSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (activeCalls >= 4) {
    await new Promise<void>((resolve) => chatQueue.push(resolve));
  }
  activeCalls++;
  try {
    return await fn();
  } finally {
    activeCalls--;
    chatQueue.shift()?.();
  }
}

async function fetchWithTimeout(url: string, init: RequestInit, ms = 45000): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      throw new Error(`Gemini request timed out after ${ms}ms`);
    }
    throw e;
  } finally {
    clearTimeout(t);
  }
}

export async function geminiChat(
  system: string,
  user: string,
  opts?: { temperature?: number; maxTokens?: number }
): Promise<string> {
  if (!geminiConfigured()) throw new Error("GEMINI_API_KEY not set");
  return withChatSlot(async () => {
    try {
      const mod = await import("@google/generative-ai");
      const genAI = new mod.GoogleGenerativeAI(env.GEMINI_API_KEY || "");
      const model = genAI.getGenerativeModel({
        model: env.GEMINI_MODEL,
        systemInstruction: system,
        generationConfig: {
          temperature: opts?.temperature ?? 0.7,
          maxOutputTokens: opts?.maxTokens ?? 800,
        },
      });
      const result = await model.generateContent(user);
      const text = result.response.text();
      if (!text) throw new Error("Empty Gemini response");
      return text;
    } catch (e) {
      log.warn("gemini chat failed", { error: (e as Error).message });
      throw e;
    }
  });
}

/** Liveness probe used by /api/health so a silent fallback can't hide during a demo. */
export async function geminiPing(): Promise<{ ok: boolean; status: number | null }> {
  if (!geminiConfigured()) return { ok: false, status: null };
  try {
    const mod = await import("@google/generative-ai");
    const genAI = new mod.GoogleGenerativeAI(env.GEMINI_API_KEY || "");
    const model = genAI.getGenerativeModel({ model: env.GEMINI_MODEL });
    const result = await model.generateContent("Reply with the single word: pong");
    const text = result.response.text();
    return { ok: Boolean(text && text.trim()), status: 200 };
  } catch (e) {
    log.warn("gemini ping failed", { error: (e as Error).message });
    return { ok: false, status: null };
  }
}
