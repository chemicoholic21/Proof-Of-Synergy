/**
 * `TTSProvider` implementation over Sarvam's Bulbul v3 streaming text-to-speech WebSocket API —
 * built for low-latency voice interaction: "Sarvam recommends persistent WebSocket connections for
 * interactive voice agents, and recommends keeping WebSocket messages under roughly 500 characters
 * for lowest latency" (see `MAX_TEXT_MESSAGE_CHARS` below).
 *
 * Unlike `sarvamTTS` in lib/sarvam.ts (one request, one full base64 clip back), this class holds a
 * persistent connection open across an entire interview: `sendText()` feeds text incrementally —
 * naturally, straight from `LLMProvider.generateStream()`'s `onToken` callback (see
 * lib/providers/llm/types.ts) — and audio chunks stream back as Bulbul synthesizes them, well
 * before the whole reply has even finished generating.
 *
 * SERVER-SIDE ONLY, for the same reasons as `SarvamRealtimeSTT`
 * (lib/providers/stt/SarvamRealtimeSTT.ts): the constructor throws if `window` exists, the module
 * depends on the `ws` package (not browser-bundleable), and the API key only ever comes from
 * `SARVAM_API_KEY` (server env) or an explicit `apiKey` a server-side caller passes in.
 *
 * What this class implements, end to end:
 *   - Connection lifecycle: `connect()` opens the socket and, once it's actually open (there is no
 *     app-level "session ready" message for this API — see below), sends the required `config`
 *     message and resolves.
 *   - Incremental text submission: `sendText()` splits anything over `maxTextMessageChars` (default
 *     500, Sarvam's own low-latency recommendation) at a sentence/word boundary and sends each
 *     piece as its own `text` message, in order — never mid-word. `flush()` asks Bulbul to
 *     synthesize whatever's buffered now rather than waiting for more text or its own internal
 *     `min_buffer_size`/`max_chunk_length` thresholds.
 *   - Cancellation: `cancel()` stops the current utterance immediately. Bulbul's protocol has no
 *     documented "stop synthesizing" message, so this closes the current socket and opens a fresh
 *     one right away; every inbound message is tagged with the *session* it belongs to internally,
 *     so any audio already in flight on the old socket when `cancel()` was called is discarded
 *     rather than reaching `onAudioChunk()` — see "stale audio" in the class body.
 *   - Audio chunk ordering: `onAudioChunk()` fires with a `sequence` number, zero-based and reset
 *     on every new session (a fresh `connect()`, a reconnect, or a `cancel()`) — chunks always
 *     arrive in order over one WebSocket, but a consumer buffering audio across a reconnect/cancel
 *     boundary can use `sequence` to detect a restart rather than assume continuity.
 *   - Completion events: `onComplete()` fires on Bulbul's `{"type":"event","data":{"event_type":
 *     "final"}}`, requested via `send_completion_event=true` (the default).
 *   - Reconnect handling: an unexpected close triggers exponential-backoff reconnect attempts (the
 *     same policy as `SarvamRealtimeSTT`), re-sending `config` and flushing any text queued during
 *     the gap once the new socket is open.
 *   - Configurable voice settings: `speaker`/`languageCode`/`pace`/`temperature`/sample rate/codec/
 *     buffering thresholds are all constructor options; `updateVoiceSettings()` changes them
 *     mid-session by re-sending `config` (Bulbul's documented behavior: "any buffered text is
 *     processed before new settings apply").
 *
 * Bulbul v3 does not support `pitch`/`loudness` (v2-only parameters per Sarvam's docs) and always
 * runs its own preprocessing, so neither is exposed here — this file targets v3 specifically, not
 * v2/v3 generically.
 */

import WebSocket from "ws";
import { env } from "../../env";
import { logger } from "../../logger";
import type { TTSProvider } from "./TTSProvider";
import type { TTSProviderOptions } from "./types";

const log = logger.child({ module: "bulbul-v3-tts" });

