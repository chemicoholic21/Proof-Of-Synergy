/**
 * The six metric calculations the benchmark suite scores every case on. Each is a small, pure,
 * independently-testable function (see `./metrics.test.ts`) — consistent with the rest of this
 * codebase's preference for deterministic calculation over another model call wherever one
 * suffices (e.g. `lib/interview/ResponsePlanner.ts`, `DifficultyController.ts`).
 *
 * "Question relevance" and "follow-up quality" are inherently subjective, so each accepts an
 * optional pluggable `judge` (e.g. an LLM-as-judge call) and falls back to a deterministic keyword-
 * overlap heuristic when none is given — see `./README.md` for why the heuristic is a stand-in,
 * not a replacement for real judgment.
 */

/** Splits text into lowercase word tokens for comparison — punctuation-insensitive, matching how a
 *  transcript comparison should treat "Redis." and "redis" as the same word. */
function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** Levenshtein edit distance over two word sequences (not characters) — the standard basis for
 *  Word Error Rate. */
function wordEditDistance(a: string[], b: string[]): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (let i = 0; i < rows; i++) dp[i][0] = i;
  for (let j = 0; j < cols; j++) dp[0][j] = j;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }
  return dp[rows - 1][cols - 1];
}

/** Word Error Rate: (substitutions + deletions + insertions) / words in `reference`. `0` for a
 *  perfect match; can exceed `1` if `hypothesis` has far more words than `reference`. */
export function wordErrorRate(reference: string, hypothesis: string): number {
  const ref = words(reference);
  const hyp = words(hypothesis);
  if (ref.length === 0) return hyp.length === 0 ? 0 : 1;
  return wordEditDistance(ref, hyp) / ref.length;
}

/** STT accuracy metric: `1 - WER`, floored at `0` (a WER over 1 still means "0% accurate," not
 *  negative accuracy). */
export function sttAccuracy(reference: string, hypothesis: string): number {
  return Math.max(0, 1 - wordErrorRate(reference, hypothesis));
}

export interface TechnicalTermAccuracyResult {
  /** Fraction of `expectedTerms` actually found in `hypothesis`. `1` when `expectedTerms` is empty
   *  — there was nothing to preserve, so nothing was lost. */
  recall: number;
  missedTerms: string[];
}

/** Whether `term` appears in `text` as a whole word/phrase (case-insensitive), not as a
 *  substring of some unrelated longer word. */
function containsTerm(text: string, term: string): boolean {
  const escaped = term.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!escaped) return false;
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "iu").test(text);
}

/** Technical term accuracy: did STT preserve the domain vocabulary actually present in the
 *  reference, or did jargon get garbled/dropped — the classic STT failure mode this metric exists
 *  to catch, distinct from overall word accuracy (a transcript can have a low WER overall while
 *  still mangling the one term that actually mattered). */
export function technicalTermAccuracy(hypothesis: string, expectedTerms: string[]): TechnicalTermAccuracyResult {
  if (expectedTerms.length === 0) return { recall: 1, missedTerms: [] };
  const missedTerms = expectedTerms.filter((term) => !containsTerm(hypothesis, term));
  return { recall: (expectedTerms.length - missedTerms.length) / expectedTerms.length, missedTerms };
}

/** Times one async call. A thin wrapper, not a metric by itself — `summarizeLatencies()` below
 *  turns a batch of these into the aggregate numbers a benchmark report actually wants. */
export async function measureLatency<T>(fn: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const start = Date.now();
  const result = await fn();
  return { result, ms: Date.now() - start };
}

export interface LatencySummary {
  p50: number;
  p95: number;
  max: number;
  mean: number;
}

/** Aggregate latency statistics over a batch of measured calls. `p50`/`p95` are nearest-rank
 *  percentiles over the sorted values — not interpolated, so a small sample's percentile is always
 *  one of the actual observed values, never a value nothing actually measured. */
export function summarizeLatencies(msValues: number[]): LatencySummary {
  if (msValues.length === 0) return { p50: 0, p95: 0, max: 0, mean: 0 };
  const sorted = [...msValues].sort((a, b) => a - b);
  const percentile = (p: number) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
  return {
    p50: percentile(50),
    p95: percentile(95),
    max: sorted[sorted.length - 1],
    mean: sorted.reduce((sum, v) => sum + v, 0) / sorted.length,
  };
}

