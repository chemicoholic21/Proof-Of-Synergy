/**
 * Latency instrumentation for the voice pipeline: mic -> upload -> STT -> LLM -> TTS -> playback.
 *
 * One `VoiceLatencyTracker` is created per user turn (from the moment the mic opens to the moment
 * the interviewer's reply starts playing back) and accumulates one timestamp per stage as the turn
 * moves through the pipeline:
 *
 *   mic_start -> speech_detected -> speech_end -> audio_upload_start -> audio_upload_end
 *   -> stt_start -> stt_end -> llm_start -> llm_first_token -> llm_end
 *   -> tts_start -> tts_first_audio -> tts_end -> audio_playback_start
 *
 * `mic_start`, `speech_detected`, `speech_end`, `audio_upload_start` and `audio_playback_start` are
 * stamped directly in the browser (see components/VoiceRecorder.tsx and lib/tts-client.ts).
 * Everything from `audio_upload_end` through `tts_end` happens on the server, inside the
 * transcribe/gemini/tts route handlers; those routes stamp their own stages and return them to the
 * client in each response's `timing` field, and the client folds them into the same tracker via
 * `merge()`.
 *
 * All stamps use `Date.now()` (wall-clock epoch ms), not `performance.now()`, specifically because
 * several stage *pairs* straddle the client/server boundary (e.g. `speech_end` is a browser
 * timestamp, `stt_start` is a server timestamp) — only a shared epoch lets those be diffed at all.
 * That trades away sub-millisecond precision for clock skew between the browser and the server
 * host: fine for spotting which stage dominates end-to-end latency, not for rigorous profiling.
 *
 * This module is pure instrumentation — importing and calling it never changes pipeline behavior.
 */

export type VoiceLatencyStage =
  | "mic_start"
  | "speech_detected"
  | "speech_end"
  | "audio_upload_start"
  | "audio_upload_end"
  | "stt_start"
  | "stt_end"
  | "llm_start"
  | "llm_first_token"
  | "llm_end"
  | "tts_start"
  | "tts_first_audio"
  | "tts_end"
  | "audio_playback_start";

export const VOICE_LATENCY_STAGES: readonly VoiceLatencyStage[] = [
  "mic_start",
  "speech_detected",
  "speech_end",
  "audio_upload_start",
  "audio_upload_end",
  "stt_start",
  "stt_end",
  "llm_start",
  "llm_first_token",
  "llm_end",
  "tts_start",
  "tts_first_audio",
  "tts_end",
  "audio_playback_start",
];

/** Sparse stage -> epoch-ms map. Only the stages reached so far by a given turn are present. */
export type VoiceLatencyTimestamps = Partial<Record<VoiceLatencyStage, number>>;

/**
 * Derived end-to-end timings for one voice turn, in milliseconds.
 *
 * A field is `NaN` (never thrown) when one of the two stages it depends on hasn't been recorded
 * yet — e.g. every TTS/playback field is `NaN` for a turn where the learner typed instead of
 * speaking, or where the reply text has arrived but hasn't been read aloud yet.
 */
export interface VoiceLatencyMetrics {
  /** Silence -> STT actually starting on the server: upload time + server queueing. */
  speechEndToSttMs: number;
  /** Time the Sarvam STT call itself took. */
  sttMs: number;
  /** LLM call start -> first token. Equals `llmTotalMs` until the chat call streams. */
  llmTimeToFirstTokenMs: number;
  /** Total LLM call time, start to finish. */
  llmTotalMs: number;
  /** TTS call start -> first audio byte. Equals the TTS call time until it streams. */
  ttsTimeToFirstAudioMs: number;
  /** The number that matters to the user: going silent -> hearing the reply start. */
  totalTimeToFirstAudioMs: number;
}

function diffMs(from: number | undefined, to: number | undefined): number {
  return from !== undefined && to !== undefined ? to - from : NaN;
}

/** Compute the summary metrics from whatever stages have been recorded so far. */
export function computeVoiceLatencyMetrics(t: VoiceLatencyTimestamps): VoiceLatencyMetrics {
  return {
    speechEndToSttMs: diffMs(t.speech_end, t.stt_start),
    sttMs: diffMs(t.stt_start, t.stt_end),
    llmTimeToFirstTokenMs: diffMs(t.llm_start, t.llm_first_token),
    llmTotalMs: diffMs(t.llm_start, t.llm_end),
    ttsTimeToFirstAudioMs: diffMs(t.tts_start, t.tts_first_audio),
    totalTimeToFirstAudioMs: diffMs(t.speech_end, t.audio_playback_start),
  };
}

/** True once every field is a real number — i.e. the full turn (mic through playback) completed. */
export function isVoiceLatencyComplete(metrics: VoiceLatencyMetrics): boolean {
  return Object.values(metrics).every((v) => Number.isFinite(v));
}

let turnCounter = 0;

/** Accumulates timestamps for a single voice turn as it moves through the pipeline. */
export class VoiceLatencyTracker {
  readonly turnId: string;
  private timestamps: VoiceLatencyTimestamps;

  constructor(seed: VoiceLatencyTimestamps = {}, turnId?: string) {
    this.timestamps = { ...seed };
    this.turnId = turnId ?? `turn_${Date.now()}_${++turnCounter}`;
  }

  /**
   * Record `stage` at `atMs` (defaults to now). The first mark for a stage always wins — a
   * duplicate event (e.g. a retried fetch) must never overwrite the original measurement. Returns
   * the timestamp actually stored for `stage`.
   */
  mark(stage: VoiceLatencyStage, atMs: number = Date.now()): number {
    if (this.timestamps[stage] === undefined) this.timestamps[stage] = atMs;
    return this.timestamps[stage]!;
  }

  get(stage: VoiceLatencyStage): number | undefined {
    return this.timestamps[stage];
  }

  /** Merge stage timestamps recorded elsewhere (e.g. server timing returned in an API response). */
  merge(marks: VoiceLatencyTimestamps | undefined | null): void {
    if (!marks) return;
    for (const stage of VOICE_LATENCY_STAGES) {
      const v = marks[stage];
      if (v !== undefined) this.mark(stage, v);
    }
  }

  snapshot(): VoiceLatencyTimestamps {
    return { ...this.timestamps };
  }

  metrics(): VoiceLatencyMetrics {
    return computeVoiceLatencyMetrics(this.timestamps);
  }
}
