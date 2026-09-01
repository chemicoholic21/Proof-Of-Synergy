/** Shared domain types for the practice experience. */

export interface Scenario {
  id: string;
  title: string;
  description: string;
  difficulty: "beginner" | "intermediate" | "advanced";
  tags: string[];
  systemPrompt: string;
  openingMessage: string;
  /** Optional intake gate shown before the conversation (e.g. resume upload for interviews). */
  intake?: "resume";
}

export interface ConversationMessage {
  role: "user" | "assistant" | "coach";
  content: string;
  timestamp: number;
  coachingNote?: string;
}

export interface CoachingEvent {
  type: "filler" | "hesitation" | "ramble" | "weak-structure" | "confidence-drop" | "repetition" | "positive";
  text: string;
  timestamp: number;
  suggestion?: string;
}

export interface SessionResult {
  scenarioId: string;
  durationSec: number;
  messages: ConversationMessage[];
  coachingEvents: CoachingEvent[];
  metrics: CommunicationMetrics;
  summary: string;
}

export interface Transcript {
  text: string;
  language: string;
  languagesDetected: string[];
  source: "sarvam" | "fallback";
  /** Server-side voice-latency stage timestamps (epoch ms), for the client to merge into its
   *  per-turn VoiceLatencyTracker. Absent on the demo/error fallback paths. */
  timing?: Partial<Record<"audio_upload_end" | "stt_start" | "stt_end", number>>;
}

export interface CommunicationMetrics {
  wordCount: number;
  fillerCount: number;
  fillerRate: number;
  hedgeCount: number;
  vocabularyRichness: number;
  avgSentenceLength: number;
  confidenceMarkers: number;
  confidence: number;
  technicalDepth: number;
  speechRateWpm: number | null;
  topFillers: { word: string; count: number }[];
}
