import { env } from "./env";

/**
 * Lightweight in-memory fixed-window rate limiter.
 *
 * Keyed by client identity (IP + route). This protects the unauthenticated, paid-LLM and
 * gas-spending endpoints from trivial cost-amplification and abuse.
 *
 * NOTE: in-memory state is per-process. It is effective for a single instance or modest
 * deployments, but a horizontally-scaled deployment should back this with a shared store
 * (e.g. Upstash Redis / Vercel KV). The interface is intentionally tiny so it can be swapped.
 */

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

export interface RateLimitResult {
  ok: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
  retryAfterSec: number;
}

export function rateLimit(
  key: string,
  opts: { max?: number; windowMs?: number } = {}
): RateLimitResult {
  const max = opts.max ?? env.RATE_LIMIT_MAX;
  const windowMs = opts.windowMs ?? env.RATE_LIMIT_WINDOW_MS;
  const now = Date.now();

  let bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + windowMs };
    buckets.set(key, bucket);
  }

  bucket.count += 1;
  const remaining = Math.max(0, max - bucket.count);
  const ok = bucket.count <= max;

  // Opportunistic cleanup so the map cannot grow unbounded under churn.
  if (buckets.size > 10_000) {
    for (const [k, b] of buckets) {
      if (b.resetAt <= now) buckets.delete(k);
    }
  }

  return {
    ok,
    limit: max,
    remaining,
    resetAt: bucket.resetAt,
    retryAfterSec: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
  };
}

/** Best-effort client identifier from standard proxy headers. */
export function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return req.headers.get("x-real-ip") || "unknown";
}

/** Test-only: clear all buckets. */
export function __resetRateLimitStore() {
  buckets.clear();
}