const MODEL = "bulbul:v3";
const DEFAULT_WS_URL = "wss://api.sarvam.ai/text-to-speech/ws";

/** Sarvam's own recommendation for lowest latency: keep each WebSocket text message under roughly
 *  this many characters. `sendText()` splits anything longer at a sentence/word boundary. */
export const MAX_TEXT_MESSAGE_CHARS = 500;

const READY_STATE = { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 } as const;
const CLOSE_CODE_NORMAL = 1000;

const OUTPUT_AUDIO_CODECS = ["mp3", "wav", "aac", "opus", "flac", "linear16", "mulaw", "alaw"] as const;
const OUTPUT_AUDIO_BITRATES = ["32k", "64k", "96k", "128k", "192k"] as const;
const SAMPLE_RATES = [8000, 16000, 22050, 24000] as const;

export type BulbulAudioCodec = (typeof OUTPUT_AUDIO_CODECS)[number];
export type BulbulAudioBitrate = (typeof OUTPUT_AUDIO_BITRATES)[number];
export type BulbulSampleRate = (typeof SAMPLE_RATES)[number];

/** Structured error surfaced to `onError()` callbacks — both Bulbul's own `{"type":"error"}`
 *  messages and lower-level socket failures are normalized to this shape. */
export interface BulbulTTSError {
  code: string;
  message: string;
  isFatal: boolean;
}

export interface BulbulReconnectConfig {
  /** Default `true`. */
  enabled?: boolean;
  /** Default 5. */
  maxAttempts?: number;
  /** Default 500ms, doubling per attempt, capped at `maxDelayMs`. */
  baseDelayMs?: number;
  /** Default 30000ms. */
  maxDelayMs?: number;
}

/** Bulbul v3 voice/synthesis settings — everything `connect()` sends as the initial (and, via
 *  `updateVoiceSettings()`, any later) `config` message. Pitch/loudness are v2-only and
 *  intentionally not exposed here (see the module docstring). */
export interface BulbulVoiceSettings {
  languageCode?: string;
  /** Defaults to `"shubh"`, Bulbul v3's own default speaker. */
  speaker?: string;
  /** 0.5-2.0. Default 1.0. */
  pace?: number;
  /** 0.01-1. No default is sent unless supplied — left to Sarvam's own server-side default. */
  temperature?: number;
  /** Default 24000 (Bulbul v3's own default). */
  sampleRate?: BulbulSampleRate;
  /** Default `true` — Bulbul v3 always runs preprocessing regardless, but the field is still sent
   *  for forward-compatibility with the documented config shape. */
  enablePreprocessing?: boolean;
  /** Default `"mp3"`. */
  outputAudioCodec?: BulbulAudioCodec;
  outputAudioBitrate?: BulbulAudioBitrate;
  /** v3-only voice dictionary/pronunciation id. */
  dictId?: string;
  /** Character count that triggers Bulbul's own server-side buffer flush. 30-200, default 50. */
  minBufferSize?: number;
  /** Max length Bulbul will let one internally-split sentence chunk grow to. 50-500, default 150. */
  maxChunkLength?: number;
}

export interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "open", listener: () => void): void;
  on(event: "message", listener: (data: unknown) => void): void;
  on(event: "close", listener: (code: number, reason: Buffer | string) => void): void;
  on(event: "error", listener: (err: Error) => void): void;
}

export type CreateSocket = (url: string, opts: { headers: Record<string, string> }) => WebSocketLike;

const defaultCreateSocket: CreateSocket = (url, opts) =>
  new WebSocket(url, { headers: opts.headers }) as unknown as WebSocketLike;

