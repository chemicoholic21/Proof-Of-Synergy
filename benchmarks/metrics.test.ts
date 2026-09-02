import { describe, it, expect } from "vitest";
import {
  wordErrorRate,
  sttAccuracy,
  technicalTermAccuracy,
  measureLatency,
  summarizeLatencies,
  scoreQuestionRelevance,
  scoreFollowUpQuality,
  humanAgreement,
} from "./metrics";

describe("wordErrorRate / sttAccuracy", () => {
  it("is 0 (perfect accuracy) for an identical transcript, punctuation/case aside", () => {
    expect(wordErrorRate("I used Redis for caching.", "i used redis for caching")).toBe(0);
    expect(sttAccuracy("I used Redis for caching.", "i used redis for caching")).toBe(1);
  });

  it("counts one substitution correctly", () => {
    // "redis" -> "reddit" is one substitution out of 5 reference words.
    expect(wordErrorRate("I used redis for caching", "I used reddit for caching")).toBeCloseTo(1 / 5);
  });

  it("counts a deletion (a dropped word) correctly", () => {
    // reference has 5 words, hypothesis drops "for" -> 1 deletion.
    expect(wordErrorRate("I used redis for caching", "I used redis caching")).toBeCloseTo(1 / 5);
  });

  it("counts an insertion (an extra word) correctly", () => {
    expect(wordErrorRate("I used redis", "I really used redis")).toBeCloseTo(1 / 3);
  });

  it("returns WER 1 for an empty hypothesis against a non-empty reference", () => {
    expect(wordErrorRate("hello world", "")).toBe(1);
    expect(sttAccuracy("hello world", "")).toBe(0);
  });

  it("treats two empty transcripts as a perfect match", () => {
    expect(wordErrorRate("", "")).toBe(0);
  });

  it("returns WER 1 (not a division by zero) when the reference is empty but the hypothesis isn't", () => {
    expect(wordErrorRate("", "unexpected noise")).toBe(1);
  });

  it("floors accuracy at 0 rather than going negative for a very wrong hypothesis", () => {
    expect(sttAccuracy("a", "completely different words entirely here")).toBe(0);
  });
});

describe("technicalTermAccuracy", () => {
  it("returns full recall when every expected term is present", () => {
    const result = technicalTermAccuracy("I used Redis and PostgreSQL together.", ["Redis", "PostgreSQL"]);
    expect(result).toEqual({ recall: 1, missedTerms: [] });
  });

  it("reports partial recall and lists exactly the missed terms", () => {
    const result = technicalTermAccuracy("I used reddit and post gre sql.", ["Redis", "PostgreSQL"]);
    expect(result.recall).toBe(0);
    expect(result.missedTerms).toEqual(["Redis", "PostgreSQL"]);
  });

  it("matches case-insensitively", () => {
    expect(technicalTermAccuracy("i used REDIS", ["redis"]).recall).toBe(1);
  });

  it("does not match a term as a substring of an unrelated word", () => {
    // "SQL" should not be considered present just because "sqlite" (a different technology)
    // contains the letters "sql".
    const result = technicalTermAccuracy("I used sqlite for local storage.", ["SQL"]);
    expect(result.recall).toBe(0);
    expect(result.missedTerms).toEqual(["SQL"]);
  });

  it("returns full recall (nothing to lose) when there are no expected terms", () => {
    expect(technicalTermAccuracy("anything at all", [])).toEqual({ recall: 1, missedTerms: [] });
  });
});

