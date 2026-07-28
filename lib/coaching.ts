import { CommunicationMetrics } from "./types";

export interface CoachingResult {
  fillerWords: string[];
  hesitations: string[];
  ramble: boolean;
  weakStructure: boolean;
  confidenceDrop: boolean;
  repetitivePhrases: string[];
  positiveHighlights: string[];
  suggestion: string;
  coachingEvents: CoachingEvent[];
}

export interface CoachingEvent {
  type: "filler" | "hesitation" | "ramble" | "weak-structure" | "confidence-drop" | "repetition" | "positive";
  text: string;
  timestamp: number;
  suggestion?: string;
}

const FILLER_RE = /\b(um+|uh+|erm+|hmm+|like|basically|actually|kind of|sort of|you know|i mean|so yeah|literally)\b/gi;
const HESITATION_RE = /\b(i think|maybe|probably|i guess|i'm not sure|possibly|i believe)\b/gi;
const REPETITION_RE = /(\b\w+\b)(?=.*\b\1\b)/gi;

function detectFillers(text: string): string[] {
  const matches = text.match(FILLER_RE) || [];
  const counts = new Map<string, number>();
  for (const m of matches) {
    counts.set(m.toLowerCase(), (counts.get(m.toLowerCase()) || 0) + 1);
  }
  return Array.from(counts.entries())
    .filter(([, c]) => c >= 2)
    .map(([word]) => word);
}

function detectHesitations(text: string): string[] {
  const matches = text.match(HESITATION_RE) || [];
  const counts = new Map<string, number>();
  for (const m of matches) {
    counts.set(m.toLowerCase(), (counts.get(m.toLowerCase()) || 0) + 1);
  }
  return Array.from(counts.entries())
    .filter(([, c]) => c >= 2)
    .map(([word]) => word);
}

function detectRepetition(text: string): string[] {
  const words = text.toLowerCase().split(/\s+/);
  const counts = new Map<string, number>();
  for (const w of words) {
    counts.set(w, (counts.get(w) || 0) + 1);
  }
  return Array.from(counts.entries())
    .filter(([, c]) => c >= 4)
    .map(([word]) => word);
}

function detectRambling(text: string): boolean {
  const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 0);
  if (sentences.length < 3) return false;
  const avgLength = text.length / sentences.length;
  return avgLength > 120;
}

function detectWeakStructure(text: string): boolean {
  const hasIntro = /^(so|well|okay|right|first|let me|i want to)/i.test(text.trim());
  const hasConclusion = /^(so|therefore|in summary|to summarize|ultimately|the key|what i'm saying)/i.test(text.trim());
  const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 0);
  return sentences.length >= 4 && !hasIntro && !hasConclusion;
}

function detectConfidenceDrop(text: string): boolean {
  const hedgeCount = (text.match(HESITATION_RE) || []).length;
  const fillerCount = (text.match(FILLER_RE) || []).length;
  return hedgeCount >= 3 || fillerCount >= 5;
}

export function analyzeWithHeuristics(text: string, metrics: CommunicationMetrics): CoachingResult {
  const fillerWords = detectFillers(text);
  const hesitations = detectHesitations(text);
  const repetitivePhrases = detectRepetition(text);
  const ramble = detectRambling(text);
  const weakStructure = detectWeakStructure(text);
  const confidenceDrop = detectConfidenceDrop(text);

  const positiveHighlights: string[] = [];
  if (metrics.confidence >= 70) positiveHighlights.push("Strong confidence throughout");
  if (metrics.vocabularyRichness >= 60) positiveHighlights.push("Rich vocabulary usage");
  if (metrics.technicalDepth >= 50) positiveHighlights.push("Good technical depth");
  if (metrics.avgSentenceLength >= 8 && metrics.avgSentenceLength <= 20) positiveHighlights.push("Well-paced sentence length");
  if (metrics.fillerRate <= 5) positiveHighlights.push("Minimal filler words");

  let suggestion = "Keep going. Try to slow down slightly and structure your answer with a clear opening.";
  if (weakStructure) {
    suggestion = "Structure your answer: start with your main point, give an example, then summarize.";
  } else if (confidenceDrop) {
    suggestion = "Own your expertise. Use 'I did X' instead of 'I think I did X'.";
  } else if (ramble) {
    suggestion = "Try to be more concise. Focus on 2-3 key points rather than covering everything.";
  } else if (fillerWords.length > 0) {
    suggestion = `Pause instead of using filler words like "${fillerWords[0]}".`;
  }

  const coachingEvents: CoachingEvent[] = [];

  for (const f of fillerWords) {
    coachingEvents.push({
      type: "filler",
      text: `Filler word: "${f}"`,
      timestamp: Date.now(),
      suggestion: `Try pausing instead of saying "${f}".`,
    });
  }
  if (ramble) {
    coachingEvents.push({
      type: "ramble",
      text: "Response was quite long and could lose the listener.",
      timestamp: Date.now(),
      suggestion: "Try to structure your answer in 2-3 concise points.",
    });
  }
  if (weakStructure) {
    coachingEvents.push({
      type: "weak-structure",
      text: "Answer lacked a clear structure.",
      timestamp: Date.now(),
      suggestion: "Start with your main point, then give an example, then summarize.",
    });
  }
  if (confidenceDrop) {
    coachingEvents.push({
      type: "confidence-drop",
      text: "Hesitation markers detected.",
      timestamp: Date.now(),
      suggestion: "Own your expertise. Use 'I did X' instead of 'I think I did X'.",
    });
  }
  for (const p of repetitivePhrases) {
    coachingEvents.push({
      type: "repetition",
      text: `Repeated phrase: "${p}"`,
      timestamp: Date.now(),
      suggestion: `Vary your language instead of repeating "${p}".`,
    });
  }
  for (const h of positiveHighlights.slice(0, 3)) {
    coachingEvents.push({
      type: "positive",
      text: h,
      timestamp: Date.now(),
    });
  }

  return {
    fillerWords,
    hesitations,
    ramble,
    weakStructure,
    confidenceDrop,
    repetitivePhrases,
    positiveHighlights,
    suggestion,
    coachingEvents,
  };
}