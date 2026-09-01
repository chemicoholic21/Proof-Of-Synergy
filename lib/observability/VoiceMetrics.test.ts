import { describe, it, expect } from "vitest";
import {
  VoiceMetrics,
  computeVoiceMetricSummary,
  isVoiceMetricComplete,
  fromVoiceLatencyTimestamps,
} from "./VoiceMetrics";

describe("computeVoiceMetricSummary", () => {
  it("computes every field once all eight stages are present", () => {
    const t = {
      speech_end: 2000,
      stt_first_partial: 2150,
      stt_final: 2500,
      llm_start: 2500,
      llm_first_token: 2700,
      tts_start: 3100,
      tts_first_audio: 3300,
      playback_start: 3350,
    };
    const metrics = computeVoiceMetricSummary(t);
    expect(metrics).toEqual({
      sttFirstPartialMs: 150, // speech_end(2000) -> stt_first_partial(2150)
      sttFinalMs: 500, // speech_end -> stt_final
      llmTimeToFirstTokenMs: 200, // llm_start -> llm_first_token
      ttsTimeToFirstAudioMs: 200, // tts_start -> tts_first_audio
      endOfSpeechToFirstAudioMs: 1300, // speech_end(2000) -> tts_first_audio(3300)
      endOfSpeechToPlaybackMs: 1350, // speech_end(2000) -> playback_start(3350)
    });
    expect(isVoiceMetricComplete(metrics)).toBe(true);
  });

  it("reports NaN (never a thrown error) for a field whose stages weren't reached", () => {
    // Today's non-streaming STT never marks stt_first_partial.
    const metrics = computeVoiceMetricSummary({
      speech_end: 1000,
      stt_final: 1300,
      llm_start: 1300,
      llm_first_token: 1600,
    });
    expect(metrics.sttFinalMs).toBe(300);
    expect(metrics.llmTimeToFirstTokenMs).toBe(300);
    expect(metrics.sttFirstPartialMs).toBeNaN();
    expect(metrics.ttsTimeToFirstAudioMs).toBeNaN();
    expect(metrics.endOfSpeechToFirstAudioMs).toBeNaN();
    expect(metrics.endOfSpeechToPlaybackMs).toBeNaN();
    expect(isVoiceMetricComplete(metrics)).toBe(false);
  });

  it("returns all-NaN metrics for an empty timestamp set", () => {
    const metrics = computeVoiceMetricSummary({});
    for (const value of Object.values(metrics)) {
      expect(value).toBeNaN();
    }
  });
});

describe("fromVoiceLatencyTimestamps", () => {
  it("maps the existing VoiceLatencyTracker stage names onto this module's stage set", () => {
    const mapped = fromVoiceLatencyTimestamps({
      mic_start: 0,
      speech_detected: 50,
      speech_end: 2000,
      audio_upload_start: 2010,
      audio_upload_end: 2200,
      stt_start: 2200,
      stt_end: 2500,
      llm_start: 2500,
      llm_first_token: 2700,
      llm_end: 3100,
      tts_start: 3100,
      tts_first_audio: 3300,
      tts_end: 3400,
      audio_playback_start: 3350,
    });
    expect(mapped).toEqual({
      speech_end: 2000,
      stt_final: 2500, // stt_end -> stt_final
      llm_start: 2500,
      llm_first_token: 2700,
      tts_start: 3100,
      tts_first_audio: 3300,
      playback_start: 3350, // audio_playback_start -> playback_start
    });
    // No streaming partial in the current pipeline -> left unset.
    expect(mapped.stt_first_partial).toBeUndefined();
  });

  it("leaves unreached stages unset rather than inventing zeros", () => {
    const mapped = fromVoiceLatencyTimestamps({ llm_start: 100, llm_first_token: 150 });
    expect(mapped).toEqual({ llm_start: 100, llm_first_token: 150 });
  });
});