describe("measureLatency / summarizeLatencies", () => {
  it("measures roughly how long an async call takes", async () => {
    const { result, ms } = await measureLatency(() => new Promise<string>((resolve) => setTimeout(() => resolve("done"), 10)));
    expect(result).toBe("done");
    expect(ms).toBeGreaterThanOrEqual(9); // allow a hair of scheduling slack below the nominal 10ms
  });

  it("propagates a rejection instead of swallowing it", async () => {
    await expect(measureLatency(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
  });

  it("computes p50/p95/max/mean over a batch of values", () => {
    const summary = summarizeLatencies([100, 200, 300, 400, 500]);
    expect(summary.max).toBe(500);
    expect(summary.mean).toBe(300);
    expect(summary.p50).toBe(300); // the median of 5 sorted values
    expect(summary.p95).toBe(500);
  });

  it("returns all zeros for an empty batch rather than dividing by zero", () => {
    expect(summarizeLatencies([])).toEqual({ p50: 0, p95: 0, max: 0, mean: 0 });
  });
});

describe("scoreQuestionRelevance / scoreFollowUpQuality — heuristic fallback", () => {
  it("scores a question sharing words with the topic/answer higher than an unrelated one", async () => {
    const relevant = await scoreQuestionRelevance({
      question: "How did you choose Redis for caching?",
      topic: "caching",
      answerContext: "I used Redis for caching to reduce database load.",
    });
    const irrelevant = await scoreQuestionRelevance({
      question: "What's your favorite programming language overall?",
      topic: "caching",
      answerContext: "I used Redis for caching to reduce database load.",
    });
    expect(relevant).toBeGreaterThan(irrelevant);
  });

  it("scores a follow-up that references specifics from the answer higher than a generic one", async () => {
    const specific = await scoreFollowUpQuality({
      followUp: "How did you handle cache invalidation with Redis?",
      answerContext: "I used Redis for caching with a write-through strategy and cache invalidation on writes.",
      topic: "caching",
    });
    const generic = await scoreFollowUpQuality({
      followUp: "Can you tell me more about that?",
      answerContext: "I used Redis for caching with a write-through strategy and cache invalidation on writes.",
      topic: "caching",
    });
    expect(specific).toBeGreaterThan(generic);
  });

  it("uses an injected judge instead of the heuristic when one is given", async () => {
    const judge = async () => 4.2;
    expect(await scoreQuestionRelevance({ question: "x", topic: "y", answerContext: "z" }, judge)).toBe(4.2);
    expect(await scoreFollowUpQuality({ followUp: "x", answerContext: "y", topic: "z" }, judge)).toBe(4.2);
  });
});

describe("humanAgreement", () => {
  it("reports zero error and perfect correlation for identical score sets", () => {
    const pairs = [
      { human: 8, automated: 8 },
      { human: 5, automated: 5 },
      { human: 9, automated: 9 },
    ];
    const result = humanAgreement(pairs);
    expect(result.meanAbsoluteError).toBe(0);
    expect(result.pearsonCorrelation).toBeCloseTo(1);
    expect(result.exactAgreementRate).toBe(1);
  });

  it("computes mean absolute error and exact-agreement rate correctly", () => {
    const pairs = [
      { human: 8, automated: 7 }, // diff 1 - within tolerance
      { human: 5, automated: 8 }, // diff 3 - not within tolerance
    ];
    const result = humanAgreement(pairs);
    expect(result.meanAbsoluteError).toBe(2); // (1 + 3) / 2
    expect(result.exactAgreementRate).toBe(0.5);
  });

  it("reports a negative correlation for inversely related score sets", () => {
    const pairs = [
      { human: 1, automated: 9 },
      { human: 5, automated: 5 },
      { human: 9, automated: 1 },
    ];
    expect(humanAgreement(pairs).pearsonCorrelation).toBeLessThan(0);
  });

  it("does not produce NaN when every score is identical (zero variance)", () => {
    const pairs = [
      { human: 7, automated: 7 },
      { human: 7, automated: 7 },
    ];
    expect(humanAgreement(pairs).pearsonCorrelation).toBe(0);
  });

  it("returns zeros for an empty pair list", () => {
    expect(humanAgreement([])).toEqual({ meanAbsoluteError: 0, pearsonCorrelation: 0, exactAgreementRate: 0 });
  });
});
