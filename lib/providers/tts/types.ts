/**
 * Shared, provider-agnostic types for streaming text-to-speech (TTS) providers.
 *
 * Nothing in this file is specific to Sarvam/Bulbul or any other vendor — see `./TTSProvider.ts`
 * for the interface these types support, and `./BulbulV3TTSProvider.ts` for the concrete
 * WebSocket implementation wrapping Sarvam's Bulbul v3 streaming voice.
 */

/** One chunk of encoded audio bytes as delivered by `TTSProvider.onAudioChunk()`. Whatever
 *  container/codec a concrete provider produces is up to that provider — this module makes no
 *  assumption about it. */
export type TTSAudioChunk = ArrayBuffer;

/**
 * Matches the callback signature `TTSProvider.onAudioChunk()` registers. `sequence` is a
 * provider-assigned, zero-based, monotonically increasing index scoped to the current utterance
 * (it resets on cancellation and on reconnect) — chunks always arrive in `sequence` order over a
 * single WebSocket, but a consumer buffering/reassembling audio across a reconnect can use it to
 * detect a gap or a restart rather than assuming order was preserved.
 */
export type TTSAudioChunkCallback = (chunk: TTSAudioChunk, sequence: number) => void;

/** Matches the callback signature `TTSProvider.onComplete()` registers — fired once the provider
 *  has finished delivering audio for everything sent since the last completion (or since
 *  `connect()`/a cancellation, whichever was most recent). */
export type TTSCompletionCallback = () => void;

/**
 * Common, optional configuration most streaming TTS vendors accept in some form. A concrete
 * provider is free to ignore a field it doesn't support (documenting that it does so) and to
 * accept additional vendor-specific options of its own alongside these.
 */
export interface TTSProviderOptions {
  /** Language hint (e.g. "en-IN"). Unlike STT, a TTS voice generally can't "auto-detect" the
   *  language of text it's asked to speak, so this has no "unknown"/"auto" equivalent. */
  languageCode?: string;
  /** Vendor-specific voice/speaker identifier (e.g. Bulbul's `"shubh"`, `"anushka"`, ...). */
  speaker?: string;
}
