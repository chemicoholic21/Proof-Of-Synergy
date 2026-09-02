/**
 * Shared types for the voice interview benchmark suite (see `./README.md` for scope and how to
 * run it). Kept dependency-free from the rest of the app on purpose — a benchmark harness should
 * be able to evolve its own fixture/report shapes without coupling to `lib/`'s internal types.
 */

export const BENCHMARK_CATEGORIES = [
  "CLEAN_AUDIO",
  "NOISY_AUDIO",
  "INDIAN_ENGLISH",
  "HINGLISH",
  "FAST_SPEAKER",
  "SLOW_SPEAKER",
  "TECHNICAL_VOCABULARY",
  "LONG_ANSWER",
  "SHORT_ANSWER",
  "INTERRUPTED_SPEECH",
] as const;

export type BenchmarkCategory = (typeof BENCHMARK_CATEGORIES)[number];

/**
 * One benchmark case: a candidate turn under a specific condition, with the ground truth needed
 * to score every metric in `../metrics.ts` against it.
 *
 * `sttHypothesis` is what an STT engine is taken to have produced for `referenceTranscript` under
 * this case's condition. See `./README.md` for why this is hand-authored rather than the output of
 * a real STT call on a real recording, and how to replace it with one.
 */
export interface BenchmarkCase {
  id: string;
  category: BenchmarkCategory;
  description: string;
  /** Ground truth: what the candidate actually said. */
  referenceTranscript: string;
  /** What STT is taken to have produced for `referenceTranscript` under this case's condition. */
  sttHypothesis: string;
  /** Domain/technical terms `referenceTranscript` actually contains, used to score whether
   *  `sttHypothesis` preserved them. */
  expectedTechnicalTerms: string[];
  /** The question the candidate was answering. */
  question: string;
  /** Short topic label, matching `lib/interview/`'s own convention. */
  topic: string;
  /** The interviewer's generated follow-up question, to be scored for quality/relevance. */
  followUp: string;
  /** A human rater's holistic 0-10 quality score for `followUp` given `referenceTranscript`. */
  humanScore: number;
  /** The automated judge's 0-10 score for the same follow-up — compared against `humanScore` to
   *  compute human/automated agreement. */
  automatedScore: number;
}

export interface CaseResult {
  id: string;
  category: BenchmarkCategory;
  sttAccuracy: number;
  technicalTermRecall: number;
  missedTechnicalTerms: string[];
  latencyMs: number;
  questionRelevance: number;
  followUpQuality: number;
}

export interface CategorySummary {
  count: number;
  avgSttAccuracy: number;
  avgTechnicalTermRecall: number;
  avgLatencyMs: number;
  avgQuestionRelevance: number;
  avgFollowUpQuality: number;
}

export interface HumanAgreementSummary {
  meanAbsoluteError: number;
  pearsonCorrelation: number;
  /** Fraction of cases where `|human - automated| <= 1` (on the shared 0-10 scale). */
  exactAgreementRate: number;
}

export interface BenchmarkReport {
  cases: CaseResult[];
  byCategory: Partial<Record<BenchmarkCategory, CategorySummary>>;
  humanAgreement: HumanAgreementSummary;
}
