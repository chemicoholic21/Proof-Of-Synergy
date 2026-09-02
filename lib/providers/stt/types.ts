/**
 * Shared, provider-agnostic types for speech-to-text (STT) providers.
 *
 * Nothing in this file is specific to Sarvam or any other vendor — see `./STTProvider.ts` for the
 * interface these types support, and `./SarvamSTTProvider.ts` for the concrete adapter wrapping
 * the app's current STT vendor behind it.
 */

/**
 * Raw, encoded audio bytes for one chunk of the current utterance, as passed to
 * `STTProvider.sendAudio()`. Whatever container/codec a concrete provider expects is up to that
 * provider — this module makes no assumption about it.
 */
export type STTAudioChunk = ArrayBuffer;

/** Matches the callback signature `STTProvider.onPartial()` registers. */
export type STTPartialCallback = (text: string) => void;

/** Matches the callback signature `STTProvider.onFinal()` registers. */
export type STTFinalCallback = (text: string) => void;

/**
 * Common, optional configuration most STT vendors accept in some form. A concrete provider is
 * free to ignore a field it doesn't support (documenting that it does so) and to accept
 * additional vendor-specific options of its own alongside these.
 */
export interface STTProviderOptions {
  /**
   * Language hint (e.g. "en-IN"), or "unknown" to ask the provider to auto-detect — the same
   * convention `sarvamTranscribe` in lib/sarvam.ts already uses for its `language_code` field.
   */
  languageCode?: string;
}
