/**
 * lib/voice-client/RealtimeVoiceClient.ts
 *
 * The browser-side half of `server/voice-gateway.ts`'s wire protocol — see that file's module
 * docstring for the authoritative protocol description (both sides must agree; this file mirrors
 * it exactly). Deliberately DOM-free except for the *type* of the default socket (the real
 * `WebSocket` global, only ever constructed lazily inside `defaultCreateSocket`, never at module
 * load time) — `createSocket` is injectable, so every bit of protocol logic here (message framing,
 * `hello`/`hello_ack` handshake, event/audio routing, sequence-gap detection) is unit-testable
 * with a fake socket, matching this repo's `SarvamRealtimeSTT`/`BulbulV3TTSProvider` pattern
 * exactly (see lib/providers/stt/SarvamRealtimeSTT.ts, lib/providers/tts/BulbulV3TTSProvider.ts).
 *
 * What this class does *not* do: capture audio, run VAD, or play anything back. Composing those
 * (via `./UtteranceGate.ts`, `./AudioPlaybackQueue.ts`, and the real Web Audio API) is
 * `./RealtimeAudioCapture.ts`'s job — kept separate so this file's protocol logic never needs a
 * browser to test.
 */

import type { InterviewEvent } from "../events/interviewEvents";

/** The minimal surface this class needs from a WebSocket — matches the browser's native
 *  `WebSocket` structurally (property-assigned handlers, not `addEventListener`, since this class
 *  is the only consumer and never needs more than one handler per event). */
export interface RealtimeSocketLike {
  readyState: number;
  send(data: string | ArrayBufferLike): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export type CreateSocket = (url: string) => RealtimeSocketLike;

/** Mirrors `WebSocket.OPEN` (1) without depending on the global existing — this file only reads
 *  `readyState`, and hardcoding the numeric value keeps it usable in any environment (including
 *  this file's own unit tests) regardless of whether a real `WebSocket` constructor is present. */
const READY_STATE_OPEN = 1;

function defaultCreateSocket(url: string): RealtimeSocketLike {
  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  return socket as unknown as RealtimeSocketLike;
}

export type RealtimeConnectionState = "idle" | "connecting" | "open" | "closed";

export interface RealtimeVoiceClientOptions {
  /** The gateway's WebSocket URL, e.g. `ws://localhost:3001`. */
  url: string;
  /** Reconnect into a previously-issued session instead of starting a new interview — see
   *  server/voice-gateway.ts's reconnection semantics. Omit to let the gateway assign one. */
  sessionId?: string;
  createSocket?: CreateSocket;
  /** Every relayed `InterviewEvent` (transcripts, agent turn lifecycle, errors, ...). */
  onEvent?: (event: InterviewEvent) => void;
  /** One synthesized-speech chunk, in arrival order — feed straight to `AudioPlaybackQueue.enqueue()`. */
  onAudio?: (chunk: ArrayBuffer) => void;
  /** A gateway-level protocol error (distinct from an `ERROR` `InterviewEvent`), e.g. audio sent
   *  before `hello` or a session that failed to start. */
  onProtocolError?: (message: string) => void;
  /** Fired when an incoming message's `seq` isn't exactly one more than the last — see
   *  server/voice-gateway.ts's module docstring: this gateway makes a gap *visible*, it doesn't
   *  replay what was missed. A caller might surface "connection was unstable" to the user. */
  onSequenceGap?: (expectedSeq: number, actualSeq: number) => void;
  onConnectionClosed?: (event: { code: number; reason: string }) => void;
}

/** Thrown by any send method called before `connect()`'s promise has resolved, or after
 *  `disconnect()`/a socket close — mirrors `VoiceSession.pushAudio()`'s "throw on misuse rather
 *  than silently drop" convention elsewhere in this codebase. */
export class RealtimeVoiceClientNotConnectedError extends Error {
  constructor(method: string) {
    super(`RealtimeVoiceClient.${method}() called while not connected — call connect() first.`);
    this.name = "RealtimeVoiceClientNotConnectedError";
  }
}

export class RealtimeVoiceClient {
  private readonly url: string;
  private readonly requestedSessionId: string | undefined;
  private readonly createSocket: CreateSocket;
  private readonly onEvent: RealtimeVoiceClientOptions["onEvent"];
  private readonly onAudio: RealtimeVoiceClientOptions["onAudio"];
  private readonly onProtocolError: RealtimeVoiceClientOptions["onProtocolError"];
  private readonly onSequenceGap: RealtimeVoiceClientOptions["onSequenceGap"];
  private readonly onConnectionClosed: RealtimeVoiceClientOptions["onConnectionClosed"];

  private socket: RealtimeSocketLike | null = null;
  private state: RealtimeConnectionState = "idle";
  private assignedSessionId: string | null = null;
  private nextExpectedSeq: number | null = null;
  private resolveConnect: (() => void) | null = null;
  private rejectConnect: ((e: Error) => void) | null = null;

