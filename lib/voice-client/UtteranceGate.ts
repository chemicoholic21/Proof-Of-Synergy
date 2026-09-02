/**
 * lib/voice-client/UtteranceGate.ts
 *
 * Turns `UtteranceDetector`'s (../vad.ts) continuous `{isSpeaking, isFinal}` state into the two
 * discrete, edge-triggered signals the realtime client protocol actually needs to send:
 *
 *   - "speech_started" the instant `isSpeaking` flips false -> true — which, per
 *     `UtteranceDetector`'s own semantics, is the very first frame whose energy crosses the
 *     threshold (no onset debounce; it favors low latency for the barge-in/turn-start signal).
 *     Drives `RealtimeVoiceClient.notifySpeechStarted()` — see that file's own docstring on why
 *     this alone is sufficient to cover barge-in too, since `VoiceSession.notifySpeechStarted()`
 *     detects and handles that server-side.
 *   - "utterance_final" the instant `isFinal` flips false -> true — which requires both a minimum
 *     speaking duration (`speechPadMs`) and a full trailing silence (`silenceTimeoutMs`) to have
 *     elapsed. Drives `RealtimeVoiceClient.submitUtterance()`.
 *
 * `UtteranceDetector` already does this project's local, "no server-side endpointing" VAD job (RMS
 * energy vs. a threshold, with minimum-duration/silence-timeout debouncing on the *ending* side);
 * this file exists only because that class reports *state*, and a realtime client needs *events*
 * to decide when to send a message at all — sending `speech_started` on every single frame while
 * the user keeps talking would flood the gateway for no reason.
 *
 * Deliberately DOM-free (like `UtteranceDetector` itself, `performance.now()` aside) — this is the
 * "Local VAD" box from the architecture diagram's decision logic, factored out so it's unit
 * testable without a browser, exactly like the rest of this codebase's provider/session logic.
 */

import { UtteranceDetector, type VadConfig } from "../vad";

export type UtteranceGateSignal = "speech_started" | "utterance_final";

export class UtteranceGate {
  private readonly detector: UtteranceDetector;
  private wasSpeaking = false;
  private wasFinal = false;

  constructor(config: Partial<VadConfig> = {}) {
    this.detector = new UtteranceDetector(config);
  }

  /** Feed one frame's RMS energy (from the AudioWorklet, see ./RealtimeAudioCapture.ts). Returns
   *  the signals (zero, one, or — on the frame a new utterance starts immediately after a prior
   *  one finalized — both) that newly became true on this frame, in the order they should be
   *  acted on. */
  pushRms(rms: number): UtteranceGateSignal[] {
    const state = this.detector.update(rms);
    const signals: UtteranceGateSignal[] = [];

    if (state.isSpeaking && !this.wasSpeaking) signals.push("speech_started");
    if (state.isFinal && !this.wasFinal) signals.push("utterance_final");

    this.wasSpeaking = state.isSpeaking;
    this.wasFinal = state.isFinal;
    return signals;
  }

  /** Reset for a fresh utterance cycle (e.g. right after sending "utterance_final") — mirrors
   *  `UtteranceDetector.reset()` plus this class's own edge-tracking flags. */
  reset(): void {
    this.detector.reset();
    this.wasSpeaking = false;
    this.wasFinal = false;
  }
}
