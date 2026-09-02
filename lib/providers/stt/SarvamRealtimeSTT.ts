/**
 * Production-ready `STTProvider` implementation over Sarvam's realtime speech-to-text WebSocket
 * API, model `saaras:v3-realtime` — the model Sarvam introduced specifically for voice-agent and
 * live-transcription workloads (see https://docs.sarvam.ai/api-reference/speech-to-text/transcribe/realtime/ws).
 *
 * Unlike `SarvamSTTProvider` (the batch-STT adapter over `sarvamTranscribe`, which buffers a whole
 * utterance and makes one request/response call), this class talks to Sarvam over a persistent
 * WebSocket session and genuinely streams: audio goes out as it's captured, and partial transcripts
 * come back while the learner is still talking, with a final transcript per utterance. This is the
 * provider `lib/observability/VoiceMetrics.ts`'s `stt_first_partial` and
 * `lib/events/interviewEvents.ts`'s `PARTIAL_TRANSCRIPT` were written in anticipation of — with
 * this provider wired in, both actually fire instead of reading `NaN`/never firing.
 *
 * SERVER-SIDE ONLY. This class holds the Sarvam API key directly (via the `API-SUBSCRIPTION-KEY`
 * header) and must never run in a browser: the constructor throws immediately if `window` exists,
 * and the module imports the `ws` package, which isn't a browser API and won't bundle into client
 * JS. Instantiate it inside a server route, a server-only WebSocket bridge, or similar — never
 * inside a "use client" component. Nothing exported here reads a client-supplied credential; the
 * key always comes from `SARVAM_API_KEY` (server env, no `NEXT_PUBLIC_` prefix) or an explicit
 * `apiKey` option a server-side caller passes in directly.
 *
 * What this class implements, end to end:
 *   - Connection lifecycle: `connect()` opens the socket and resolves once Sarvam confirms the
 *     session with a `session.begin` message (or rejects on a connect-timeout / early failure).
 *   - Audio streaming: `sendAudio()` base64-encodes each chunk and sends it as an `audio_input`
 *     event immediately, or queues it (bounded) if a reconnect is in flight.
 *   - Partial and final transcripts: `onPartial()`/`onFinal()` per the `STTProvider` interface,
 *     fed by Sarvam's `transcript.partial` / `transcript.final` events.
 *   - VAD configuration: constructor options seed the initial `threshold` / `prefix_padding_ms` /
 *     `silence_duration_ms` / `min_speech_duration_ms` query params; `updateConfig()` changes them
 *     (or `mode`/`streamType`/`endpointing`/`languageCode`/`prompt`) mid-session; `onVadEvent()`
 *     surfaces Sarvam's own `vad.speech_start`/`vad.speech_end` detections.
 *   - Reconnect handling: an unexpected close (anything but a clean app-level rejection) triggers
 *     exponential-backoff reconnect attempts, up to a configurable cap, transparently re-flushing
 *     any audio queued while the socket was down.
 *   - Errors: `onError()` surfaces both app-level `{"event":"error"}` messages and socket-level
 *     failures as one structured `SarvamRealtimeSTTError` shape, without which reconnect logic and
 *     a rejected `disconnect()`/`connect()` would be the caller's only signal something went wrong.
 *   - Clean shutdown: `disconnect()` tells Sarvam the session is over (`{"event":"end"}`), gives it
 *     a bounded window to finalize and reply with `session.end`, then closes the socket itself and
 *     tears down every timer so nothing keeps the process alive or fires after teardown.
 */

import WebSocket from "ws";
import { env } from "../../env";
import { logger } from "../../logger";
import type { STTProvider } from "./STTProvider";
import type { STTProviderOptions } from "./types";

const log = logger.child({ module: "sarvam-realtime-stt" });

const REALTIME_MODEL = "saaras:v3-realtime";
const DEFAULT_WS_URL = "wss://api.sarvam.ai/speech-to-text-realtime/ws";

const READY_STATE = { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 } as const;

/** Sarvam closes with this code when the negotiated audio config (sample rate, etc.) is invalid —
 *  retrying with the same config would just fail the same way, so this code is never retried. */
const CLOSE_CODE_APP_REJECTION = 4000;
/** Our own clean shutdown. Never triggers a reconnect. */
const CLOSE_CODE_NORMAL = 1000;