  constructor(opts: RealtimeVoiceClientOptions) {
    this.url = opts.url;
    this.requestedSessionId = opts.sessionId;
    this.createSocket = opts.createSocket ?? defaultCreateSocket;
    this.onEvent = opts.onEvent;
    this.onAudio = opts.onAudio;
    this.onProtocolError = opts.onProtocolError;
    this.onSequenceGap = opts.onSequenceGap;
    this.onConnectionClosed = opts.onConnectionClosed;
  }

  get connectionState(): RealtimeConnectionState {
    return this.state;
  }

  /** The gateway-assigned session id, available once `connect()` resolves — `null` before then. */
  get sessionId(): string | null {
    return this.assignedSessionId;
  }

  /** Opens the socket, sends `hello`, and resolves once the gateway's `hello_ack` arrives (i.e.
   *  once `sessionId` is actually known) — resolving on the raw socket `open` event alone would
   *  let a caller start sending audio before a session/pipeline exists on the other end. */
  connect(): Promise<void> {
    if (this.state !== "idle" && this.state !== "closed") {
      return Promise.reject(new Error("RealtimeVoiceClient.connect() called while already connecting/connected."));
    }
    this.state = "connecting";
    return new Promise((resolve, reject) => {
      this.resolveConnect = resolve;
      this.rejectConnect = reject;

      const socket = this.createSocket(this.url);
      this.socket = socket;

      socket.onopen = () => {
        socket.send(JSON.stringify({ type: "hello", sessionId: this.requestedSessionId }));
      };
      socket.onmessage = (event) => this.handleMessage(event.data);
      socket.onclose = (event) => {
        this.state = "closed";
        if (this.rejectConnect) {
          this.rejectConnect(new Error("RealtimeVoiceClient: connection closed before hello_ack"));
          this.resolveConnect = null;
          this.rejectConnect = null;
        }
        this.onConnectionClosed?.(event);
      };
      socket.onerror = () => {
        if (this.rejectConnect) {
          this.rejectConnect(new Error("RealtimeVoiceClient: connection failed"));
          this.resolveConnect = null;
          this.rejectConnect = null;
        }
      };
    });
  }

  private handleMessage(data: unknown): void {
    if (data instanceof ArrayBuffer) {
      this.onAudio?.(data);
      return;
    }

    let msg: { seq?: number; type?: string; sessionId?: string; event?: InterviewEvent; message?: string };
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }

    if (typeof msg.seq === "number") {
      if (this.nextExpectedSeq !== null && msg.seq !== this.nextExpectedSeq) {
        this.onSequenceGap?.(this.nextExpectedSeq, msg.seq);
      }
      this.nextExpectedSeq = msg.seq + 1;
    }

    switch (msg.type) {
      case "hello_ack":
        this.state = "open";
        this.assignedSessionId = msg.sessionId ?? null;
        this.resolveConnect?.();
        this.resolveConnect = null;
        this.rejectConnect = null;
        break;
      case "event":
        if (msg.event) this.onEvent?.(msg.event);
        break;
      case "error":
        if (msg.message) this.onProtocolError?.(msg.message);
        break;
    }
  }

  private send(payload: Record<string, unknown>): void {
    if (!this.socket || this.socket.readyState !== READY_STATE_OPEN || this.state !== "open") {
      throw new RealtimeVoiceClientNotConnectedError(String(payload.type ?? "send"));
    }
    this.socket.send(JSON.stringify(payload));
  }

  /** Forward one PCM audio frame captured from the microphone (see ./RealtimeAudioCapture.ts). */
  sendAudioFrame(pcm: ArrayBuffer): void {
    if (!this.socket || this.socket.readyState !== READY_STATE_OPEN || this.state !== "open") {
      throw new RealtimeVoiceClientNotConnectedError("sendAudioFrame");
    }
    this.socket.send(pcm);
  }

  /** The candidate started speaking — also implicitly a barge-in if the agent was mid-turn (see
   *  `VoiceSession.notifySpeechStarted()`'s own docstring). */
  notifySpeechStarted(): void {
    this.send({ type: "speech_started" });
  }

  notifySpeechPaused(): void {
    this.send({ type: "speech_paused" });
  }

  /** Local VAD (`./UtteranceGate.ts`) has decided the utterance is finished — ask the gateway's
   *  STT provider to finalize. */
  submitUtterance(): void {
    this.send({ type: "submit_utterance" });
  }

  /** Explicit cancellation independent of the candidate speaking (e.g. a "Stop" button) — see
   *  server/voice-gateway.ts's module docstring on why this is distinct from `notifySpeechStarted()`. */
  bargeIn(): void {
    this.send({ type: "barge_in" });
  }

  /** Client-initiated, graceful end of the interview. */
  end(): void {
    this.send({ type: "end" });
  }

  /** Tears down the socket without notifying the gateway — use `end()` for a graceful hangup.
   *  Safe to call more than once. */
  disconnect(): void {
    this.socket?.close();
    this.socket = null;
    this.state = "closed";
  }
}