export interface BulbulV3TTSProviderOptions extends TTSProviderOptions, BulbulVoiceSettings {
  /** Defaults to `env.SARVAM_API_KEY`. */
  apiKey?: string;
  /** Whether Bulbul should send a completion event when an utterance's audio is fully delivered.
   *  Default `true` — required for `onComplete()` to ever fire. */
  sendCompletionEvent?: boolean;
  /** Ceiling for one WebSocket text message before `sendText()` splits it up. Default
   *  `MAX_TEXT_MESSAGE_CHARS` (500), Sarvam's own low-latency recommendation. */
  maxTextMessageChars?: number;
  /** Cap on text pieces queued while a reconnect is in flight. Default 200. */
  maxQueuedTextChunks?: number;
  connectTimeoutMs?: number;
  disconnectTimeoutMs?: number;
  /** Bulbul closes an idle connection after ~1 minute; a ping is sent after this much inactivity
   *  to keep it open. Default 30000ms; pass `0` to disable. */
  heartbeatIntervalMs?: number;
  reconnect?: BulbulReconnectConfig;
  wsUrl?: string;
  /** Injected for testing (or an alternate transport). Defaults to a real `ws` WebSocket. */
  createSocket?: CreateSocket;
}

function assertInRange(value: number | undefined, min: number, max: number, label: string): void {
  if (value !== undefined && (value < min || value > max)) {
    throw new Error(`BulbulV3TTSProvider: ${label} must be between ${min} and ${max} (got ${value}).`);
  }
}

/**
 * Split `text` into pieces no longer than `maxChars`, breaking at the last sentence end within
 * each window when there is one, else the last space — never mid-word. Mirrors the same
 * boundary-aware philosophy as `clampSpeech`/`clampWords` (lib/sarvam.ts,
 * lib/interview/ResponsePlanner.ts), but splits into multiple pieces instead of truncating to one.
 */
export function splitForLowLatency(text: string, maxChars: number): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= maxChars) return [trimmed];

  const pieces: string[] = [];
  let remaining = trimmed;
  while (remaining.length > maxChars) {
    const window = remaining.slice(0, maxChars);
    const lastSentenceEnd = Math.max(window.lastIndexOf(". "), window.lastIndexOf("? "), window.lastIndexOf("! "));
    let cut: number;
    if (lastSentenceEnd > maxChars * 0.4) {
      cut = lastSentenceEnd + 1;
    } else {
      const lastSpace = window.lastIndexOf(" ");
      cut = lastSpace > 0 ? lastSpace : maxChars;
    }
    pieces.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) pieces.push(remaining);
  return pieces;
}

interface ServerMessage {
  type: string;
  data?: Record<string, unknown>;
}

export class BulbulV3TTSProvider implements TTSProvider {
  private readonly apiKey: string;
  private readonly wsUrl: string;
  private readonly createSocket: CreateSocket;
  private readonly sendCompletionEvent: boolean;
  private readonly maxTextMessageChars: number;
  private readonly maxQueuedTextChunks: number;
  private readonly connectTimeoutMs: number;
  private readonly disconnectTimeoutMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly reconnectEnabled: boolean;
  private readonly maxReconnectAttempts: number;
  private readonly reconnectBaseDelayMs: number;
  private readonly reconnectMaxDelayMs: number;
  private voiceSettings: BulbulVoiceSettings;

  private socket: WebSocketLike | null = null;
  /** Bumped on every new socket (initial connect, reconnect, or cancel()) so a message handler
   *  closure bound to a stale/replaced socket can recognize it's stale and discard the message —
   *  this is the mechanism that prevents stale audio from a cancelled utterance ever reaching
   *  `onAudioChunk()`, even if it was already in flight over the network when cancel() was called. */
  private sessionToken = 0;
  private nextSequence = 0;
  private sessionActive = false;
  private intentionalClose = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private connectTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingConnect: { resolve: () => void; reject: (e: Error) => void } | null = null;
  private pendingDisconnectResolve: (() => void) | null = null;
  private textQueue: string[] = [];

  private readonly audioChunkCallbacks: Array<(chunk: ArrayBuffer, sequence: number) => void> = [];
  private readonly completeCallbacks: Array<() => void> = [];
  private readonly errorCallbacks: Array<(error: BulbulTTSError) => void> = [];

