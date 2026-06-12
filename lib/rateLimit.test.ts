import { describe, it, expect, beforeEach } from "vitest";
import { rateLimit, __resetRateLimitStore } from "./rateLimit";

describe("rateLimit", () => {
  beforeEach(() => __resetRateLimitStore());

  it("allows requests up to the limit, then blocks", () => {
    const opts = { max: 3, windowMs: 60_000 };
    expect(rateLimit("k", opts).ok).toBe(true);
    expect(rateLimit("k", opts).ok).toBe(true);
    expect(rateLimit("k", opts).ok).toBe(true);
    const blocked = rateLimit("k", opts);
    expect(blocked.ok).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
  });

  it("tracks different keys independently", () => {
    const opts = { max: 1, windowMs: 60_000 };
    expect(rateLimit("a", opts).ok).toBe(true);
    expect(rateLimit("b", opts).ok).toBe(true);
    expect(rateLimit("a", opts).ok).toBe(false);
  });

  it("resets after the window elapses", () => {
    const opts = { max: 1, windowMs: 1 };
    expect(rateLimit("w", opts).ok).toBe(true);
    expect(rateLimit("w", opts).ok).toBe(false);
    // Busy-wait a hair past the 1ms window.
    const until = Date.now() + 5;
    while (Date.now() < until) {
      /* spin */
    }
    expect(rateLimit("w", opts).ok).toBe(true);
  });
});
