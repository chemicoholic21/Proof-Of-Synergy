/**
 * Vendor-agnostic streaming text-to-speech (TTS) provider contract.
 *
 * `TTSProvider` is the seam between the voice pipeline and whichever TTS vendor is actually wired
 * in. Code that needs synthesized speech should depend on this interface, not on a specific
 * vendor's SDK or HTTP/WebSocket client (e.g. `lib/sarvam.ts`'s batch `sarvamTTS`) — that
 * indirection is what lets the vendor be swapped, or replaced with a test double, without
 * touching call sites.
 *
 * The shape models a persistent, streaming session, mirroring `STTProvider`
 * (lib/providers/stt/STTProvider.ts) but in the opposite direction — text in, audio out:
 * `connect()` opens it, `sendText()` feeds text incrementally as it becomes available (e.g. token
 * by token from `LLMProvider.generateStream()` — see lib/providers/llm/types.ts), `flush()` asks
 * the provider to synthesize whatever's buffered right now rather than waiting for more text,
 * `cancel()` stops the current utterance without tearing down the session, and `disconnect()`
 * closes it. `onAudioChunk()`/`onComplete()` register callbacks for the audio and completion
 * signal as they arrive. `BulbulV3TTSProvider` (./BulbulV3TTSProvider.ts) is the current, and so
 * far only, concrete implementation.
 *
 * This module defines the contract only — nothing here decides which provider is active, and
 * nothing here plays audio (that stays downstream, in whatever actually owns speaker output).
 */
import type { TTSProviderOptions } from "./types";

export interface TTSProvider {
  /**
   * Open whatever session/connection this provider needs before text can be sent. Implementations
   * are encouraged (but not required by this interface) to make repeated `connect()` calls safe,
   * treating a `connect()` while already connected as "start a fresh session."
   */
  connect(): Promise<void>;

  /**
   * Feed a piece of text to be synthesized, in order. Calling this before `connect()` or after
   * `disconnect()` is a caller error; implementations should fail loudly (throw) rather than
   * silently drop text. Safe to call more than once per utterance — text submitted incrementally
   * (e.g. as an LLM streams tokens) should be synthesized as though it had been submitted in one
   * call, once enough of it has arrived for the provider to start producing audio.
   */
  sendText(text: string): void;

  /** Ask the provider to synthesize whatever text has been sent but not yet turned into audio,
   *  rather than waiting for more text or an internal buffering threshold. */
  flush(): void;

  /**
   * Stop the current utterance immediately: no further audio for whatever was sent since the last
   * `cancel()`/completion should ever reach `onAudioChunk()`, even if some was already in flight
   * over the network when this was called. The session itself stays usable — a `cancel()` is not
   * a `disconnect()`; `sendText()` for the *next* utterance can follow right away.
   */
  cancel(): void;

  /** Close the session. Safe to call more than once — a second call while already disconnected
   *  should be a no-op. */
  disconnect(): Promise<void>;

  /** Register a callback for each chunk of synthesized audio, in the order it was generated. */
  onAudioChunk(callback: (chunk: ArrayBuffer, sequence: number) => void): void;

  /** Register a callback fired once the provider has finished delivering audio for everything
   *  sent since the last completion (or since `connect()`/a cancellation). */
  onComplete(callback: () => void): void;
}

/**
 * Constructs a fresh `TTSProvider` instance. Lets callers select a vendor via config/env without
 * importing that vendor's concrete class directly. No factory implementation is wired up yet —
 * this type exists so future config/env-driven selection has a settled shape to target.
 */
export type TTSProviderFactory = (opts?: TTSProviderOptions) => TTSProvider;
