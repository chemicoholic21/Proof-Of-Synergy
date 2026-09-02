/**
 * lib/voice-client/RealtimeAudioCapture.ts
 *
 * The browser-only glue tying together getUserMedia -> AudioWorklet
 * (public/pcm-worklet-processor.js) -> `UtteranceGate` (local VAD) -> `RealtimeVoiceClient`, and
 * `RealtimeVoiceClient`'s incoming audio -> `AudioPlaybackQueue` -> real Web Audio playback.
 *
 * This is deliberately the *only* untested file in the realtime client stack. Everything it
 * composes — `UtteranceGate`, `AudioPlaybackQueue`, `RealtimeVoiceClient` — is already unit-tested
 * on its own with fakes; this file is thin, mechanical DOM wiring that genuinely cannot run outside
 * a real browser (`getUserMedia`, `AudioContext`, `AudioWorkletNode` all require one, and jsdom —
 * which this project doesn't use anywhere — doesn't implement Web Audio at all). Keep new *logic*
 * out of this file; put it in one of the three tested modules above instead.
 *
 * ## What's real vs. delegated (the diagram's "AudioWorklet(AEC/noise/gain/PCM)" box)
 * - AEC (echo cancellation) / noise suppression: delegated to the browser via `getUserMedia`'s own
 *   `echoCancellation`/`noiseSuppression` constraints. Reimplementing either from scratch is a
 *   substantial DSP undertaking with no realistic way to validate it in this sandbox (no audio
 *   hardware, no real acoustic echo path) — every shipping browser already has a tuned
 *   implementation of both.
 * - Gain: `autoGainControl` is requested from `getUserMedia` for automatic level normalization;
 *   this class additionally surfaces the AudioWorklet's per-frame RMS via `onLevel` so a caller can
 *   show a live input-level meter — real signal, not a placeholder.
 * - PCM framing: real, implemented in public/pcm-worklet-processor.js — fixed 20ms frames,
 *   Float32 -> Int16 conversion, one `port.postMessage` per frame.
 * - Playback decode: raw `linear16` PCM -> `Float32Array` -> `AudioBuffer`, matching what the
 *   gateway's `BulbulV3TTSProvider` is configured to actually send (../voice/realtimeAudioFormat.ts)
 *   — not a generic codec decode, which streamed compressed audio chunks can't reliably support.
 */

import { RealtimeVoiceClient, type RealtimeVoiceClientOptions } from "./RealtimeVoiceClient";
import { UtteranceGate } from "./UtteranceGate";
import { AudioPlaybackQueue } from "./AudioPlaybackQueue";
import { REALTIME_AUDIO_SAMPLE_RATE } from "../voice/realtimeAudioFormat";
import type { VadConfig } from "../vad";

const WORKLET_URL = "/pcm-worklet-processor.js";
const WORKLET_NAME = "pcm-worklet-processor";
const PCM_INT16_MAX = 0x7fff;
const PCM_INT16_MIN = 0x8000;

export interface RealtimeAudioCaptureOptions {
  gatewayUrl: string;
  sessionId?: string;
  vadConfig?: Partial<VadConfig>;
  onEvent?: RealtimeVoiceClientOptions["onEvent"];
  onProtocolError?: RealtimeVoiceClientOptions["onProtocolError"];
  onSequenceGap?: RealtimeVoiceClientOptions["onSequenceGap"];
  onConnectionClosed?: RealtimeVoiceClientOptions["onConnectionClosed"];
  /** Per-frame input RMS (roughly 0-1), for a live microphone level meter. */
  onLevel?: (rms: number) => void;
  /** Reported whenever `AudioPlaybackQueue`'s injected `play()` throws for one chunk — playback of
   *  later chunks continues regardless (see AudioPlaybackQueue.ts). */
  onPlaybackError?: (error: Error) => void;
}

/** Converts one raw `linear16` PCM chunk (see ../voice/realtimeAudioFormat.ts) into a playable
 *  `AudioBuffer` at the agreed sample rate. */
function decodeLinear16(ctx: AudioContext, chunk: ArrayBuffer): AudioBuffer {
  const pcm16 = new Int16Array(chunk);
  const float32 = new Float32Array(pcm16.length);
  for (let i = 0; i < pcm16.length; i++) {
    const sample = pcm16[i];
    float32[i] = sample / (sample < 0 ? PCM_INT16_MIN : PCM_INT16_MAX);
  }
  const buffer = ctx.createBuffer(1, float32.length, REALTIME_AUDIO_SAMPLE_RATE);
  buffer.copyToChannel(float32, 0);
  return buffer;
}

