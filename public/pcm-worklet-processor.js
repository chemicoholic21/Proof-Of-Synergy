/**
 * public/pcm-worklet-processor.js
 *
 * The diagram's "PCM" sub-box, running in the browser's dedicated audio rendering thread — loaded
 * via `AudioContext.audioWorklet.addModule("/pcm-worklet-processor.js")` from
 * ../lib/voice-client/RealtimeAudioCapture.ts (that file's own docstring explains why AEC/noise
 * suppression/gain are handled elsewhere rather than reimplemented here).
 *
 * Web Audio always calls `process()` with a fixed 128-sample render quantum, regardless of what
 * frame size a caller actually wants — this buffers across `process()` calls until `FRAME_SIZE`
 * samples have accumulated, then emits one frame: Float32 -> Int16 PCM, plus that frame's RMS
 * energy (for `UtteranceGate`'s local VAD and a live level meter), posted to the main thread as one
 * `port.postMessage`, transferring the PCM buffer rather than copying it.
 *
 * Plain JS, not TypeScript: `AudioWorkletGlobalScope` is a separate JS realm with no module
 * bundler/transpiler in front of it — this file is served byte-for-byte from `public/`.
 *
 * This file cannot be unit tested in this project's vitest setup (`environment: "node"`, no
 * jsdom, and no environment implements `AudioWorkletProcessor`/`registerProcessor` regardless) —
 * kept intentionally tiny and mechanical so there's as little untested surface as possible.
 */

const SAMPLE_RATE = 16000;
const FRAME_MS = 20;
const FRAME_SIZE = (SAMPLE_RATE * FRAME_MS) / 1000; // 320 samples @ 16kHz/20ms

class PCMWorkletProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(FRAME_SIZE);
    this.bufferIndex = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true; // no input connected yet (e.g. mic still initializing) — keep alive

    for (let i = 0; i < channel.length; i++) {
      this.buffer[this.bufferIndex++] = channel[i];
      if (this.bufferIndex === FRAME_SIZE) {
        this.emitFrame();
        this.bufferIndex = 0;
      }
    }
    return true; // keep this processor alive for the life of the node
  }

  emitFrame() {
    const pcm16 = new Int16Array(FRAME_SIZE);
    let sumSquares = 0;
    for (let i = 0; i < FRAME_SIZE; i++) {
      const clamped = Math.max(-1, Math.min(1, this.buffer[i]));
      sumSquares += clamped * clamped;
      pcm16[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    }
    const rms = Math.sqrt(sumSquares / FRAME_SIZE);
    this.port.postMessage({ pcm: pcm16.buffer, rms }, [pcm16.buffer]);
  }
}

registerProcessor("pcm-worklet-processor", PCMWorkletProcessor);
