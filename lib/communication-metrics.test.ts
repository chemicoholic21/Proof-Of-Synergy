import { describe, expect, it } from "vitest";
import { extractDNA } from "./communication-metrics";

describe("communication metrics", () => {
  it("counts fillers and hedges and lowers confidence for hesitant speech", () => {
    const hesitant = extractDNA(
      "Um, so like, I think we basically, you know, maybe did something. Um, I guess it kind of worked, you know."
    );
    expect(hesitant.fillerCount).toBeGreaterThan(3);
    expect(hesitant.hedgeCount).toBeGreaterThan(1);
    const confident = extractDNA(
      "I built the payments service and I designed its retry pipeline. We shipped it in production and I led the rollout across three regions with zero downtime."
    );
    expect(confident.confidence).toBeGreaterThan(hesitant.confidence);
    expect(confident.confidenceMarkers).toBeGreaterThan(0);
  });

  it("computes speech rate from duration", () => {
    const m = extractDNA("one two three four five six seven eight nine ten", 30);
    expect(m.wordCount).toBe(10);
    expect(m.speechRateWpm).toBe(20);
    expect(extractDNA("hello world").speechRateWpm).toBeNull();
  });

  it("handles empty input without crashing", () => {
    const m = extractDNA("");
    expect(m.wordCount).toBe(0);
    expect(m.fillerCount).toBe(0);
    expect(m.topFillers).toEqual([]);
  });
});