describe("VoiceMetrics", () => {
  it("keeps the first mark for a stage and ignores a later duplicate", () => {
    const tracker = new VoiceMetrics();
    tracker.mark("speech_end", 1000);
    tracker.mark("speech_end", 9999); // a retried/duplicate event must never clobber the real mark
    expect(tracker.get("speech_end")).toBe(1000);
  });

  it("merge() folds in stages recorded elsewhere without overwriting existing ones", () => {
    const tracker = new VoiceMetrics({ speech_end: 2000 });
    tracker.merge({ stt_final: 2500, llm_start: 2500 });
    tracker.merge({ stt_final: 9999 }); // already set locally -> ignored
    expect(tracker.snapshot()).toEqual({ speech_end: 2000, stt_final: 2500, llm_start: 2500 });
  });

  it("merge() is a no-op for null/undefined input", () => {
    const tracker = new VoiceMetrics({ speech_end: 1 });
    tracker.merge(undefined);
    tracker.merge(null);
    expect(tracker.snapshot()).toEqual({ speech_end: 1 });
  });

  it("summary() reflects whatever has been recorded so far", () => {
    const tracker = new VoiceMetrics();
    tracker.mark("speech_end", 1000);
    tracker.mark("tts_start", 1100);
    tracker.mark("tts_first_audio", 1300);
    expect(tracker.summary().ttsTimeToFirstAudioMs).toBe(200);
    expect(tracker.summary().endOfSpeechToFirstAudioMs).toBe(300);
    expect(tracker.summary().llmTimeToFirstTokenMs).toBeNaN();
    expect(tracker.isComplete()).toBe(false);
  });

  it("isComplete() is true once every stage has landed", () => {
    const tracker = new VoiceMetrics();
    for (const [stage, at] of Object.entries({
      speech_end: 0,
      stt_first_partial: 50,
      stt_final: 100,
      llm_start: 100,
      llm_first_token: 200,
      tts_start: 200,
      tts_first_audio: 300,
      playback_start: 320,
    })) {
      tracker.mark(stage as Parameters<VoiceMetrics["mark"]>[0], at);
    }
    expect(tracker.isComplete()).toBe(true);
  });

  it("assigns each tracker a unique turnId by default", () => {
    const a = new VoiceMetrics();
    const b = new VoiceMetrics();
    expect(a.turnId).not.toBe(b.turnId);
  });

  it("accepts an explicit turnId", () => {
    const tracker = new VoiceMetrics({}, "turn_fixed_1");
    expect(tracker.turnId).toBe("turn_fixed_1");
  });

  it("report() returns the summary and never throws without a span", () => {
    const tracker = new VoiceMetrics();
    tracker.mark("speech_end", 1000);
    tracker.mark("tts_first_audio", 1400);
    const summary = tracker.report();
    expect(summary.endOfSpeechToFirstAudioMs).toBe(400);
  });

  it("report() forwards only finite metrics and raw stage timestamps to the supplied span", () => {
    const attributes: Record<string, unknown> = {};
    const events: Array<{ name: string; atMs: unknown }> = [];
    const fakeSpan = {
      setAttribute: (key: string, value: unknown) => {
        attributes[key] = value;
      },
      addEvent: (name: string, _attrs: unknown, atMs: unknown) => {
        events.push({ name, atMs });
      },
    };

    const tracker = new VoiceMetrics();
    tracker.mark("speech_end", 1000);
    tracker.mark("tts_start", 1200);
    tracker.mark("tts_first_audio", 1400);
    tracker.report(fakeSpan as unknown as Parameters<VoiceMetrics["report"]>[0]);

    expect(attributes["voice.latency.ttsTimeToFirstAudioMs"]).toBe(200);
    expect(attributes["voice.latency.endOfSpeechToFirstAudioMs"]).toBe(400);
    // NaN metrics (e.g. sttFinalMs, llmTimeToFirstTokenMs) must never reach the span as attributes.
    expect(attributes).not.toHaveProperty("voice.latency.sttFinalMs");
    expect(events).toEqual(
      expect.arrayContaining([
        { name: "voice.stage.speech_end", atMs: 1000 },
        { name: "voice.stage.tts_start", atMs: 1200 },
        { name: "voice.stage.tts_first_audio", atMs: 1400 },
      ])
    );
  });
});
