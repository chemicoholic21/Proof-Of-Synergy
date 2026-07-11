import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DEMO_MODE: z.string().optional(),

  SARVAM_API_KEY: z.string().optional(),
  SARVAM_CHAT_MODEL: z.string().default("sarvam-105b"),
  SARVAM_REASONING_EFFORT: z.string().default("none"),
  SARVAM_MAX_TOKENS: z.coerce.number().int().positive().default(4096),
  SARVAM_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
  SARVAM_TTS_MODEL: z.string().default("bulbul:v2"),
  SARVAM_TTS_SPEAKER: z.string().default("anushka"),

  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default("gemini-2.0-flash-exp"),

  COGNEE_API_URL: z.string().url().optional(),
  COGNEE_API_KEY: z.string().optional(),
  COGNEE_DATASET: z.string().default("skill-graph"),
  SKILL_GRAPH_DATA_DIR: z.string().optional(),

  MAX_AUDIO_BYTES: z.coerce.number().int().positive().default(25 * 1024 * 1024),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(30),
});

/**
 * Treat empty-string env values as unset so `KEY=` lines in a copied .env file fall back to the
 * schema defaults instead of overriding them (an empty SARVAM_MAX_TOKENS would otherwise coerce
 * to 0 and fail validation at boot).
 */
function withoutEmpty(source: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) {
    if (v !== undefined && v.trim() !== "") out[k] = v;
  }
  return out;
}

const parsed = EnvSchema.safeParse(withoutEmpty(process.env));
if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

const raw = parsed.data;

export const env = {
  ...raw,
  isProduction: raw.NODE_ENV === "production",
  isTest: raw.NODE_ENV === "test",
  DEMO_MODE: (() => {
    if (raw.DEMO_MODE === undefined) return false;
    return ["1", "true", "yes", "on"].includes(raw.DEMO_MODE.trim().toLowerCase());
  })(),
};

export type Env = typeof env;

export function sarvamConfigured(): boolean {
  return Boolean(env.SARVAM_API_KEY && env.SARVAM_API_KEY.length > 0);
}

export function geminiConfigured(): boolean {
  return Boolean(env.GEMINI_API_KEY && env.GEMINI_API_KEY.length > 0);
}

export function cogneeConfigured(): boolean {
  return Boolean(env.COGNEE_API_URL && env.COGNEE_API_KEY);
}