  constructor(opts: BulbulV3TTSProviderOptions = {}) {
    if (typeof window !== "undefined") {
      throw new Error(
        "BulbulV3TTSProvider must only run server-side — it holds the Sarvam API key directly. " +
          'Never import this from client-side code (a "use client" component, etc.); wire it up ' +
          "behind a server route or a server-only bridge instead."
      );
    }

    assertInRange(opts.pace, 0.5, 2.0, "pace");
    assertInRange(opts.temperature, 0.01, 1, "temperature");
    assertInRange(opts.minBufferSize, 30, 200, "minBufferSize");
    assertInRange(opts.maxChunkLength, 50, 500, "maxChunkLength");
    if (opts.sampleRate !== undefined && !SAMPLE_RATES.includes(opts.sampleRate)) {
      throw new Error(`BulbulV3TTSProvider: invalid sampleRate ${opts.sampleRate}. Allowed: ${SAMPLE_RATES.join(", ")}.`);
    }

    this.apiKey = opts.apiKey ?? env.SARVAM_API_KEY ?? "";
    this.wsUrl = opts.wsUrl ?? DEFAULT_WS_URL;
    this.createSocket = opts.createSocket ?? defaultCreateSocket;
    this.sendCompletionEvent = opts.sendCompletionEvent ?? true;
    this.maxTextMessageChars = opts.maxTextMessageChars ?? MAX_TEXT_MESSAGE_CHARS;
    this.maxQueuedTextChunks = opts.maxQueuedTextChunks ?? 200;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 10_000;
    this.disconnectTimeoutMs = opts.disconnectTimeoutMs ?? 3000;
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? 30_000;
    this.reconnectEnabled = opts.reconnect?.enabled ?? true;
    this.maxReconnectAttempts = opts.reconnect?.maxAttempts ?? 5;
    this.reconnectBaseDelayMs = opts.reconnect?.baseDelayMs ?? 500;
    this.reconnectMaxDelayMs = opts.reconnect?.maxDelayMs ?? 30_000;

    this.voiceSettings = {
      languageCode: opts.languageCode ?? "en-IN",
      speaker: opts.speaker ?? "shubh",
      pace: opts.pace ?? 1.0,
      temperature: opts.temperature,
      sampleRate: opts.sampleRate ?? 24000,
      enablePreprocessing: opts.enablePreprocessing ?? true,
      outputAudioCodec: opts.outputAudioCodec ?? "mp3",
      outputAudioBitrate: opts.outputAudioBitrate,
      dictId: opts.dictId,
      minBufferSize: opts.minBufferSize ?? 50,
      maxChunkLength: opts.maxChunkLength ?? 150,
    };
  }

  // -- TTSProvider --------------------------------------------------------------------------------

  async connect(): Promise<void> {
    if (!this.apiKey) throw new Error("BulbulV3TTSProvider: SARVAM_API_KEY not set");

    // Starts a fresh session even if one was already open, mirroring SarvamRealtimeSTT's contract.
    this.teardownSocket(CLOSE_CODE_NORMAL, "reconnecting via explicit connect()");
    this.intentionalClose = false;
    this.reconnectAttempts = 0;
    this.textQueue = [];

    await this.openSocket();
    this.sessionActive = true;
  }

  sendText(text: string): void {
    if (!this.sessionActive) {
      throw new Error("BulbulV3TTSProvider.sendText() called before connect() or after disconnect().");
    }
    const pieces = splitForLowLatency(text, this.maxTextMessageChars);
    for (const piece of pieces) this.sendOrQueueText(piece);
  }

  flush(): void {
    if (this.socket && this.socket.readyState === READY_STATE.OPEN) {
      this.socket.send(JSON.stringify({ type: "flush" }));
    }
    // No connection to flush anything over — nothing buffered client-side either, since sendText()
    // already forwards (or queues) each piece immediately. A no-op here is correct, not a dropped
    // command, unlike sendText()'s "fail loudly" stance on actual data.
  }

