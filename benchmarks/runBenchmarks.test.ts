import { describe, it, expect } from "vitest";
import { runBenchmarks } from "./runBenchmarks";
import { BENCHMARK_CASES } from "./fixtures";
import { BENCHMARK_CATEGORIES } from "./types";

describe("runBenchmarks", () => {
  it("covers all ten benchmark categories in the built-in fixtures", () => {
    const covered = new Set(BENCHMARK_CASES.map((c) => c.category));
    for (const category of BENCHMARK_CATEGORIES) {
      expect(covered.has(category)).toBe(true);
    }
  });

  it("produces one CaseResult per input case, in order", async () => {
    const report = await runBenchmarks();
    expect(report.cases).toHaveLength(BENCHMARK_CASES.length);
    expect(report.cases.map((r) => r.id)).toEqual(BENCHMARK_CASES.map((c) => c.id));
  });

  it("every metric on every case result is a finite number in its expected range", async () => {
    const report = await runBenchmarks();
    for (const result of report.cases) {
      expect(Number.isFinite(result.sttAccuracy)).toBe(true);
      expect(result.sttAccuracy).toBeGreaterThanOrEqual(0);
      expect(result.sttAccuracy).toBeLessThanOrEqual(1);

      expect(Number.isFinite(result.technicalTermRecall)).toBe(true);
      expect(result.technicalTermRecall).toBeGreaterThanOrEqual(0);
      expect(result.technicalTermRecall).toBeLessThanOrEqual(1);
      expect(Array.isArray(result.missedTechnicalTerms)).toBe(true);

      expect(Number.isFinite(result.latencyMs)).toBe(true);
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);

      expect(Number.isFinite(result.questionRelevance)).toBe(true);
      expect(result.questionRelevance).toBeGreaterThanOrEqual(0);
      expect(result.questionRelevance).toBeLessThanOrEqual(10);

      expect(Number.isFinite(result.followUpQuality)).toBe(true);
      expect(result.followUpQuality).toBeGreaterThanOrEqual(0);
      expect(result.followUpQuality).toBeLessThanOrEqual(10);
    }
  });

  it("the clean-audio case scores perfect STT accuracy (it is, by construction, a perfect transcript)", async () => {
    const report = await runBenchmarks();
    const clean = report.cases.find((r) => r.id === "clean-audio-1");
    expect(clean?.sttAccuracy).toBe(1);
  });

  it("the technical-vocabulary case surfaces at least one missed term, reflecting its garbled hypothesis", async () => {
    const report = await runBenchmarks();
    const technical = report.cases.find((r) => r.id === "technical-vocabulary-1");
    expect(technical?.technicalTermRecall).toBeLessThan(1);
    expect(technical?.missedTechnicalTerms.length).toBeGreaterThan(0);
  });

  it("summarizes results by category with the right per-category count", async () => {
    const report = await runBenchmarks();
    for (const category of BENCHMARK_CATEGORIES) {
      const summary = report.byCategory[category];
      expect(summary).toBeDefined();
      expect(summary!.count).toBe(BENCHMARK_CASES.filter((c) => c.category === category).length);
      expect(Number.isFinite(summary!.avgSttAccuracy)).toBe(true);
      expect(Number.isFinite(summary!.avgLatencyMs)).toBe(true);
    }
  });

  it("computes human/automated agreement across all cases", async () => {
    const report = await runBenchmarks();
    expect(Number.isFinite(report.humanAgreement.meanAbsoluteError)).toBe(true);
    expect(Number.isFinite(report.humanAgreement.pearsonCorrelation)).toBe(true);
    expect(report.humanAgreement.exactAgreementRate).toBeGreaterThanOrEqual(0);
    expect(report.humanAgreement.exactAgreementRate).toBeLessThanOrEqual(1);
  });

  it("accepts a caller-supplied subset of cases instead of the full fixture set", async () => {
    const subset = BENCHMARK_CASES.filter((c) => c.category === "CLEAN_AUDIO");
    const report = await runBenchmarks({ cases: subset });
    expect(report.cases).toHaveLength(subset.length);
    expect(Object.keys(report.byCategory)).toEqual(["CLEAN_AUDIO"]);
  });

  it("uses an injected relevanceJudge for both relevance and quality scoring when given", async () => {
    const report = await runBenchmarks({
      cases: [BENCHMARK_CASES[0]],
      relevanceJudge: async () => 3,
    });
    expect(report.cases[0].questionRelevance).toBe(3);
    expect(report.cases[0].followUpQuality).toBe(3);
  });

  it("times whatever simulateTurn is given, defaulting to near-zero harness overhead", async () => {
    let called = 0;
    const report = await runBenchmarks({
      cases: [BENCHMARK_CASES[0]],
      simulateTurn: async () => {
        called++;
        await new Promise((resolve) => setTimeout(resolve, 15));
      },
    });
    expect(called).toBe(1);
    expect(report.cases[0].latencyMs).toBeGreaterThanOrEqual(14);
  });
});