const STREAM_TYPES = ["fast", "balanced", "simulated"] as const;
const MODES = ["transcribe", "translate", "verbatim", "translit", "codemix"] as const;
const ENDPOINTING_MODES = ["vad", "manual"] as const;
const ENCODINGS = ["linear16", "linear32", "mulaw", "alaw"] as const;
const SAMPLE_RATES = [16000, 8000] as const;

export type SarvamStreamType = (typeof STREAM_TYPES)[number];
export type SarvamTranscribeMode = (typeof MODES)[number];
export type SarvamEndpointingMode = (typeof ENDPOINTING_MODES)[number];
export type SarvamAudioEncoding = (typeof ENCODINGS)[number];
export type SarvamSampleRate = (typeof SAMPLE_RATES)[number];

/** Structured error surfaced to `onError()` callbacks — both Sarvam's own `{"event":"error"}`
 *  messages and lower-level socket failures are normalized to this shape. */
export interface SarvamRealtimeSTTError {
  /** e.g. "invalid_config", "socket_error", "connect_timeout", "reconnect_exhausted". Sarvam's own
   *  wire error codes pass through as-is; failures detected locally use one of the codes above. */
  code: string;
  message: string;
  /** True if the session cannot continue (the caller should treat the provider as unusable until
   *  a fresh `connect()`). False for a warning that doesn't affect the current session. */
  isFatal: boolean;
  statusCode?: number;
}

/** One of Sarvam's own `vad.speech_start` / `vad.speech_end` detections, surfaced to
 *  `onVadEvent()` callbacks. Only fires when `endpointing: "vad"` (the default). */
export interface SarvamVadEvent {
  type: "speech_start" | "speech_end";
  utteranceIndex?: number;
  confidence?: number;
}

export interface SarvamVadConfig {
  /** VAD confidence threshold, 0-1. Applies immediately, mid-session, via `updateConfig()`. */
  threshold?: number;
  /** Milliseconds of audio to keep before a detected speech onset. */
  prefixPaddingMs?: number;
  /** Milliseconds of silence before Sarvam ends the current utterance. Applies immediately. */
  silenceDurationMs?: number;
  /** Minimum speech duration before Sarvam considers it a real utterance, not noise. Applies
   *  immediately. */
  minSpeechDurationMs?: number;
}

export interface SarvamReconnectConfig {
  /** Default `true`. Set `false` to disable reconnect entirely — an unexpected close then just
   *  fires a fatal `onError()` and leaves the provider disconnected. */
  enabled?: boolean;
  /** Default 5. */
  maxAttempts?: number;
  /** Default 500ms. Doubles per attempt, capped at `maxDelayMs`. */
  baseDelayMs?: number;
  /** Default 30000ms. */
  maxDelayMs?: number;
}

/** Minimal surface this module needs from a WebSocket client — satisfied structurally by the `ws`
 *  package's `WebSocket` (the default) and trivially fakeable in tests without a real socket. */
export interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "message", listener: (data: unknown) => void): void;
  on(event: "close", listener: (code: number, reason: Buffer | string) => void): void;
  on(event: "error", listener: (err: Error) => void): void;
}

export type CreateSocket = (url: string, opts: { headers: Record<string, string> }) => WebSocketLike;

const defaultCreateSocket: CreateSocket = (url, opts) =>
  new WebSocket(url, { headers: opts.headers }) as unknown as WebSocketLike;