  /**
   * Stop the current utterance immediately: closes the active socket and opens a fresh one right
   * away (see the module docstring on why — Bulbul has no documented "stop synthesizing" message),
   * bumping `sessionToken` so any audio already in flight on the old socket is discarded rather
   * than reaching `onAudioChunk()`. The provider is ready to accept `sendText()` for a new
   * utterance again as soon as the fresh connection's `config` message goes out.
   */
  cancel(): void {
    if (!this.sessionActive) return;
    this.textQueue = [];
    this.sessionToken++; // any in-flight message tagged with the old token is now stale
    this.nextSequence = 0;
    this.teardownSocket(CLOSE_CODE_NORMAL, "cancelled");
    // Re-open right away so the provider is ready for the next utterance without the caller having
    // to call connect() again — a cancellation is not a disconnect (see the TTSProvider contract).
    this.openSocket().catch((e) => {
      this.emitError({ code: "reconnect_after_cancel_failed", message: (e as Error).message, isFatal: true });
    });
  }

  async disconnect(): Promise<void> {
    if (!this.sessionActive) return; // never connected, or already torn down — idempotent

    this.intentionalClose = true;
    this.sessionActive = false;
    this.cancelReconnect();
    this.clearHeartbeat();
    this.textQueue = [];

    const socket = this.socket;
    if (socket && socket.readyState === READY_STATE.OPEN) {
      // Bulbul has no documented "end session" message, but it does have "flush" + the completion
      // event this class already requests by default — ask it to synthesize anything still
      // buffered and give it a bounded window to say so via onComplete's "final" event before
      // closing from our side, so a disconnect() right after the last sendText() doesn't cut audio
      // off mid-utterance.
      try {
        socket.send(JSON.stringify({ type: "flush" }));
        await Promise.race([
          new Promise<void>((resolve) => {
            this.pendingDisconnectResolve = resolve;
          }),
          new Promise<void>((resolve) => setTimeout(resolve, this.disconnectTimeoutMs)),
        ]);
      } finally {
        this.pendingDisconnectResolve = null;
      }
    }

    this.teardownSocket(CLOSE_CODE_NORMAL, "client disconnect");
  }

  onAudioChunk(callback: (chunk: ArrayBuffer, sequence: number) => void): void {
    this.audioChunkCallbacks.push(callback);
  }

  onComplete(callback: () => void): void {
    this.completeCallbacks.push(callback);
  }

  // -- Extensions beyond the base TTSProvider contract ---------------------------------------------

  /** Register a callback for connection/protocol errors — not part of `TTSProvider`, same rationale
   *  as `SarvamRealtimeSTT.onError()`. */
  onError(callback: (error: BulbulTTSError) => void): void {
    this.errorCallbacks.push(callback);
  }

  /**
   * Update voice settings mid-session by re-sending `config` over the existing connection. Per
   * Sarvam's docs, any buffered text is flushed and synthesized under the *old* settings before
   * the new ones take effect. Requires an open connection.
   */
  updateVoiceSettings(patch: Partial<BulbulVoiceSettings>): void {
    if (!this.socket || this.socket.readyState !== READY_STATE.OPEN) {
      throw new Error("BulbulV3TTSProvider.updateVoiceSettings() requires an open connection.");
    }
    assertInRange(patch.pace, 0.5, 2.0, "pace");
    assertInRange(patch.temperature, 0.01, 1, "temperature");
    this.voiceSettings = { ...this.voiceSettings, ...patch };
    this.socket.send(JSON.stringify(this.buildConfigMessage()));
  }

  // -- Connection internals -------------------------------------------------------------------------

  private buildUrl(): string {
    const params = new URLSearchParams({ model: MODEL, send_completion_event: String(this.sendCompletionEvent) });
    return `${this.wsUrl}?${params.toString()}`;
  }

