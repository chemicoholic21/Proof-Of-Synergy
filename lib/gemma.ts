import { env, sarvamConfigured } from "./env";
import { sarvamChat, extractValidatedJson } from "./sarvam";
import { GEMMA_COACHING_SYSTEM, gemmaCoachingUserPrompt } from "./prompts";
import { logger } from "./logger";
import { CoachingEvent } from "@/lib/types";

const log = logger.child({ module: "gemma" });

export interface GemmaCoachingResult {
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

export async function analyzeWithGemma(transcript: string, recentMessages?: { content: string }[]): Promise<GemmaCoachingResult> {
  const fillerWords = detectFillers(transcript);
  const hesitations = detectHesitations(transcript);
  const repetitivePhrases = detectRepetition(transcript);

  let llmResult: {
    fillerWords: string[];
    hesitations: string[];
    ramble: boolean;
    weakStructure: boolean;
    confidenceDrop: boolean;
    repetitivePhrases: string[];
    positiveHighlights: string[];
    suggestion: string;
  } | null = null;

  try {
    const raw = await sarvamChat(
      GEMMA_COACHING_SYSTEM,
      gemmaCoachingUserPrompt(transcript, recentMessages),
      { temperature: 0.2, maxTokens: 800 }
    );
    llmResult = extractValidatedJson(raw, {
      parse: (v: unknown) => v as {
        fillerWords: string[];
        hesitations: string[];
        ramble: boolean;
        weakStructure: boolean;
        confidenceDrop: boolean;
        repetitivePhrases: string[];
        positiveHighlights: string[];
        suggestion: string;
      },
    });
  } catch {
    log.warn("gemma llm analysis skipped, using heuristic-only");
  }

  const ramble = llmResult?.ramble ?? detectRambling(transcript);
  const weakStructure = llmResult?.weakStructure ?? detectWeakStructure(transcript);
  const confidenceDrop = llmResult?.confidenceDrop ?? detectConfidenceDrop(transcript);
  const positiveHighlights = llmResult?.positiveHighlights ?? [];
  const suggestion = llmResult?.suggestion || "Keep going. Try to slow down slightly and structure your answer with a clear opening.";

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
    fillerWords: [...new Set([...fillerWords, ...(llmResult?.fillerWords || [])])],
    hesitations: [...new Set([...hesitations, ...(llmResult?.hesitations || [])])],
    ramble,
    weakStructure,
    confidenceDrop,
    repetitivePhrases: [...new Set([...repetitivePhrases, ...(llmResult?.repetitivePhrases || [])])],
    positiveHighlights,
    suggestion,
    coachingEvents,
  };
}