export interface RelevanceJudgeInput {
  question: string;
  topic: string;
  /** The candidate's answer the question/follow-up is responding to. */
  answerContext: string;
}

/** A pluggable quality judge — e.g. an LLM-as-judge call — scoring 0-10. Both `questionRelevance`
 *  and `followUpQuality` below accept one and fall back to a deterministic heuristic without it. */
export type RelevanceJudge = (input: RelevanceJudgeInput) => Promise<number>;

/**
 * Deterministic fallback scorer: word-overlap between the question/follow-up and its topic/answer
 * context, scaled to 0-10. This is a crude proxy for "is this on-topic," not a substitute for real
 * judgment (a well-worded but generic follow-up can score as high as a sharp, specific one) — see
 * `./README.md`. It exists so the benchmark suite produces a real, reproducible number with zero
 * external dependencies when no `judge` is configured, rather than skipping the metric outright.
 */
function heuristicOverlapScore(a: string, b: string): number {
  const wordsA = new Set(words(a));
  const wordsB = new Set(words(b));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let overlap = 0;
  for (const w of wordsA) if (wordsB.has(w)) overlap++;
  const ratio = overlap / Math.min(wordsA.size, wordsB.size);
  return Math.round(Math.min(1, ratio) * 10 * 10) / 10; // one decimal place
}

/** Scores 0-10 how relevant `question` is to `topic`/the answer it follows. */
export async function scoreQuestionRelevance(input: RelevanceJudgeInput, judge?: RelevanceJudge): Promise<number> {
  if (judge) return judge(input);
  return heuristicOverlapScore(input.question, `${input.topic} ${input.answerContext}`);
}

/** Scores 0-10 how well `followUp` builds on the candidate's actual answer, rather than being a
 *  generic question that could follow any answer on the topic. */
export async function scoreFollowUpQuality(
  input: { followUp: string; answerContext: string; topic: string },
  judge?: RelevanceJudge
): Promise<number> {
  if (judge) return judge({ question: input.followUp, topic: input.topic, answerContext: input.answerContext });
  return heuristicOverlapScore(input.followUp, input.answerContext);
}

/** Sample Pearson correlation coefficient. `0` (rather than `NaN`) when either series has zero
 *  variance (e.g. every score identical) — there's no meaningful correlation to report, and `NaN`
 *  would silently poison anything downstream that sums or compares this value. */
function pearsonCorrelation(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n === 0) return 0;
  const meanX = xs.reduce((s, v) => s + v, 0) / n;
  const meanY = ys.reduce((s, v) => s + v, 0) / n;
  let cov = 0;
  let varX = 0;
  let varY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    cov += dx * dy;
    varX += dx * dx;
    varY += dy * dy;
  }
  if (varX === 0 || varY === 0) return 0;
  return cov / Math.sqrt(varX * varY);
}

/**
 * Agreement between a set of human scores and the automated judge's scores for the same items —
 * the metric that answers "can we trust the automated evaluator," not "is any individual score
 * right." `meanAbsoluteError` and `exactAgreementRate` (within 1 point on a 0-10 scale) are more
 * interpretable for a small benchmark run than correlation alone, which can look artificially
 * strong or weak with only a handful of cases.
 */
export function humanAgreement(pairs: Array<{ human: number; automated: number }>): {
  meanAbsoluteError: number;
  pearsonCorrelation: number;
  exactAgreementRate: number;
} {
  if (pairs.length === 0) return { meanAbsoluteError: 0, pearsonCorrelation: 0, exactAgreementRate: 0 };
  const diffs = pairs.map((p) => Math.abs(p.human - p.automated));
  const meanAbsoluteError = diffs.reduce((s, d) => s + d, 0) / diffs.length;
  const exactAgreementRate = diffs.filter((d) => d <= 1).length / diffs.length;
  return {
    meanAbsoluteError,
    pearsonCorrelation: pearsonCorrelation(
      pairs.map((p) => p.human),
      pairs.map((p) => p.automated)
    ),
    exactAgreementRate,
  };
}
