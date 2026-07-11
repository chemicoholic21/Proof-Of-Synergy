import { CommunicationMetrics } from "./types";

export function extractDNA(text: string, durationSec?: number): CommunicationMetrics {
  const clean = (text || "").trim();
  const words = clean.split(/\s+/).filter(Boolean);
  const wordCount = words.length;
  const lower = clean.toLowerCase();

  const FILLERS = ["um", "uh", "erm", "hmm", "like", "basically", "actually", "kind of", "sort of", "you know", "i mean", "so yeah", "literally"];
  const HEDGES = ["i think", "maybe", "probably", "i guess", "i'm not sure", "kind of", "sort of", "i believe", "possibly"];
  const CONFIDENCE_MARKERS = ["i built", "i designed", "i implemented", "i chose", "i decided", "we shipped", "in production", "i led", "i owned", "i debugged"];
  const TECH_TERMS = [
    "latency", "throughput", "idempotent", "consistency", "partition", "replication", "cache",
    "index", "concurrency", "race condition", "queue", "stream", "shard", "load balancer", "circuit breaker",
    "deadlock", "transaction", "consensus", "backpressure", "checkpoint", "retry", "failover", "scale",
  ];

  function countOccurrences(text: string, phrase: string): number {
    const re = new RegExp(`(?:^|\\W)${phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|\\W)`, "gi");
    return (text.match(re) || []).length;
  }

  const fillerCounts = FILLERS.map((f) => ({ word: f, count: countOccurrences(lower, f) })).filter((f) => f.count > 0);
  const fillerCount = fillerCounts.reduce((a, b) => a + b.count, 0);
  const hedgeCount = HEDGES.reduce((a, h) => a + countOccurrences(lower, h), 0);
  const confidenceMarkers = CONFIDENCE_MARKERS.reduce((a, m) => a + countOccurrences(lower, m), 0);
  const uniq = new Set(words.map((w) => w.toLowerCase().replace(/[^a-z0-9]/g, ""))).size;
  const vocabularyRichness = wordCount ? Math.round((uniq / wordCount) * 100) : 0;
  const sentences = clean.split(/[.!?]+/).map((s) => s.trim()).filter(Boolean);
  const avgSentenceLength = sentences.length ? Math.round(wordCount / sentences.length) : wordCount;
  const techHits = TECH_TERMS.reduce((a, t) => a + countOccurrences(lower, t), 0);
  const technicalDepth = Math.max(0, Math.min(100, wordCount ? Math.round((techHits / Math.max(1, wordCount / 40)) * 50) : 0));
  const fillerRate = wordCount ? +(fillerCount / wordCount * 100).toFixed(1) : 0;

  let confidence = 55;
  confidence += Math.min(20, confidenceMarkers * 6);
  confidence -= Math.min(25, fillerRate * 2.5);
  confidence -= Math.min(15, hedgeCount * 3);
  confidence += Math.min(10, (vocabularyRichness - 45) / 3);
  if (wordCount < 12) confidence -= 25;
  confidence = Math.max(0, Math.min(100, Math.round(confidence)));

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
