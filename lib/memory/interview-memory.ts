/**
 * Semantic extraction from an interview: Interview DNA (communication metrics) and the concepts a
 * transcript actually touched. These become permanent graph nodes so we can show trends over
 * months ("filler words 32 → 19 → 8") and connect answers to the concepts they demonstrate.
 *
 * Deterministic and dependency-free so it works with zero credentials. Text-based metrics are a
 * strong proxy for the "voice memory" the brief asks for; when a real duration is available we also
 * derive speech rate.
 */

const FILLERS = ["um", "uh", "erm", "hmm", "like", "basically", "actually", "kind of", "sort of", "you know", "i mean", "so yeah", "literally"];
const HEDGES = ["i think", "maybe", "probably", "i guess", "i'm not sure", "kind of", "sort of", "i believe", "possibly"];
const CONFIDENCE_MARKERS = ["i built", "i designed", "i implemented", "i chose", "i decided", "we shipped", "in production", "i led", "i owned", "i debugged"];

export interface InterviewDNA {
  wordCount: number;
  fillerCount: number;
  fillerRate: number; // fillers per 100 words
  hedgeCount: number;
  vocabularyRichness: number; // unique/total, 0-100
  avgSentenceLength: number; // words per sentence
  confidenceMarkers: number; // count of first-person ownership phrases
  confidence: number; // 0-100 composite
  technicalDepth: number; // 0-100 proxy from technical term density
  speechRateWpm: number | null; // requires duration
  topFillers: { word: string; count: number }[];
}

function countOccurrences(text: string, phrase: string): number {
  const re = new RegExp(`(?:^|\\W)${phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|\\W)`, "gi");
  return (text.match(re) || []).length;
}

const TECH_TERMS = [
  "latency", "throughput", "idempotent", "consistency", "partition", "replication", "cache",
  "index", "concurrency", "race condition", "queue", "stream", "shard", "load balancer", "circuit breaker",
  "deadlock", "transaction", "consensus", "backpressure", "checkpoint", "retry", "failover", "scale",
];

/** Compute Interview DNA for a single answer or a whole interview (pass concatenated text). */
export function extractDNA(text: string, durationSec?: number): InterviewDNA {
  const clean = (text || "").trim();
  const words = clean.split(/\s+/).filter(Boolean);
  const wordCount = words.length;
  const lower = clean.toLowerCase();

  const fillerCounts = FILLERS.map((f) => ({ word: f, count: countOccurrences(lower, f) })).filter((f) => f.count > 0);
  const fillerCount = fillerCounts.reduce((a, b) => a + b.count, 0);
  const hedgeCount = HEDGES.reduce((a, h) => a + countOccurrences(lower, h), 0);
  const confidenceMarkers = CONFIDENCE_MARKERS.reduce((a, m) => a + countOccurrences(lower, m), 0);

  const uniq = new Set(words.map((w) => w.toLowerCase().replace(/[^a-z0-9]/g, ""))).size;
  const vocabularyRichness = wordCount ? Math.round((uniq / wordCount) * 100) : 0;

  const sentences = clean.split(/[.!?]+/).map((s) => s.trim()).filter(Boolean);
  const avgSentenceLength = sentences.length ? Math.round(wordCount / sentences.length) : wordCount;

  const techHits = TECH_TERMS.reduce((a, t) => a + countOccurrences(lower, t), 0);
  const technicalDepth = clampScore(wordCount ? (techHits / Math.max(1, wordCount / 40)) * 50 : 0);

  const fillerRate = wordCount ? +((fillerCount / wordCount) * 100).toFixed(1) : 0;

  // Composite confidence: rewards ownership + fluency, penalizes fillers/hedging. Anchored so an
  // empty/incoherent answer scores low and a specific, first-person answer scores high.
  let confidence = 55;
  confidence += Math.min(20, confidenceMarkers * 6);
  confidence -= Math.min(25, fillerRate * 2.5);
  confidence -= Math.min(15, hedgeCount * 3);
  confidence += Math.min(10, (vocabularyRichness - 45) / 3);
  if (wordCount < 12) confidence -= 25; // barely said anything
  confidence = clampScore(confidence);

  const speechRateWpm = durationSec && durationSec > 0 ? Math.round((wordCount / durationSec) * 60) : null;

  return {
    wordCount,
    fillerCount,
    fillerRate,
    hedgeCount,
    vocabularyRichness,
    avgSentenceLength,
    confidenceMarkers,
    confidence,
    technicalDepth,
    speechRateWpm,
    topFillers: fillerCounts.sort((a, b) => b.count - a.count).slice(0, 4),
  };
}

/** Aggregate several per-answer DNAs into one interview-level DNA (weighted by word count). */
export function aggregateDNA(parts: InterviewDNA[]): InterviewDNA {
  if (!parts.length) return extractDNA("");
  const totalWords = parts.reduce((a, p) => a + p.wordCount, 0) || 1;
  const w = (sel: (p: InterviewDNA) => number) =>
    Math.round(parts.reduce((a, p) => a + sel(p) * (p.wordCount || 1), 0) / totalWords);
  const fillerCount = parts.reduce((a, p) => a + p.fillerCount, 0);
  const hedgeCount = parts.reduce((a, p) => a + p.hedgeCount, 0);
  const confidenceMarkers = parts.reduce((a, p) => a + p.confidenceMarkers, 0);
  const fillerMap = new Map<string, number>();
  for (const p of parts) for (const f of p.topFillers) fillerMap.set(f.word, (fillerMap.get(f.word) || 0) + f.count);
  const rates = parts.map((p) => p.speechRateWpm).filter((r): r is number => r != null);
  return {
    wordCount: totalWords,
    fillerCount,
    fillerRate: +((fillerCount / totalWords) * 100).toFixed(1),
    hedgeCount,
    vocabularyRichness: w((p) => p.vocabularyRichness),
    avgSentenceLength: w((p) => p.avgSentenceLength),
    confidenceMarkers,
    confidence: w((p) => p.confidence),
    technicalDepth: w((p) => p.technicalDepth),
    speechRateWpm: rates.length ? Math.round(rates.reduce((a, b) => a + b, 0) / rates.length) : null,
    topFillers: [...fillerMap.entries()].map(([word, count]) => ({ word, count })).sort((a, b) => b.count - a.count).slice(0, 4),
  };
}

function clampScore(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}