export interface SarvamRealtimeSTTOptions extends STTProviderOptions {
  /** Defaults to `env.SARVAM_API_KEY`. Never sourced from anything a browser could influence. */
  apiKey?: string;
  /** Defaults to `"auto"` (Sarvam adapts language mid-stream). This is the realtime API's own
   *  auto-detect value — note it is `"auto"` here, not the batch STT endpoint's `"unknown"` (see
   *  `sarvamTranscribe` in lib/sarvam.ts); the two Sarvam APIs use different vocabulary for the
   *  same idea. */
  languageCode?: string;
  /** Overridable only in case Sarvam ships a newer realtime model id later — this task calls for
   *  `"saaras:v3-realtime"`, which is the default. */
  model?: string;
  streamType?: SarvamStreamType;
  mode?: SarvamTranscribeMode;
  endpointing?: SarvamEndpointingMode;
  encoding?: SarvamAudioEncoding;
  sampleRate?: SarvamSampleRate;
  returnTimestamps?: boolean;
  /** Optional context hint passed straight through to Sarvam. */
  prompt?: string;
  vad?: SarvamVadConfig;
  reconnect?: SarvamReconnectConfig;
  /** How long to wait for Sarvam's `session.begin` before `connect()` gives up. Default 10000ms. */
  connectTimeoutMs?: number;
  /** How long `disconnect()` waits for Sarvam's `session.end` reply before closing the socket
   *  itself anyway. Default 3000ms. */
  disconnectTimeoutMs?: number;
  /** How often to ping Sarvam when no audio has been sent, to avoid its inactivity timeout (close
   *  code 1008). Default 15000ms; pass `0` to disable. */
  heartbeatIntervalMs?: number;
  /** Cap on audio chunks queued while a reconnect is in flight — older chunks are dropped once
   *  exceeded, since indefinitely large in-memory audio buffers are exactly what a "production
   *  ready" implementation should refuse to allow. Default 200. */
  maxQueuedAudioChunks?: number;
  /** Base WebSocket URL. Overridable for a self-hosted proxy; defaults to Sarvam's own endpoint. */
  wsUrl?: string;
  /** Injected for testing (or an alternate transport). Defaults to a real `ws` WebSocket. */
  createSocket?: CreateSocket;
}

function assertOneOf<T extends string | number>(value: T, allowed: readonly T[], label: string): void {
  if (!allowed.includes(value)) {
    throw new Error(`SarvamRealtimeSTT: invalid ${label} "${value}". Allowed: ${allowed.join(", ")}.`);
  }
}

/** True unless Sarvam's close code means "your config was rejected, don't bother retrying it." */
function isRecoverableCloseCode(code: number): boolean {
  return code !== CLOSE_CODE_APP_REJECTION;
}

interface ServerMessage {
  event: string;
  [key: string]: unknown;
}

export class SarvamRealtimeSTT implements STTProvider {
  private readonly apiKey: string;
  private readonly wsUrl: string;
  private readonly createSocket: CreateSocket;
  private readonly queryParams: Record<string, string>;
  private readonly connectTimeoutMs: number;
  private readonly disconnectTimeoutMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly maxQueuedAudioChunks: number;
  private readonly reconnectEnabled: boolean;
  private readonly maxReconnectAttempts: number;
  private readonly reconnectBaseDelayMs: number;
  private readonly reconnectMaxDelayMs: number;

  private socket: WebSocketLike | null = null;
  /** True once `connect()` has resolved at least once for the current session and `disconnect()`
   *  hasn't been called since. Distinguishes "mid-reconnect" (sendAudio should queue) from "never
   *  connected / torn down" (sendAudio should throw). */
  private sessionActive = false;
  private intentionalClose = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private connectTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingConnect: { resolve: () => void; reject: (e: Error) => void } | null = null;
  private pendingDisconnectResolve: (() => void) | null = null;
  private audioQueue: ArrayBuffer[] = [];

  private readonly partialCallbacks: Array<(text: string) => void> = [];
  private readonly finalCallbacks: Array<(text: string) => void> = [];
  private readonly errorCallbacks: Array<(error: SarvamRealtimeSTTError) => void> = [];
  private readonly vadCallbacks: Array<(event: SarvamVadEvent) => void> = [];

  /** Sarvam's own `request_id` for the current/most recent session, once `session.begin` arrives. */
  requestId: string | null = null;

