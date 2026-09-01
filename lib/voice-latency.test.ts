import { describe, it, expect } from "vitest";
import { VoiceLatencyTracker, computeVoiceLatencyMetrics, isVoiceLatencyComplete } from "./voice-latency";

describe("computeVoiceLatencyMetrics", () => {
  it("computes every field once all fourteen stages are present", () => {
    const t = {
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
    };
    const metrics = computeVoiceLatencyMetrics(t);
    expect(metrics).toEqual({
      speechEndToSttMs: 200, // speech_end(2000) -> stt_start(2200)
      sttMs: 300, // stt_start -> stt_end
      llmTimeToFirstTokenMs: 200, // llm_start -> llm_first_token
      llmTotalMs: 600, // llm_start -> llm_end
      ttsTimeToFirstAudioMs: 200, // tts_start -> tts_first_audio
      totalTimeToFirstAudioMs: 1350, // speech_end(2000) -> audio_playback_start(3350)
    });
    expect(isVoiceLatencyComplete(metrics)).toBe(true);
  });

  it("reports NaN (never a thrown error) for a field whose stages weren't reached", () => {
    // A typed answer never touches mic/STT/TTS at all — only the LLM call happens.
    const metrics = computeVoiceLatencyMetrics({ llm_start: 100, llm_first_token: 150, llm_end: 400 });
    expect(metrics.llmTimeToFirstTokenMs).toBe(50);
    expect(metrics.llmTotalMs).toBe(300);
    expect(metrics.speechEndToSttMs).toBeNaN();
    expect(metrics.sttMs).toBeNaN();
    expect(metrics.ttsTimeToFirstAudioMs).toBeNaN();
    expect(metrics.totalTimeToFirstAudioMs).toBeNaN();
    expect(isVoiceLatencyComplete(metrics)).toBe(false);
  });

  it("returns all-NaN metrics for an empty timestamp set", () => {
    const metrics = computeVoiceLatencyMetrics({});
    for (const value of Object.values(metrics)) {
      expect(value).toBeNaN();
    }
  });
});

describe("VoiceLatencyTracker", () => {
  it("keeps the first mark for a stage and ignores a later duplicate", () => {
    const tracker = new VoiceLatencyTracker();
    tracker.mark("mic_start", 100);
    tracker.mark("mic_start", 999); // a retried/duplicate event must never clobber the real mark
    expect(tracker.get("mic_start")).toBe(100);
  });

  it("merge() folds in server-reported stages without overwriting existing ones", () => {
    const tracker = new VoiceLatencyTracker({ speech_end: 2000 });
    tracker.merge({ stt_start: 2200, stt_end: 2500 });
    tracker.merge({ stt_start: 9999 }); // already set locally -> ignored
    expect(tracker.snapshot()).toEqual({ speech_end: 2000, stt_start: 2200, stt_end: 2500 });
  });

  it("merge() is a no-op for null/undefined input", () => {
    const tracker = new VoiceLatencyTracker({ mic_start: 1 });
    tracker.merge(undefined);
    tracker.merge(null);
    expect(tracker.snapshot()).toEqual({ mic_start: 1 });
  });

  it("metrics() reflects whatever has been recorded so far", () => {
    const tracker = new VoiceLatencyTracker();
    tracker.mark("speech_end", 1000);
    tracker.mark("stt_start", 1100);
    tracker.mark("stt_end", 1300);
    expect(tracker.metrics().speechEndToSttMs).toBe(100);
    expect(tracker.metrics().sttMs).toBe(200);
    expect(tracker.metrics().llmTotalMs).toBeNaN();
  });

  it("assigns each tracker a unique turnId by default", () => {
    const a = new VoiceLatencyTracker();
    const b = new VoiceLatencyTracker();
    expect(a.turnId).not.toBe(b.turnId);
  });

  it("accepts an explicit turnId", () => {
    const tracker = new VoiceLatencyTracker({}, "turn_fixed_1");
    expect(tracker.turnId).toBe("turn_fixed_1");
  });
});
