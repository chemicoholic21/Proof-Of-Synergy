/**
 * Adapts the app's current STT vendor — Sarvam's Saarika model, via `sarvamTranscribe` in
 * lib/sarvam.ts — onto the vendor-agnostic `STTProvider` interface, so existing functionality
 * keeps working exactly as it does today while the rest of the pipeline is free to depend on
 * `STTProvider` instead of importing `lib/sarvam.ts` directly.
 *
 * Sarvam's speech-to-text endpoint is a single request/response call over one complete audio clip
 * — it has no persistent session and cannot stream partial results (see
 * docs/voice-architecture-current.md, section 4). `STTProvider`, by contrast, models a persistent
 * streaming session: `connect()`, repeated `sendAudio()`, incremental `onPartial()` callbacks,
 * then `disconnect()`. This adapter reconciles the two without changing what Sarvam actually does:
 *
 *   - `connect()` just resets this instance's internal audio buffer and marks it ready to accept
 *     audio. There is nothing to open on Sarvam's side — no request is made here.
 *   - `sendAudio()` appends each chunk to that buffer. Nothing is sent to Sarvam yet.
 *   - `onPartial()` callbacks are accepted, so code written against `STTProvider` never breaks,
 *     but they are never invoked — Sarvam has nothing partial to report. This mirrors
 *     `lib/observability/VoiceMetrics.ts`'s `stt_first_partial` and
 *     `lib/events/interviewEvents.ts`'s `PARTIAL_TRANSCRIPT`, both already documented there as
 *     unproduced until a streaming-capable STT vendor exists.
 *   - `disconnect()` assembles every buffered chunk into one `Blob` and makes exactly the call the
 *     app already makes today (`sarvamTranscribe` — see app/api/transcribe/route.ts), then invokes
 *     every registered `onFinal` callback with the resulting transcript text. If that call throws
 *     (network error, empty transcript, unconfigured key — the same failures `sarvamTranscribe`
 *     already raises), `disconnect()` rejects with the same error; no `onFinal` callback fires and
 *     the session is still marked closed. Callers that need Sarvam's detected language can read
 *     `lastLanguage` afterwards — the base `STTProvider` interface has no field for it.
 *   - `disconnect()` with no buffered audio resolves without calling Sarvam or firing `onFinal` —
 *     there is nothing to transcribe. A second `disconnect()` call while already disconnected is a
 *     no-op (it will not re-transcribe or fire callbacks again).
 *
 * `languageCode` from the shared `STTProviderOptions` is intentionally not honored: the wrapped
 * `sarvamTranscribe` call always asks Sarvam to auto-detect (and code-mix) the language, matching
 * every existing call site, and accepts no override today.
 */

import { sarvamTranscribe } from "../../sarvam";
import type { STTProvider } from "./STTProvider";
import type { STTProviderOptions } from "./types";

type Transcribe = typeof sarvamTranscribe;

const DEFAULT_MIME_TYPE = "audio/webm";
const DEFAULT_FILENAME = "utterance.webm";
const DEFAULT_TIMEOUT_MS = 20000;

export interface SarvamSTTProviderOptions extends STTProviderOptions {
  /**
   * MIME type to label the assembled audio `Blob` with before handing it to Sarvam. Must match
   * whatever container the `ArrayBuffer` chunks passed to `sendAudio()` actually contain — defaults
   * to `"audio/webm"`, the format `VoiceRecorder`'s `MediaRecorder` produces today (see
   * docs/voice-architecture-current.md, section 2).
   */
  mimeType?: string;
  /** Filename Sarvam sees for the assembled clip. Used only for Sarvam's own logging — it does not
   *  affect transcription. */
  filename?: string;
  /** Per-call timeout (ms) forwarded to `sarvamTranscribe`. */
  timeoutMs?: number;
  /** Injected for testing (or an alternate transport). Defaults to the real `sarvamTranscribe`. */
  transcribe?: Transcribe;
}

/** `STTProvider` adapter over Sarvam's Saarika speech-to-text. See the module docstring above for
 *  how it reconciles `STTProvider`'s streaming shape with Sarvam's single-shot API. */
export class SarvamSTTProvider implements STTProvider {
  private readonly mimeType: string;
  private readonly filename: string;
  private readonly timeoutMs: number;
  private readonly transcribe: Transcribe;

  private chunks: ArrayBuffer[] = [];
  private connected = false;
  private readonly partialCallbacks: Array<(text: string) => void> = [];
  private readonly finalCallbacks: Array<(text: string) => void> = [];

  /** Sarvam's detected language for the most recently finalized transcript, or `null` before the
   *  first successful `disconnect()`. Not part of the `STTProvider` interface. */
  lastLanguage: string | null = null;

  constructor(opts: SarvamSTTProviderOptions = {}) {
    this.mimeType = opts.mimeType ?? DEFAULT_MIME_TYPE;
    this.filename = opts.filename ?? DEFAULT_FILENAME;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.transcribe = opts.transcribe ?? sarvamTranscribe;
  }

  async connect(): Promise<void> {
    // Starts a fresh session even if one was already open — any audio buffered but never finalized
    // via disconnect() is discarded, matching "connect() while connected starts a fresh session"
    // from the STTProvider contract.
    this.chunks = [];
    this.connected = true;
  }

  sendAudio(audio: ArrayBuffer): void {
    if (!this.connected) {
      throw new Error("SarvamSTTProvider.sendAudio() called before connect() or after disconnect().");
    }
    this.chunks.push(audio);
  }

  async disconnect(): Promise<void> {
    if (!this.connected) return; // already disconnected - idempotent, per the STTProvider contract
    this.connected = false;

    if (this.chunks.length === 0) return; // nothing captured this session - nothing to transcribe

    const blob = new Blob(this.chunks, { type: this.mimeType });
    this.chunks = [];

    const { text, language } = await this.transcribe(blob, this.filename, this.timeoutMs);
    this.lastLanguage = language;

    for (const callback of this.finalCallbacks) callback(text);
  }

  onPartial(callback: (text: string) => void): void {
    // Accepted for interface conformance; Sarvam's single-shot API never has partial text to
    // report, so this callback is stored but intentionally never invoked (see module docstring).
    this.partialCallbacks.push(callback);
  }

  onFinal(callback: (text: string) => void): void {
    this.finalCallbacks.push(callback);
  }
}
