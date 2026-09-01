/**
 * Structured latency instrumentation for the STT -> LLM -> TTS handoff of a single voice turn.
 *
 * This is a focused sibling of `lib/voice-latency.ts` (which instruments the whole
 * mic -> upload -> STT -> LLM -> TTS -> playback turn end to end for the practice/interview UI).
 * `VoiceMetrics` narrows in on the eight stage boundaries that determine how long a user waits
 * after they stop talking:
 *
 *   speech_end -> stt_first_partial -> stt_final -> llm_start -> llm_first_token
 *   -> tts_start -> tts_first_audio -> playback_start
 *
 * `stt_first_partial` and `stt_final` are named ahead of the streaming STT support the pipeline
 * doesn't have yet (see docs/voice-architecture-current.md, section 4: today's `sarvamTranscribe`
 * call returns one final transcript, not incremental partials). Until a provider streams partial
 * results, `stt_first_partial` simply never gets marked and its derived metric reads `NaN`, the
 * same way any other stage a turn didn't reach does. When incremental STT/TTS delivery lands, no
 * call site here needs to change shape — only the timing of the `mark()` calls does.
 *
 * All timestamps are plain epoch-ms numbers (`Date.now()`), so stages marked in the browser
 * (`speech_end`, `playback_start`) and stages marked on the server (STT/LLM/TTS) can be diffed
 * against each other once merged into one tracker, at the cost of clock-skew precision between
 * the two hosts — fine for spotting which leg of the handoff dominates latency, not for rigorous
 * profiling. See `lib/voice-latency.ts` for the same tradeoff spelled out in more detail.
 *
 * Pure instrumentation: creating a tracker, marking a stage, or calling `report()` never changes
 * what the pipeline does or returns, and never throws. Only stage names, a turn id, and integer
 * millisecond values ever pass through this module — never a transcript, raw audio, or an API
 * key. There is no parameter anywhere in this file that accepts free-form text or binary data, so
 * there is nothing sensitive here to redact.
 */

import type { Span } from "@opentelemetry/api";
import { setVoiceLatencyMetrics } from "../tracing";
import { logger } from "../logger";
import type { VoiceLatencyTimestamps } from "../voice-latency";

/** The eight stage boundaries this module measures, in the order a turn passes through them. */
export type VoiceMetricStage =
  | "speech_end"
  | "stt_first_partial"
  | "stt_final"
  | "llm_start"
  | "llm_first_token"
  | "tts_start"
  | "tts_first_audio"
  | "playback_start";

export const VOICE_METRIC_STAGES: readonly VoiceMetricStage[] = [
  "speech_end",
  "stt_first_partial",
  "stt_final",
  "llm_start",
  "llm_first_token",
  "tts_start",
  "tts_first_audio",
  "playback_start",
];

/** Sparse stage -> epoch-ms map. Only the stages reached so far by a given turn are present. */
export type VoiceMetricTimestamps = Partial<Record<VoiceMetricStage, number>>;

/**
 * Derived durations for one turn's STT/LLM/TTS handoff, in milliseconds.
 *
 * A field is `NaN` (never thrown) when one of the two stages it depends on hasn't been recorded
 * yet — e.g. every field here is `NaN` for a turn that hasn't started transcribing, and
 * `sttFirstPartialMs` is `NaN` for the entire lifetime of today's non-streaming STT call.
 */
export interface VoiceMetricSummary {
  /** speech_end -> stt_first_partial. `NaN` until the STT provider streams partial results. */
  sttFirstPartialMs: number;
  /** speech_end -> stt_final. The STT leg's actual contribution to end-to-end latency today. */
  sttFinalMs: number;
  /** llm_start -> llm_first_token. Equals the full call time until the chat call streams. */
  llmTimeToFirstTokenMs: number;
  /** tts_start -> tts_first_audio. Equals the full call time until TTS streams. */
  ttsTimeToFirstAudioMs: number;
  /**
   * The headline number: end of speech -> first byte of synthesized audio back from the TTS
   * provider. This is what "end-of-speech-to-first-audio latency" means throughout this module —
   * measured at the TTS response, before that audio has necessarily reached the speaker.
   */
  endOfSpeechToFirstAudioMs: number;
  /** speech_end -> playback_start. Adds client-side playback startup on top of the above. */
  endOfSpeechToPlaybackMs: number;
}

function diffMs(from: number | undefined, to: number | undefined): number {
  return from !== undefined && to !== undefined ? to - from : NaN;
}

/** Compute the summary metrics from whatever stages have been recorded so far. */
export function computeVoiceMetricSummary(t: VoiceMetricTimestamps): VoiceMetricSummary {
  return {
    sttFirstPartialMs: diffMs(t.speech_end, t.stt_first_partial),
    sttFinalMs: diffMs(t.speech_end, t.stt_final),
    llmTimeToFirstTokenMs: diffMs(t.llm_start, t.llm_first_token),
    ttsTimeToFirstAudioMs: diffMs(t.tts_start, t.tts_first_audio),
    endOfSpeechToFirstAudioMs: diffMs(t.speech_end, t.tts_first_audio),
    endOfSpeechToPlaybackMs: diffMs(t.speech_end, t.playback_start),
  };
}