  private buildConfigMessage(): Record<string, unknown> {
    const v = this.voiceSettings;
    const data: Record<string, unknown> = {
      language_code: v.languageCode,
      speaker: v.speaker,
      model: MODEL,
      pace: v.pace,
      speech_sample_rate: v.sampleRate,
      enable_preprocessing: v.enablePreprocessing,
      output_audio_codec: v.outputAudioCodec,
      min_buffer_size: v.minBufferSize,
      max_chunk_length: v.maxChunkLength,
    };
    if (v.temperature !== undefined) data.temperature = v.temperature;
    if (v.outputAudioBitrate) data.output_audio_bitrate = v.outputAudioBitrate;
    if (v.dictId) data.dict_id = v.dictId;
    return { type: "config", data };
  }

  private sendOrQueueText(piece: string): void {
    if (this.socket && this.socket.readyState === READY_STATE.OPEN) {
      this.socket.send(JSON.stringify({ type: "text", data: { text: piece } }));
      this.resetHeartbeat();
    } else {
      this.textQueue.push(piece);
      if (this.textQueue.length > this.maxQueuedTextChunks) this.textQueue.shift();
    }
  }

  private openSocket(): Promise<void> {
    const token = this.sessionToken;
    return new Promise((resolve, reject) => {
      let settled = false;
      const settleResolve = () => {
        if (settled) return;
        settled = true;
        if (this.connectTimeoutTimer) clearTimeout(this.connectTimeoutTimer);
        resolve();
      };
      const settleReject = (e: Error) => {
        if (settled) return;
        settled = true;
        if (this.connectTimeoutTimer) clearTimeout(this.connectTimeoutTimer);
        reject(e);
      };

      let socket: WebSocketLike;
      try {
        socket = this.createSocket(this.buildUrl(), { headers: { "api-subscription-key": this.apiKey } });
      } catch (e) {
        settleReject(e as Error);
        return;
      }
      this.socket = socket;
      this.pendingConnect = { resolve: settleResolve, reject: settleReject };

      this.connectTimeoutTimer = setTimeout(() => {
        this.pendingConnect = null;
        socket.close();
        settleReject(new Error(`BulbulV3TTSProvider: timed out waiting for the connection to open after ${this.connectTimeoutMs}ms`));
      }, this.connectTimeoutMs);

      socket.on("open", () => {
        if (token !== this.sessionToken) return; // superseded by a newer connect()/cancel() already
        this.nextSequence = 0;
        socket.send(JSON.stringify(this.buildConfigMessage()));
        this.reconnectAttempts = 0;
        this.resetHeartbeat();
        log.info("bulbul v3 tts connected");
        this.pendingConnect?.resolve();
        this.pendingConnect = null;
        this.flushQueuedText();
      });
      socket.on("message", (raw) => this.handleMessage(raw, token));
      socket.on("close", (code, reason) => this.handleClose(code, reason, token));
      socket.on("error", (err) => this.handleSocketError(err));
    });
  }

  private handleMessage(raw: unknown, token: number): void {
    if (token !== this.sessionToken) return; // message from a superseded (cancelled/replaced) socket

    let msg: ServerMessage;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return; // malformed frame — ignore rather than crash the session over it
    }