export class RealtimeAudioCapture {
  readonly client: RealtimeVoiceClient;
  private readonly playbackQueue: AudioPlaybackQueue;
  private readonly gate: UtteranceGate;
  private readonly onLevel: RealtimeAudioCaptureOptions["onLevel"];

  private mediaStream: MediaStream | null = null;
  private captureContext: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private playbackContext: AudioContext | null = null;
  private activePlaybackSource: AudioBufferSourceNode | null = null;

  constructor(opts: RealtimeAudioCaptureOptions) {
    this.onLevel = opts.onLevel;
    this.gate = new UtteranceGate(opts.vadConfig);
    this.client = new RealtimeVoiceClient({
      url: opts.gatewayUrl,
      sessionId: opts.sessionId,
      onEvent: opts.onEvent,
      onProtocolError: opts.onProtocolError,
      onSequenceGap: opts.onSequenceGap,
      onConnectionClosed: opts.onConnectionClosed,
      onAudio: (chunk) => this.playbackQueue.enqueue(chunk),
    });
    this.playbackQueue = new AudioPlaybackQueue({
      play: (chunk) => this.playChunk(chunk),
      onError: opts.onPlaybackError,
    });
  }

  /** Connects to the gateway, then requests microphone access and starts streaming PCM frames.
   *  Throws if the user denies microphone access or the gateway connection fails — surface that to
   *  the UI; nothing here retries automatically. */
  async start(): Promise<void> {
    await this.client.connect();

    this.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
        sampleRate: REALTIME_AUDIO_SAMPLE_RATE,
      },
    });

    this.captureContext = new AudioContext({ sampleRate: REALTIME_AUDIO_SAMPLE_RATE });
    await this.captureContext.audioWorklet.addModule(WORKLET_URL);

    this.micSource = this.captureContext.createMediaStreamSource(this.mediaStream);
    this.workletNode = new AudioWorkletNode(this.captureContext, WORKLET_NAME);
    this.workletNode.port.onmessage = (event: MessageEvent<{ pcm: ArrayBuffer; rms: number }>) => {
      this.handleFrame(event.data.pcm, event.data.rms);
    };
    this.micSource.connect(this.workletNode);
  }

  private handleFrame(pcm: ArrayBuffer, rms: number): void {
    this.onLevel?.(rms);
    for (const signal of this.gate.pushRms(rms)) {
      if (signal === "speech_started") this.client.notifySpeechStarted();
      else if (signal === "utterance_final") this.client.submitUtterance();
    }
    this.client.sendAudioFrame(pcm);
  }

  /** Immediately stops and discards any queued/playing agent audio — wire this to a manual "Stop"
   *  affordance alongside (not instead of) `client.bargeIn()`, which is what actually cancels the
   *  server-side LLM/TTS work generating that audio. */
  interruptPlayback(): void {
    this.activePlaybackSource?.stop();
    this.activePlaybackSource = null;
    this.playbackQueue.clear();
  }

  private async playChunk(chunk: ArrayBuffer): Promise<void> {
    if (!this.playbackContext) this.playbackContext = new AudioContext();
    const ctx = this.playbackContext;
    const audioBuffer = decodeLinear16(ctx, chunk);

    return new Promise((resolve) => {
      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(ctx.destination);
      source.onended = () => {
        if (this.activePlaybackSource === source) this.activePlaybackSource = null;
        resolve();
      };
      this.activePlaybackSource = source;
      source.start();
    });
  }

  /** Stops capture, disconnects the gateway, and releases the microphone. Safe to call more than
   *  once. */
  async stop(): Promise<void> {
    this.interruptPlayback();
    if (this.workletNode) {
      this.workletNode.port.onmessage = null;
      this.workletNode.disconnect();
    }
    this.micSource?.disconnect();
    this.mediaStream?.getTracks().forEach((track) => track.stop());
    await this.captureContext?.close().catch(() => {});
    await this.playbackContext?.close().catch(() => {});
    this.client.end();
    this.client.disconnect();
  }
}