/** True once every field is a real number — i.e. the turn reached speech_end through playback_start. */
export function isVoiceMetricComplete(metrics: VoiceMetricSummary): boolean {
  return Object.values(metrics).every((v) => Number.isFinite(v));
}

/**
 * Adapt the marks already collected by `lib/voice-latency.ts`'s `VoiceLatencyTracker` (used today
 * by `VoiceRecorder`, `lib/tts-client.ts`, and the transcribe/gemini/tts route handlers) into this
 * module's narrower stage set, so a `VoiceMetrics` instance can be built without re-instrumenting
 * call sites that already mark these moments under slightly different names. `stt_first_partial`
 * has no equivalent in the current non-streaming pipeline and is left unset.
 */
export function fromVoiceLatencyTimestamps(t: VoiceLatencyTimestamps): VoiceMetricTimestamps {
  return {
    speech_end: t.speech_end,
    stt_final: t.stt_end,
    llm_start: t.llm_start,
    llm_first_token: t.llm_first_token,
    tts_start: t.tts_start,
    tts_first_audio: t.tts_first_audio,
    playback_start: t.audio_playback_start,
  };
}

let turnCounter = 0;

/**
 * Accumulates timestamps for one voice turn's STT -> LLM -> TTS handoff as it moves through the
 * pipeline, and publishes the result through the app's existing observability stack.
 *
 * One instance covers one turn: client code marks `speech_end` and, after playback actually
 * starts, `playback_start`; server route handlers mark the STT/LLM/TTS stages and return them to
 * the client (the same client/server split `lib/voice-latency.ts` already uses), which folds them
 * in via `merge()` before calling `report()` once the turn is done.
 */
export class VoiceMetrics {
  readonly turnId: string;
  private timestamps: VoiceMetricTimestamps;

  constructor(seed: VoiceMetricTimestamps = {}, turnId?: string) {
    this.timestamps = { ...seed };
    this.turnId = turnId ?? `voice_${Date.now()}_${++turnCounter}`;
  }

  /**
   * Record `stage` at `atMs` (defaults to now). The first mark for a stage always wins — a
   * duplicate event (a retried fetch, or a second "partial" transcript arriving) must never
   * overwrite the original measurement. Returns the timestamp actually stored for `stage`.
   */
  mark(stage: VoiceMetricStage, atMs: number = Date.now()): number {
    if (this.timestamps[stage] === undefined) this.timestamps[stage] = atMs;
    return this.timestamps[stage]!;
  }

  /** Read back a previously recorded stage, or `undefined` if the turn hasn't reached it. */
  get(stage: VoiceMetricStage): number | undefined {
    return this.timestamps[stage];
  }

  /** Merge stage timestamps recorded elsewhere (e.g. a server response's `timing` field). Marks already set locally win. */
  merge(marks: VoiceMetricTimestamps | undefined | null): void {
    if (!marks) return;
    for (const stage of VOICE_METRIC_STAGES) {
      const v = marks[stage];
      if (v !== undefined) this.mark(stage, v);
    }
  }

  /** A snapshot of every stage recorded so far. */
  snapshot(): VoiceMetricTimestamps {
    return { ...this.timestamps };
  }

  /** The derived durations for whatever has been recorded so far (see `computeVoiceMetricSummary`). */
  summary(): VoiceMetricSummary {
    return computeVoiceMetricSummary(this.timestamps);
  }

  /** True once this turn has reached every stage from `speech_end` through `playback_start`. */
  isComplete(): boolean {
    return isVoiceMetricComplete(this.summary());
  }

  /**
   * Publish this turn's timestamps and derived durations through the app's existing
   * OpenInference/OpenTelemetry instrumentation (`lib/tracing.ts`) and structured logger
   * (`lib/logger.ts`).
   *
   * Safe to call whether or not a Phoenix collector is configured, and whether or not `span` is
   * supplied — `setVoiceLatencyMetrics` is a documented no-op without an active span/provider, so
   * this never throws and never requires tracing to be enabled. The log line is always emitted.
   * Only stage names, this turn's id, and millisecond numbers are attached to the span or written
   * to the log line — see the module docstring.
   */
  report(span?: Span): VoiceMetricSummary {
    const timestamps = this.snapshot();
    const summary = this.summary();
    const finiteMetrics: Record<string, number> = {};
    for (const [key, value] of Object.entries(summary)) {
      if (Number.isFinite(value)) finiteMetrics[key] = value as number;
    }

    if (span) setVoiceLatencyMetrics(span, finiteMetrics, timestamps);

    logger.info("voice metrics", { turnId: this.turnId, stages: timestamps, ...finiteMetrics });

    return summary;
  }
}