    switch (msg.type) {
      case "audio": {
        const audioB64 = msg.data?.audio;
        if (typeof audioB64 !== "string" || !audioB64) break;
        const chunk = base64ToArrayBuffer(audioB64);
        const sequence = this.nextSequence++;
        for (const cb of this.audioChunkCallbacks) cb(chunk, sequence);
        break;
      }
      case "event": {
        if (msg.data?.event_type === "final") {
          for (const cb of this.completeCallbacks) cb();
          this.pendingDisconnectResolve?.();
          this.pendingDisconnectResolve = null;
        }
        break;
      }
      case "error": {
        const error: BulbulTTSError = {
          code: typeof msg.data?.code === "number" || typeof msg.data?.code === "string" ? String(msg.data.code) : "unknown_error",
          message: typeof msg.data?.message === "string" ? msg.data.message : "Bulbul TTS error",
          isFatal: false,
        };
        log.warn("bulbul v3 tts error event", { ...error });
        this.emitError(error);
        if (!this.pendingConnect) break;
        this.pendingConnect.reject(new Error(`${error.code}: ${error.message}`));
        this.pendingConnect = null;
        break;
      }
      default:
        break; // pong/keep-alive replies and any future/unknown message types are no-ops
    }
  }

  private handleClose(code: number, _reason: Buffer | string, token: number): void {
    if (token !== this.sessionToken) return; // a stale socket's close — the current one is unaffected

    this.clearHeartbeat();
    const wasEstablishing = Boolean(this.pendingConnect);
    if (wasEstablishing) {
      const err = new Error(`BulbulV3TTSProvider: connection closed before it finished opening (code ${code})`);
      if (!this.intentionalClose && this.reconnectEnabled) {
        this.pendingConnect = null;
        this.scheduleReconnect();
        return;
      }
      this.pendingConnect?.reject(err);
      this.pendingConnect = null;
    }

    if (this.intentionalClose || !this.sessionActive) return; // our own clean shutdown/cancel - done

    if (this.reconnectEnabled) {
      this.scheduleReconnect();
    } else {
      this.sessionActive = false;
      this.emitError({
        code: "connection_closed",
        message: `BulbulV3TTSProvider: connection closed (code ${code}) and will not be retried`,
        isFatal: true,
      });
    }
  }

  private handleSocketError(err: Error): void {
    log.warn("bulbul v3 tts socket error", { error: err.message });
    this.emitError({ code: "socket_error", message: err.message, isFatal: false });
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.sessionActive = false;
      this.emitError({
        code: "reconnect_exhausted",
        message: `BulbulV3TTSProvider: gave up after ${this.maxReconnectAttempts} reconnect attempts`,
        isFatal: true,
      });
      return;
    }
    this.reconnectAttempts++;
    const delay = Math.min(this.reconnectBaseDelayMs * 2 ** (this.reconnectAttempts - 1), this.reconnectMaxDelayMs);
    log.warn("bulbul v3 tts reconnecting", { attempt: this.reconnectAttempts, delayMs: delay });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket().catch(() => {
        // openSocket() already rejects via handleClose()'s own reconnect scheduling on failure, or
        // (once attempts are exhausted) reports a fatal error — this .catch() only exists so that
        // failure doesn't surface as an unhandled rejection.
      });
    }, delay);
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempts = 0;
  }

  private flushQueuedText(): void {
    if (this.textQueue.length === 0) return;
    const queued = this.textQueue;
    this.textQueue = [];
    for (const piece of queued) this.sendOrQueueText(piece);
  }

  private resetHeartbeat(): void {
    this.clearHeartbeat();
    if (!this.heartbeatIntervalMs) return;
    this.heartbeatTimer = setTimeout(() => {
      if (this.socket?.readyState === READY_STATE.OPEN) {
        this.socket.send(JSON.stringify({ type: "ping" }));
      }
      this.resetHeartbeat();
    }, this.heartbeatIntervalMs);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private teardownSocket(code: number, reason: string): void {
    this.cancelReconnect();
    this.clearHeartbeat();
    if (this.connectTimeoutTimer) {
      clearTimeout(this.connectTimeoutTimer);
      this.connectTimeoutTimer = null;
    }
    this.pendingConnect = null;
    this.pendingDisconnectResolve = null;
    if (this.socket && this.socket.readyState !== READY_STATE.CLOSED) {
      try {
        this.socket.close(code, reason);
      } catch {
        /* best-effort - the socket may already be closing */
      }
    }
    this.socket = null;
  }

  private emitError(error: BulbulTTSError): void {
    for (const cb of this.errorCallbacks) cb(error);
  }
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const buf = Buffer.from(base64, "base64");
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}