  constructor(opts: SarvamRealtimeSTTOptions = {}) {
    if (typeof window !== "undefined") {
      throw new Error(
        "SarvamRealtimeSTT must only run server-side — it holds the Sarvam API key directly. " +
          'Never import this from client-side code (a "use client" component, etc.); wire it up ' +
          "behind a server route or a server-only bridge instead."
      );
    }

    this.apiKey = opts.apiKey ?? env.SARVAM_API_KEY ?? "";
    this.wsUrl = opts.wsUrl ?? DEFAULT_WS_URL;
    this.createSocket = opts.createSocket ?? defaultCreateSocket;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 10_000;
    this.disconnectTimeoutMs = opts.disconnectTimeoutMs ?? 3000;
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? 15_000;
    this.maxQueuedAudioChunks = opts.maxQueuedAudioChunks ?? 200;
    this.reconnectEnabled = opts.reconnect?.enabled ?? true;
    this.maxReconnectAttempts = opts.reconnect?.maxAttempts ?? 5;
    this.reconnectBaseDelayMs = opts.reconnect?.baseDelayMs ?? 500;
    this.reconnectMaxDelayMs = opts.reconnect?.maxDelayMs ?? 30_000;

    const streamType = opts.streamType ?? "balanced";
    const mode = opts.mode ?? "transcribe";
    const endpointing = opts.endpointing ?? "vad";
    const encoding = opts.encoding ?? "linear16";
    const sampleRate = opts.sampleRate ?? 16000;
    assertOneOf(streamType, STREAM_TYPES, "streamType");
    assertOneOf(mode, MODES, "mode");
    assertOneOf(endpointing, ENDPOINTING_MODES, "endpointing");
    assertOneOf(encoding, ENCODINGS, "encoding");
    assertOneOf(sampleRate, SAMPLE_RATES, "sampleRate");

    this.queryParams = {
      language_code: opts.languageCode ?? "auto",
      model: opts.model ?? REALTIME_MODEL,
      stream_type: streamType,
      mode,
      endpointing,
      encoding,
      sample_rate: String(sampleRate),
      return_timestamps: String(opts.returnTimestamps ?? false),
      threshold: String(opts.vad?.threshold ?? 0.3),
      prefix_padding_ms: String(opts.vad?.prefixPaddingMs ?? 300),
      silence_duration_ms: String(opts.vad?.silenceDurationMs ?? 500),
      min_speech_duration_ms: String(opts.vad?.minSpeechDurationMs ?? 250),
    };
    if (opts.prompt) this.queryParams.prompt = opts.prompt;
  }

  // -- STTProvider ------------------------------------------------------------------------------

  async connect(): Promise<void> {
    if (!this.apiKey) throw new Error("SarvamRealtimeSTT: SARVAM_API_KEY not set");

    // Starts a fresh session even if one was already open — mirrors SarvamSTTProvider's contract
    // ("connect() while connected starts a fresh session") but also has a real socket to tear down.
    this.teardownSocket(CLOSE_CODE_NORMAL, "reconnecting via explicit connect()");
    this.intentionalClose = false;
    this.reconnectAttempts = 0;
    this.audioQueue = [];

    await this.openSocket();
    this.sessionActive = true;
  }

  sendAudio(audio: ArrayBuffer): void {
    if (!this.sessionActive) {
      throw new Error("SarvamRealtimeSTT.sendAudio() called before connect() or after disconnect().");
    }
    if (this.socket && this.socket.readyState === READY_STATE.OPEN) {
      this.socket.send(JSON.stringify({ event: "audio_input", audio: bufferToBase64(audio) }));
      this.resetHeartbeat();
    } else {
      // A reconnect is in flight (or hasn't started its socket yet) — queue for replay once the
      // session is re-established, bounded so a long outage can't grow this without limit.
      this.audioQueue.push(audio);
      if (this.audioQueue.length > this.maxQueuedAudioChunks) this.audioQueue.shift();
    }
  }

