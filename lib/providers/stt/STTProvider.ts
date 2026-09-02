/**
 * Vendor-agnostic speech-to-text (STT) provider contract.
 *
 * `STTProvider` is the seam between the voice pipeline and whichever speech-to-text vendor is
 * actually wired in. Code that needs a transcript should depend on this interface, not on a
 * specific vendor's SDK or HTTP client (e.g. `lib/sarvam.ts`) — that indirection is what lets the
 * vendor be swapped, or replaced with a test double, without touching call sites.
 *
 * The shape models a persistent, streaming session: `connect()` opens it, `sendAudio()` feeds
 * encoded audio as it's captured, `onPartial()`/`onFinal()` register callbacks for transcripts as
 * they arrive, and `disconnect()` closes it. `SarvamSTTProvider` (./SarvamSTTProvider.ts) is the
 * current, and so far only, concrete implementation — see its docstring for how it adapts this
 * streaming-shaped interface onto Sarvam's actual single-request/response Saarika API without
 * changing what the app gets back (see also docs/voice-architecture-current.md, section 4, on why
 * today's STT call isn't actually streaming).
 *
 * This module defines the contract only — nothing here decides which provider is active.
 */
import type { STTProviderOptions } from "./types";

export interface STTProvider {
  /**
   * Open whatever session/connection this provider needs before audio can be sent. Implementations
   * are encouraged (but not required by this interface) to make repeated `connect()` calls safe,
   * treating a `connect()` while already connected as "start a fresh session."
   */
  connect(): Promise<void>;

  /**
   * Feed one chunk of encoded audio captured since the last call (or since `connect()`). Calling
   * this before `connect()` or after `disconnect()` is a caller error; implementations should
   * fail loudly (throw) rather than silently drop audio.
   */
  sendAudio(audio: ArrayBuffer): void;

  /**
   * Close the session. Any audio already sent should be finalized (its transcript delivered via
   * `onFinal`) before this promise resolves, or rejected if it can't be. Safe to call more than
   * once — a second call while already disconnected should be a no-op.
   */
  disconnect(): Promise<void>;

  /**
   * Register a callback for incremental, not-yet-final transcript text. A provider that can't
   * produce partial results (see `SarvamSTTProvider`) is allowed to simply never call it — that is
   * valid, expected behavior for this interface, not an error condition callers need to guard.
   */
  onPartial(callback: (text: string) => void): void;

  /** Register a callback for a finalized transcript. */
  onFinal(callback: (text: string) => void): void;
}

/**
 * Constructs a fresh `STTProvider` instance. Lets callers select a vendor via config/env without
 * importing that vendor's concrete class directly. No factory implementation is wired up yet —
 * this type exists so future config/env-driven selection has a settled shape to target.
 */
export type STTProviderFactory = (opts?: STTProviderOptions) => STTProvider;
