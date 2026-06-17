import { z } from "zod";

/**
 * Centralized, validated environment configuration.
 *
 * Every environment variable the server depends on is declared and parsed here exactly once,
 * so a misconfiguration surfaces as a single clear error instead of undefined-behaviour deep
 * inside a request handler. Import `env` anywhere you need a value.
 *
 * Production posture is controlled by `DEMO_MODE`:
 *   - DEMO_MODE=false (default): external dependencies (Sarvam, chain, IPFS) must be configured.
 *     When a dependency fails at runtime the API responds with an honest error status, never
 *     fabricated data.
 *   - DEMO_MODE=true: the app degrades to clearly-labelled mock data so it can be demoed without
 *     any third-party credentials. Never enable this in production.
 */

const truthy = (v: string | undefined, fallback = false): boolean => {
  if (v === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());
};

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  // Behaviour
  DEMO_MODE: z.string().optional(),

  // Sarvam AI
  SARVAM_API_KEY: z.string().optional(),
  SARVAM_CHAT_MODEL: z.string().default("sarvam-105b"),
  SARVAM_REASONING_EFFORT: z.string().default("low"),
  // Per-request max_tokens ceiling enforced by the Sarvam subscription tier. The starter tier
  // caps sarvam-105b at 4096 and 400s any request above it, so every chat call is clamped to this
  // value. Raise it (or set it from the dashboard limit) after upgrading the plan.
  SARVAM_MAX_TOKENS: z.coerce.number().int().positive().default(4096),
  SARVAM_TTS_MODEL: z.string().default("bulbul:v2"),
  SARVAM_TTS_SPEAKER: z.string().default("anushka"),

  // Multi-agent evaluation (L3 judge panel + L4 aggregation). Defaults keep behaviour and cost
  // predictable: panel ON, one sample per judge. Raise EVAL_PANEL_SAMPLES to average more runs
  // per judge (sampling+averaging correlates best with human judgement, arXiv:2506.13639) at
  // linear cost. EVAL_VERIFY_LAYERS gates the L1 extraction verifier and L2 question adversary.
  EVAL_PANEL: z.string().optional(), // default true
  EVAL_PANEL_SAMPLES: z.coerce.number().int().min(1).max(7).default(1),
  EVAL_CONFIDENCE_MIN: z.coerce.number().int().min(0).max(100).default(50),
  EVAL_VERIFY_LAYERS: z.string().optional(), // default true

  // Chain
  MONAD_RPC_URL: z.string().url().optional(),
  DEPLOYER_PRIVATE_KEY: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/, "DEPLOYER_PRIVATE_KEY must be a 0x-prefixed 32-byte hex string")
    .optional(),
  NEXT_PUBLIC_CHAIN_ID: z.coerce.number().int().positive().default(143),
  NEXT_PUBLIC_REGISTRY_ADDRESS: z.string().optional(),
  NEXT_PUBLIC_PASSPORT_ADDRESS: z.string().optional(),
  NEXT_PUBLIC_GATE_ADDRESS: z.string().optional(),
  NEXT_PUBLIC_EXPLORER_URL: z.string().url().default("https://testnet.monadexplorer.com"),

  // IPFS
  PINATA_JWT: z.string().optional(),

  // Auth, required to call the wallet-spending mint endpoint outside demo mode.
  MINT_API_SECRET: z.string().min(16).optional(),

  // Limits / tuning (all optional with safe defaults)
  MAX_RESUME_BYTES: z.coerce.number().int().positive().default(10 * 1024 * 1024), // 10 MB
  MAX_AUDIO_BYTES: z.coerce.number().int().positive().default(25 * 1024 * 1024), // 25 MB
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(30),
});

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  // Fail fast and loud on boot for a genuinely invalid configuration.
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

const raw = parsed.data;

export const env = {
  ...raw,
  isProduction: raw.NODE_ENV === "production",
  isTest: raw.NODE_ENV === "test",
  // Demo mode defaults OFF (production posture). Opt in explicitly.
  DEMO_MODE: truthy(raw.DEMO_MODE, false),
  // Multi-agent toggles default ON; opt out explicitly to fall back to single-judge evaluation.
  EVAL_PANEL: truthy(raw.EVAL_PANEL, true),
  EVAL_VERIFY_LAYERS: truthy(raw.EVAL_VERIFY_LAYERS, true),
};

export type Env = typeof env;

/** True when Sarvam AI calls can actually be made. */
export function sarvamConfigured(): boolean {
  return Boolean(env.SARVAM_API_KEY && env.SARVAM_API_KEY.length > 0);
}

/** True when the server can submit on-chain transactions. */
export function chainConfigured(): boolean {
  return Boolean(
    env.DEPLOYER_PRIVATE_KEY &&
      env.NEXT_PUBLIC_REGISTRY_ADDRESS &&
      env.NEXT_PUBLIC_PASSPORT_ADDRESS
  );
}

/** True when IPFS pinning is configured. */
export function ipfsConfigured(): boolean {
  return Boolean(env.PINATA_JWT && env.PINATA_JWT.length > 0);
}