  async disconnect(): Promise<void> {
    if (!this.sessionActive) return; // never connected, or already torn down — idempotent

    this.intentionalClose = true;
    this.sessionActive = false;
    this.cancelReconnect();
    this.clearHeartbeat();
    this.audioQueue = [];

    const socket = this.socket;
    if (!socket || socket.readyState === READY_STATE.CLOSED) {
      this.socket = null;
      return;
    }

    if (socket.readyState === READY_STATE.OPEN) {
      // Give Sarvam a chance to finalize and reply with session.end before we close from our side.
      try {
        socket.send(JSON.stringify({ event: "end" }));
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

    socket.close(CLOSE_CODE_NORMAL, "client disconnect");
    this.socket = null;
  }

  onPartial(callback: (text: string) => void): void {
    this.partialCallbacks.push(callback);
  }

  onFinal(callback: (text: string) => void): void {
    this.finalCallbacks.push(callback);
  }

  // -- Extensions beyond the base STTProvider contract -------------------------------------------

  /** Register a callback for connection/protocol errors. Not part of `STTProvider` — callers that
   *  only need transcripts can ignore this; callers that need to observe failures (to update a
   *  `TurnManager`, surface a UI toast, etc.) can subscribe here instead of only reacting to a
   *  rejected `connect()`/`disconnect()`. */
  onError(callback: (error: SarvamRealtimeSTTError) => void): void {
    this.errorCallbacks.push(callback);
  }

  /** Register a callback for Sarvam's own VAD speech-start/speech-end detections (only fires with
   *  `endpointing: "vad"`, the default). */
  onVadEvent(callback: (event: SarvamVadEvent) => void): void {
    this.vadCallbacks.push(callback);
  }

  /**
   * Update session config mid-stream. `threshold` / `silenceDurationMs` / `minSpeechDurationMs`
   * apply immediately per Sarvam's docs; `mode` / `streamType` / `endpointing` / `languageCode` /
   * `prompt` are boundary-gated (applied at the next utterance boundary). Fire-and-forget: Sarvam
   * confirms asynchronously with `config.updated`, which this class logs but does not await here.
   */
  updateConfig(patch: {
    languageCode?: string;
    prompt?: string;
    mode?: SarvamTranscribeMode;
    streamType?: Exclude<SarvamStreamType, "simulated">;
    endpointing?: SarvamEndpointingMode;
    vad?: SarvamVadConfig;
  }): void {
    if (!this.socket || this.socket.readyState !== READY_STATE.OPEN) {
      throw new Error("SarvamRealtimeSTT.updateConfig() requires an open connection.");
    }
    const message: Record<string, unknown> = { event: "config.update" };
    if (patch.languageCode !== undefined) message.language_code = patch.languageCode;
    if (patch.prompt !== undefined) message.prompt = patch.prompt;
    if (patch.mode !== undefined) message.mode = patch.mode;
    if (patch.streamType !== undefined) message.stream_type = patch.streamType;
    if (patch.endpointing !== undefined) message.endpointing = patch.endpointing;
    if (patch.vad?.threshold !== undefined) message.threshold = String(patch.vad.threshold);
    if (patch.vad?.silenceDurationMs !== undefined) message.silence_duration_ms = patch.vad.silenceDurationMs;
    if (patch.vad?.minSpeechDurationMs !== undefined) message.min_speech_duration_ms = patch.vad.minSpeechDurationMs;
    this.socket.send(JSON.stringify(message));
  }

  // -- Connection internals -----------------------------------------------------------------------

  private buildUrl(): string {
    const params = new URLSearchParams(this.queryParams);
    return `${this.wsUrl}?${params.toString()}`;
  }

  private openSocket(): Promise<void> {
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
        socket = this.createSocket(this.buildUrl(), { headers: { "API-SUBSCRIPTION-KEY": this.apiKey } });
      } catch (e) {
        settleReject(e as Error);
        return;
      }
      this.socket = socket;
      this.pendingConnect = { resolve: settleResolve, reject: settleReject };

      this.connectTimeoutTimer = setTimeout(() => {
        this.pendingConnect = null;
        socket.close();
        settleReject(new Error(`SarvamRealtimeSTT: timed out waiting for session.begin after ${this.connectTimeoutMs}ms`));
      }, this.connectTimeoutMs);

      socket.on("message", (raw) => this.handleMessage(raw));
      socket.on("close", (code, reason) => this.handleClose(code, reason));
      socket.on("error", (err) => this.handleSocketError(err));
    });
  }

  private handleMessage(raw: unknown): void {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return; // malformed frame — ignore rather than crash the session over it
    }

    switch (msg.event) {
      case "session.begin": {
        this.requestId = typeof msg.request_id === "string" ? msg.request_id : null;
        this.reconnectAttempts = 0;
        this.resetHeartbeat();
        log.info("sarvam realtime session started", { requestId: this.requestId });
        this.pendingConnect?.resolve();
        this.pendingConnect = null;
        this.flushQueuedAudio();
        break;
      }
      case "transcript.partial": {
        const text = typeof msg.text === "string" ? msg.text : "";
        for (const cb of this.partialCallbacks) cb(text);
        break;
      }
      case "transcript.final": {
        const text = typeof msg.text === "string" ? msg.text : "";
        for (const cb of this.finalCallbacks) cb(text);
        break;
      }
      case "vad.speech_start":
      case "vad.speech_end": {
        const event: SarvamVadEvent = {
          type: msg.event === "vad.speech_start" ? "speech_start" : "speech_end",
          utteranceIndex: typeof msg.utterance_idx === "number" ? msg.utterance_idx : undefined,
          confidence: msg.confidence !== undefined ? Number(msg.confidence) : undefined,
        };
        for (const cb of this.vadCallbacks) cb(event);
        break;
      }
      case "error": {
        const error: SarvamRealtimeSTTError = {
          code: typeof msg.code === "string" ? msg.code : "unknown_error",
          message: typeof msg.message === "string" ? msg.message : "Sarvam realtime STT error",
          isFatal: Boolean(msg.is_fatal),
          statusCode: typeof msg.status_code === "number" ? msg.status_code : undefined,
        };
        log.warn("sarvam realtime error event", { ...error });
        this.emitError(error);
        if (!this.pendingConnect) break;
        // The error arrived before session.begin — this connection attempt has failed outright.
        this.pendingConnect.reject(new Error(`${error.code}: ${error.message}`));
        this.pendingConnect = null;
        break;
      }
      case "config.updated": {
        log.info("sarvam realtime config updated", { applied: msg.applied });
        break;
      }
      case "ping": {
        this.socket?.send(JSON.stringify({ event: "pong" }));
        break;
      }
      case "session.end": {
        log.info("sarvam realtime session ended", { requestId: this.requestId });
        this.pendingDisconnectResolve?.();
        this.pendingDisconnectResolve = null;
        break;
      }
      case "pong":
      default:
        break; // pong (our own keepalive reply) and any future/unknown event types are no-ops
    }
  }

  private handleClose(code: number, _reason: Buffer | string): void {
    this.clearHeartbeat();
    // A close while we're still waiting on session.begin is a failed connection attempt, not a
    // mid-session drop — reject connect() (or let reconnect retry it) rather than treating it as
    // "the session ended."
    const wasEstablishing = Boolean(this.pendingConnect);
    if (wasEstablishing) {
      const err = new Error(`SarvamRealtimeSTT: connection closed before session.begin (code ${code})`);
      if (!this.intentionalClose && this.reconnectEnabled && isRecoverableCloseCode(code)) {
        this.pendingConnect = null;
        this.scheduleReconnect();
        return;
      }
      this.pendingConnect?.reject(err);
      this.pendingConnect = null;
    }

    this.pendingDisconnectResolve?.();
    this.pendingDisconnectResolve = null;

    if (this.intentionalClose || !this.sessionActive) return; // our own clean shutdown - done

    if (this.reconnectEnabled && isRecoverableCloseCode(code)) {
      this.scheduleReconnect();
    } else {
      this.sessionActive = false;
      this.emitError({
        code: code === CLOSE_CODE_APP_REJECTION ? "invalid_config" : "connection_closed",
        message: `SarvamRealtimeSTT: connection closed (code ${code}) and will not be retried`,
        isFatal: true,
      });
    }
  }

  private handleSocketError(err: Error): void {
    log.warn("sarvam realtime socket error", { error: err.message });
    this.emitError({ code: "socket_error", message: err.message, isFatal: false });
    // The underlying `ws` socket always follows an "error" event with a "close" event, which is
    // where reconnect/rejection actually happens — nothing further to do here.
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.sessionActive = false;
      this.emitError({
        code: "reconnect_exhausted",
        message: `SarvamRealtimeSTT: gave up after ${this.maxReconnectAttempts} reconnect attempts`,
        isFatal: true,
      });
      return;
    }
    this.reconnectAttempts++;
    const delay = Math.min(this.reconnectBaseDelayMs * 2 ** (this.reconnectAttempts - 1), this.reconnectMaxDelayMs);
    log.warn("sarvam realtime reconnecting", { attempt: this.reconnectAttempts, delayMs: delay });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket().catch(() => {
        // openSocket() already rejects via handleClose()'s own reconnect scheduling on failure, or
        // (once attempts are exhausted) reports a fatal error — nothing more to do with the
        // rejection here, it exists only so this .catch() doesn't surface an unhandled rejection.
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

  private flushQueuedAudio(): void {
    if (this.audioQueue.length === 0) return;
    const queued = this.audioQueue;
    this.audioQueue = [];
    for (const chunk of queued) this.sendAudio(chunk);
  }

  private resetHeartbeat(): void {
    this.clearHeartbeat();
    if (!this.heartbeatIntervalMs) return;
    this.heartbeatTimer = setTimeout(() => {
      if (this.socket?.readyState === READY_STATE.OPEN) {
        this.socket.send(JSON.stringify({ event: "ping" }));
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

  private emitError(error: SarvamRealtimeSTTError): void {
    for (const cb of this.errorCallbacks) cb(error);
  }
}

function bufferToBase64(audio: ArrayBuffer): string {
  return Buffer.from(audio).toString("base64");
}
