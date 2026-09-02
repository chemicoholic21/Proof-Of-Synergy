/**
 * lib/voice-client/AudioPlaybackQueue.ts
 *
 * The diagram's "AUDIO QUEUE -> PLAYBACK" box: buffers incoming synthesized-speech chunks (which
 * arrive from `RealtimeVoiceClient`'s binary messages, one per `SpeechChunker` piece — see
 * `lib/voice/InterviewPipeline.ts`) and plays them back strictly in order, one at a time, never
 * overlapping two chunks even if they arrive faster than they can be played.
 *
 * Deliberately decoupled from the Web Audio API: `play` is injected as
 * `(chunk: ArrayBuffer) => Promise<void>`, resolving once that chunk has finished sounding. The
 * real, browser-only implementation (decode raw PCM -> AudioBuffer -> AudioBufferSourceNode) lives
 * in `./RealtimeAudioCapture.ts`; this file is the queueing/sequencing policy around it, and is
 * fully unit-testable with a fake `play()` — no AudioContext, no browser, no DOM.
 */

export interface AudioPlaybackQueueOptions {
  /** Plays one chunk to completion. Errors are caught and reported via `onError` rather than
   *  stopping the queue — one bad chunk shouldn't silence every chunk queued after it. */
  play: (chunk: ArrayBuffer) => Promise<void>;
  onError?: (error: Error, chunk: ArrayBuffer) => void;
}

export class AudioPlaybackQueue {
  private readonly play: (chunk: ArrayBuffer) => Promise<void>;
  private readonly onError: (error: Error, chunk: ArrayBuffer) => void;
  private queue: ArrayBuffer[] = [];
  private draining = false;
  /** Bumped by `clear()` — a drain loop started before a `clear()` call checks this to notice it
   *  was cancelled and stop touching `this.queue`/`this.draining`, even if its in-flight `play()`
   *  call resolves late (the same non-cooperative-cancellation guard used throughout this repo's
   *  voice code, e.g. `VoiceSession.runAgentTurn()`). */
  private generation = 0;

  constructor(opts: AudioPlaybackQueueOptions) {
    this.play = opts.play;
    this.onError = opts.onError ?? (() => {});
  }

  /** Add one chunk to the end of the queue. Starts draining immediately if nothing is currently
   *  playing. */
  enqueue(chunk: ArrayBuffer): void {
    this.queue.push(chunk);
    if (!this.draining) void this.drain(this.generation);
  }

  /** How many chunks are queued, including one currently playing (if any). Mainly for tests/UI
   *  status display. */
  get length(): number {
    return this.queue.length + (this.draining ? 1 : 0);
  }

  /** Stops playback immediately and discards every queued-but-not-yet-played chunk — the reaction
   *  to a barge-in (`AGENT_INTERRUPTED`, see lib/voice/VoiceSession.ts), where continuing to play
   *  out stale queued audio over the candidate's own new speech would be exactly wrong. Does not
   *  (and cannot) forcibly stop a `play()` call already in flight — the injected implementation is
   *  responsible for that itself (e.g. by stopping its `AudioBufferSourceNode`); this only ensures
   *  nothing *further* plays once it resolves. */
  clear(): void {
    this.queue = [];
    this.generation++;
    this.draining = false;
  }

  private async drain(generation: number): Promise<void> {
    this.draining = true;
    while (this.queue.length > 0) {
      if (generation !== this.generation) return; // cleared mid-drain — stop touching state
      const chunk = this.queue.shift()!;
      try {
        await this.play(chunk);
      } catch (e) {
        this.onError(e as Error, chunk);
      }
      if (generation !== this.generation) return;
    }
    if (generation === this.generation) this.draining = false;
  }
}
