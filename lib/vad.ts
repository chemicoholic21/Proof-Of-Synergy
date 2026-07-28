/**
 * Voice Activity Detection (VAD) using the Web Audio API AnalyserNode.
 *
 * Computes the RMS energy of the incoming audio stream and compares it
 * against a configurable threshold.  When energy stays above the threshold
 * for `speechPadMs` milliseconds the voice is considered "active"; when it
 * stays below for `silenceTimeoutMs` milliseconds the current utterance is
 * considered ended.
 *
 * The analyser is attached to the live MediaStream so there is zero network
 * round-trip — everything is computed in the browser.
 */

export interface VadConfig {
  /** Energy threshold (0–1).  Values below this are treated as silence. */
  threshold: number;
  /** Milliseconds of continuous speech required before VAD declares voice active. */
  speechPadMs: number;
  /** Milliseconds of continuous silence required before VAD declares the utterance ended. */
  silenceTimeoutMs: number;
}

const DEFAULT_CONFIG: VadConfig = {
  threshold: 0.015,
  speechPadMs: 200,
  silenceTimeoutMs: 1200,
};

export interface VadResult {
  isSpeaking: boolean;
  confidence: number;
}

export class VoiceActivityDetector {
  private config: VadConfig;
  private analyser: AnalyserNode | null = null;
  private dataArray: Float32Array | null = null;
  private stream: MediaStream | null = null;
  private rafId: number | null = null;
  private onResult: ((result: VadResult) => void) | null = null;

  private speechStartMs: number = 0;
  private silenceStartMs: number = 0;
  private isSpeaking: boolean = false;
  private hasHadSpeech: boolean = false;

  constructor(config: Partial<VadConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Attach the VAD to a live audio MediaStream and begin analysing.
   * Calls `onResult` on every analysis frame.
   */
  start(stream: MediaStream, onResult: (result: VadResult) => void): void {
    this.stop();
    this.stream = stream;
    this.onResult = onResult;

    const audioCtx = new AudioContext({ sampleRate: 16000 });
    const source = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.8;

    source.connect(analyser);
    this.analyser = analyser;
    this.dataArray = new Float32Array(analyser.fftSize);

    const tick = (): void => {
      if (!this.analyser || !this.dataArray) return;
      this.analyser.getFloatTimeDomainData(this.dataArray);
      const rms = this.computeRms(this.dataArray);
      const result = this.evaluate(rms);
      if (this.onResult) this.onResult(result);
      this.rafId = requestAnimationFrame(tick);
    };

    this.rafId = requestAnimationFrame(tick);
  }

  /** Stop analysing and release audio resources. */
  stop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    this.analyser = null;
    this.dataArray = null;
    this.isSpeaking = false;
    this.hasHadSpeech = false;
  }

  /** Returns the current speaking state without starting the analyser. */
  getSpeaking(): boolean {
    return this.isSpeaking;
  }

  private computeRms(data: Float32Array): number {
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      sum += data[i] * data[i];
    }
    return Math.sqrt(sum / data.length);
  }

  /** Evaluate RMS energy and return the current VAD result. */
  evaluate(rms: number): VadResult {
    const now = performance.now();
    const { threshold, speechPadMs, silenceTimeoutMs } = this.config;

    if (rms >= threshold) {
      this.speechStartMs = now;
      if (!this.isSpeaking) {
        const elapsed = now - this.silenceStartMs;
        if (this.hasHadSpeech && elapsed < silenceTimeoutMs) {
          // Still within the silence pad — treat as continuation.
        } else {
          this.isSpeaking = true;
        }
      }
      this.hasHadSpeech = true;
    } else {
      if (this.isSpeaking) {
        const speechDuration = now - this.speechStartMs;
        if (speechDuration >= speechPadMs) {
          this.isSpeaking = false;
          this.silenceStartMs = now;
        }
      }
    }

    return {
      isSpeaking: this.isSpeaking,
      confidence: Math.min(1, rms / (threshold * 3)),
    };
  }
}

/**
 * Detect the end of an utterance by monitoring silence.
 * Returns `true` when the user has been silent for `silenceTimeoutMs`
 * after having spoken for at least `speechPadMs`.
 */
export interface UtteranceState {
  isSpeaking: boolean;
  isFinal: boolean;
  silenceDurationMs: number;
}

export class UtteranceDetector {
  private config: VadConfig;
  private silenceStartMs: number = 0;
  private speechStartMs: number = 0;
  private isSpeaking: boolean = false;
  private isFinal: boolean = false;
  private hasHadSpeech: boolean = false;

  constructor(config: Partial<VadConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Feed a new RMS energy value and get the updated utterance state. */
  update(rms: number): UtteranceState {
    const now = performance.now();
    const { threshold, speechPadMs, silenceTimeoutMs } = this.config;

    if (rms >= threshold) {
      this.silenceStartMs = 0;
      if (!this.isSpeaking) {
        const elapsed = this.hasHadSpeech ? now - this.silenceStartMs : 0;
        if (!this.hasHadSpeech || elapsed >= silenceTimeoutMs) {
          this.isSpeaking = true;
          this.isFinal = false;
          this.speechStartMs = now;
        }
      }
      this.hasHadSpeech = true;
    } else {
      if (this.isSpeaking) {
        const speechDuration = now - this.speechStartMs;
        if (speechDuration >= speechPadMs) {
          this.isSpeaking = false;
          this.silenceStartMs = now;
        }
      } else if (this.hasHadSpeech && this.silenceStartMs > 0) {
        const silenceDuration = now - this.silenceStartMs;
        if (silenceDuration >= silenceTimeoutMs) {
          this.isFinal = true;
        }
      }
    }

    return {
      isSpeaking: this.isSpeaking,
      isFinal: this.isFinal,
      silenceDurationMs: this.silenceStartMs > 0 ? now - this.silenceStartMs : 0,
    };
  }

  /** Reset the detector state for a new utterance cycle. */
  reset(): void {
    this.silenceStartMs = 0;
    this.speechStartMs = 0;
    this.isSpeaking = false;
    this.isFinal = false;
    this.hasHadSpeech = false;
  }
}
