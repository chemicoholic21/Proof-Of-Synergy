import { env, geminiConfigured } from "./env";
import { logger } from "./logger";

export { geminiConfigured };

const log = logger.child({ module: "gemini" });

/**
 * Model resolution: try the configured model first, then fall back through stable releases.
 * Google retires experimental/preview model ids (e.g. gemini-2.0-flash-exp) without warning,
 * which surfaced as instant 404s -> 502 for every conversation turn. The first model that
 * answers is cached for the life of the process so dead ids aren't retried on every call.
 */
const FALLBACK_MODELS = ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-1.5-flash"];
let workingModel: string | null = null;

/** The model id that actually answered the last successful call (null before the first one).
 *  Surfaced in /api/gemini responses and /api/health so a fallback is always observable -
 *  e.g. a `-live`-only model id (Live API / bidiGenerateContent) can't silently masquerade
 *  as the model in use. */
export function resolvedGeminiModel(): string | null {
  return workingModel;
}

function candidateModels(): string[] {
  const configured = env.GEMINI_MODEL;
  const chain = [configured, ...FALLBACK_MODELS.filter((m) => m !== configured)];
  if (workingModel) return [workingModel, ...chain.filter((m) => m !== workingModel)];
  return chain;
}

/** Errors that mean "this model id doesn't exist / isn't served anymore" - safe to try the next. */
function isModelUnavailable(e: unknown): boolean {
  const msg = (e as Error)?.message?.toLowerCase() ?? "";
  return (
    msg.includes("not found") ||
    msg.includes("404") ||
    msg.includes("deprecated") ||
    msg.includes("is not supported") ||
    msg.includes("permission_denied")
  );
}

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

async function generateOnce(
  modelId: string,
  system: string,
  user: string,
  opts?: { temperature?: number; maxTokens?: number }
): Promise<string> {
  const mod = await import("@google/generative-ai");
  const genAI = new mod.GoogleGenerativeAI(env.GEMINI_API_KEY || "");
  const model = genAI.getGenerativeModel({
    model: modelId,
    systemInstruction: system,
    generationConfig: {
      temperature: opts?.temperature ?? 0.7,
      maxOutputTokens: opts?.maxTokens ?? 800,
    },
  });
  const result = await model.generateContent(user);
  const text = result.response.text();
  if (!text) throw new Error(`Empty Gemini response (model=${modelId})`);
  return text;
}

export async function geminiChat(
  system: string,
  user: string,
  opts?: { temperature?: number; maxTokens?: number }
): Promise<string> {
  if (!geminiConfigured()) throw new Error("GEMINI_API_KEY not set");
  return withChatSlot(async () => {
    let lastError: Error = new Error("No Gemini model available");
    for (const modelId of candidateModels()) {
      try {
        const text = await generateOnce(modelId, system, user, opts);
        if (workingModel !== modelId) {
          workingModel = modelId;
          log.info("gemini model resolved", { model: modelId });
        }
        return text;
      } catch (e) {
        lastError = e as Error;
        if (!isModelUnavailable(e)) {
          // Auth/quota/network problems won't be fixed by a different model id - fail honestly.
          log.warn("gemini chat failed", { model: modelId, error: lastError.message });
          throw lastError;
        }
        log.warn("gemini model unavailable, trying next", { model: modelId, error: lastError.message });
      }
    }
    throw lastError;
  });
}

/** Liveness probe used by /api/health so a silent fallback can't hide during a demo. */
export async function geminiPing(): Promise<{ ok: boolean; status: number | null }> {
  if (!geminiConfigured()) return { ok: false, status: null };
  try {
    const text = await geminiChat("You are a health check.", "Reply with the single word: pong", {
      temperature: 0,
      maxTokens: 10,
    });
    return { ok: Boolean(text && text.trim()), status: 200 };
  } catch (e) {
    log.warn("gemini ping failed", { error: (e as Error).message });
    return { ok: false, status: null };
  }
}
