/**
 * Runs every case in `./fixtures.ts` (or a caller-supplied set) through the six metrics in
 * `./metrics.ts` and produces a `BenchmarkReport`. See `./README.md` for how to wire in a real
 * pipeline call and a real relevance judge once credentials/audio are available — both are
 * injectable here specifically so that swap-in requires no change to this file.
 */

import { BENCHMARK_CASES } from "./fixtures";
import {
  humanAgreement,
  measureLatency,
  scoreFollowUpQuality,
  scoreQuestionRelevance,
  sttAccuracy,
  technicalTermAccuracy,
  type RelevanceJudge,
} from "./metrics";
import type { BenchmarkCase, BenchmarkCategory, BenchmarkReport, CaseResult, CategorySummary } from "./types";

export interface RunBenchmarksOptions {
  /** Defaults to `BENCHMARK_CASES` (all ten categories). */
  cases?: BenchmarkCase[];
  /** Optional LLM-as-judge for question relevance / follow-up quality — see `./metrics.ts`.
   *  Defaults to the deterministic keyword-overlap heuristic when omitted. */
  relevanceJudge?: RelevanceJudge;
  /**
   * What `latencyMs` actually measures. Defaults to a fast no-op, so `latencyMs` reflects harness
   * overhead only — meaningless as a real latency number until this is replaced with an actual
   * STT/LLM/TTS round trip (e.g. via `SarvamRealtimeSTT`/`ConversationEngine`/`BulbulV3TTSProvider`).
   * See `./README.md`.
   */
  simulateTurn?: (benchmarkCase: BenchmarkCase) => Promise<void>;
}

async function defaultSimulateTurn(): Promise<void> {
  // Intentionally empty — see `simulateTurn` above.
}

function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, v) => sum + v, 0) / values.length;
}

function summarizeByCategory(results: CaseResult[]): Partial<Record<BenchmarkCategory, CategorySummary>> {
  const groups = new Map<BenchmarkCategory, CaseResult[]>();
  for (const result of results) {
    const list = groups.get(result.category) ?? [];
    list.push(result);
    groups.set(result.category, list);
  }

  const summary: Partial<Record<BenchmarkCategory, CategorySummary>> = {};
  for (const [category, list] of groups) {
    summary[category] = {
      count: list.length,
      avgSttAccuracy: average(list.map((r) => r.sttAccuracy)),
      avgTechnicalTermRecall: average(list.map((r) => r.technicalTermRecall)),
      avgLatencyMs: average(list.map((r) => r.latencyMs)),
      avgQuestionRelevance: average(list.map((r) => r.questionRelevance)),
      avgFollowUpQuality: average(list.map((r) => r.followUpQuality)),
    };
  }
  return summary;
}

export async function runBenchmarks(opts: RunBenchmarksOptions = {}): Promise<BenchmarkReport> {
  const cases = opts.cases ?? BENCHMARK_CASES;
  const simulateTurn = opts.simulateTurn ?? defaultSimulateTurn;

  const results: CaseResult[] = [];
  for (const benchmarkCase of cases) {
    const { ms: latencyMs } = await measureLatency(() => simulateTurn(benchmarkCase));

    const accuracy = sttAccuracy(benchmarkCase.referenceTranscript, benchmarkCase.sttHypothesis);
    const { recall, missedTerms } = technicalTermAccuracy(benchmarkCase.sttHypothesis, benchmarkCase.expectedTechnicalTerms);

    const questionRelevance = await scoreQuestionRelevance(
      { question: benchmarkCase.question, topic: benchmarkCase.topic, answerContext: benchmarkCase.referenceTranscript },
      opts.relevanceJudge
    );
    const followUpQuality = await scoreFollowUpQuality(
      { followUp: benchmarkCase.followUp, answerContext: benchmarkCase.referenceTranscript, topic: benchmarkCase.topic },
      opts.relevanceJudge
    );

    results.push({
      id: benchmarkCase.id,
      category: benchmarkCase.category,
      sttAccuracy: accuracy,
      technicalTermRecall: recall,
      missedTechnicalTerms: missedTerms,
      latencyMs,
      questionRelevance,
      followUpQuality,
    });
  }

  return {
    cases: results,
    byCategory: summarizeByCategory(results),
    humanAgreement: humanAgreement(cases.map((c) => ({ human: c.humanScore, automated: c.automatedScore }))),
  };
}
