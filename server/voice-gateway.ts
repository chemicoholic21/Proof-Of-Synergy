/**
 * server/voice-gateway.ts
 *
 * The "REALTIME VOICE GATEWAY / Session Controller" box from the architecture diagram —
 * lifecycle, reconnection, sequence numbers, cancellation — sitting between a browser client and
 * one `InterviewPipeline` (../lib/voice/InterviewPipeline.ts) per interview. Before this file
 * existed, the only WebSocket server in this repo was `server/ws-server.ts` (now removed), which
 * never called any of the STT/LLM/TTS pipeline at all (it just echoed raw audio bytes back as if
 * they were a UTF-8 transcript) and wasn't started by any npm script — see
 * docs/voice-architecture-current.md for the full baseline audit this file replaces. Its matching
 * client-side signaling types (`lib/webrtc-signal.ts`) were removed alongside it — nothing else in
 * the repo imported either.
 *
 * ## Wire protocol
 *
 * Binary frames, either direction, are raw PCM audio — no envelope, since WebSocket already
 * guarantees per-connection frame ordering (no sequence numbers needed on audio; see below).
 *
 * Text frames are JSON. Client -> gateway:
 *   { type: "hello", sessionId?: string }        — first message on every connection; omit
 *                                                    sessionId to start a brand-new interview, or
 *                                                    supply a previously-issued one to reconnect
 *                                                    into an in-progress interview (see below).
 *   { type: "speech_started" }                    -> VoiceSession.notifySpeechStarted()
 *   { type: "speech_paused" }                     -> VoiceSession.notifySpeechPaused()
 *   { type: "submit_utterance" }                  -> VoiceSession.submitUtterance()
 *   { type: "barge_in" }                          -> VoiceSession.interrupt()
 *   { type: "end" }                                — client-initiated hangup
 *
 * Gateway -> client:
 *   { seq, type: "hello_ack", sessionId }          — sent once, right after `hello` is handled.
 *   { seq, type: "event", event: InterviewEvent }  — every event `InterviewPipeline.events` emits,
 *                                                    relayed verbatim (see lib/events/interviewEvents.ts).
 *   { seq, type: "error", message }                — a protocol-level error (e.g. audio sent
 *                                                    before `hello`), distinct from an `ERROR`
 *                                                    `InterviewEvent` (a pipeline-level failure).
 *
 * `seq` is a per-session, monotonically increasing counter over every JSON message the gateway
 * sends — it lets a reconnecting client detect a gap (a message it never received) even though
 * this gateway does not implement full event replay (see "Known limitations" below).
 *
 * ## Session lifecycle / reconnection
 *
 * A session is keyed by `sessionId`, not by socket. Losing a socket (a network blip, a page
 * reload) does not immediately tear down the `InterviewPipeline` — `MemoryEngine` state, turn
 * history, and any in-flight background evaluation all need to survive a brief disconnect just as
 * much as a live phone call would. Instead, `reconnectGraceMs` (default 30s) starts a teardown
 * timer; a new connection sending `hello` with the same `sessionId` before that timer fires
 * cancels it and rebinds the pipeline to the new socket, mid-interview. If nothing reconnects in
 * time, the pipeline is properly `end()`-ed (STT/TTS disconnected, evaluation worker stopped).
 *
 * ## Cancellation
 *
 * `barge_in` maps directly to `VoiceSession.interrupt()`, which aborts whichever of the LLM call /
 * TTS playback was in flight — see that method's own docstring for why this is always safe to call
 * unconditionally.
 *
 * ## Known limitations
 * - No event replay: a client that reconnects after missing messages gets the gap made *visible*
 *   via a `seq` jump, not filled in. Full replay would need a persisted per-session event log,
 *   which nothing in this codebase provides yet.
 * - Single Node process, in-memory session map — matches `EvaluationQueue`'s own documented
 *   single-process concurrency model (./../lib/interview/EvaluationQueue.ts). A multi-instance
 *   deployment would need sessions pinned to one instance (e.g. via a load balancer's sticky
 *   sessions) or a shared session store, neither of which this file attempts.
 * - Fully unit-testable: `pipelineFactory` is injectable, so tests exercise the real `ws` wire
 *   protocol over a real loopback socket (nothing about that needs a network, an API key, or a
 *   mock) while never constructing a real `SarvamRealtimeSTT`/`BulbulV3TTSProvider`/`SarvamLLM`.
 */

import { WebSocketServer, WebSocket, type RawData } from "ws";
import type { Server as HTTPServer } from "node:http";
import { randomUUID } from "node:crypto";
import { InterviewPipeline, type InterviewPipelineOptions } from "../lib/voice/InterviewPipeline";
import type { InterviewEvent } from "../lib/events/interviewEvents";
import { logger } from "../lib/logger";

const log = logger.child({ module: "voice-gateway" });

const DEFAULT_RECONNECT_GRACE_MS = 30_000;

type ClientMessage =
  | { type: "hello"; sessionId?: string }
  | { type: "speech_started" }
  | { type: "speech_paused" }
  | { type: "submit_utterance" }
  | { type: "barge_in" }
  | { type: "end" };

export interface VoiceGatewayOptions {
  /** Port to listen on standalone. Ignored if `server` is supplied. Default 3001. */
  port?: number;
  /** Attach to an existing HTTP server instead of listening on its own port. */
  server?: HTTPServer;
  /** Builds a fresh `InterviewPipeline` for a brand-new session id. Defaults to a real pipeline
   *  (SarvamRealtimeSTT/BulbulV3TTSProvider/SarvamLLM, all of which degrade to an `ERROR` event
   *  rather than crash the gateway when no API key is configured). Inject a fake factory in tests. */
  pipelineFactory?: (sessionId: string) => InterviewPipeline;
  /** How long a session's pipeline survives with no socket attached before being torn down.
   *  Default 30000ms. */
  reconnectGraceMs?: number;
}

interface GatewaySession {
  id: string;
  pipeline: InterviewPipeline;
  socket: WebSocket | null;
  seq: number;
  teardownTimer: ReturnType<typeof setTimeout> | null;
}

export interface VoiceGateway {
  wss: WebSocketServer;
  /** Number of sessions currently tracked (connected or within their reconnect grace period). */
  sessionCount(): number;
  /** Closes every session's pipeline, clears all timers, and shuts down the `WebSocketServer`. */
  close(): Promise<void>;
}

function defaultPipelineFactory(sessionId: string): InterviewPipeline {
  const opts: InterviewPipelineOptions = { sessionId };
  return new InterviewPipeline(opts);
}

function toArrayBuffer(data: Buffer): ArrayBuffer {
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
}

/**
 * Starts (or attaches) the realtime voice gateway. See the module docstring for the wire protocol
 * and reconnection semantics.
 */
export function createVoiceGateway(opts: VoiceGatewayOptions = {}): VoiceGateway {
  const pipelineFactory = opts.pipelineFactory ?? defaultPipelineFactory;
  const reconnectGraceMs = opts.reconnectGraceMs ?? DEFAULT_RECONNECT_GRACE_MS;
  const sessions = new Map<string, GatewaySession>();

  const wss = opts.server
    ? new WebSocketServer({ server: opts.server })
    : new WebSocketServer({ port: opts.port ?? 3001 });

  function send(session: GatewaySession, payload: Record<string, unknown>): void {
    if (!session.socket || session.socket.readyState !== WebSocket.OPEN) return;
    session.seq += 1;
    session.socket.send(JSON.stringify({ seq: session.seq, ...payload }));
  }

  function sendEvent(session: GatewaySession, event: InterviewEvent): void {
    send(session, { type: "event", event });
  }

  function sendError(session: GatewaySession, message: string): void {
    send(session, { type: "error", message });
  }

  function clearTeardown(session: GatewaySession): void {
    if (session.teardownTimer) {
      clearTimeout(session.teardownTimer);
      session.teardownTimer = null;
    }
  }

  function scheduleTeardown(session: GatewaySession): void {
    session.socket = null;
    clearTeardown(session);
    session.teardownTimer = setTimeout(() => {
      sessions.delete(session.id);
      session.pipeline.end().catch((e) => {
        log.warn("voice-gateway: error ending pipeline after reconnect grace period", {
          sessionId: session.id,
          error: (e as Error).message,
        });
      });
      log.info("voice-gateway: session torn down (no reconnect within grace period)", { sessionId: session.id });
    }, reconnectGraceMs);
  }

  function getOrCreateSession(sessionId: string | undefined, socket: WebSocket): GatewaySession {
    const id = sessionId ?? randomUUID();
    const existing = sessions.get(id);
    if (existing) {
      clearTeardown(existing);
      existing.socket = socket;
      log.info("voice-gateway: session reconnected", { sessionId: id });
      return existing;
    }

    const pipeline = pipelineFactory(id);
    const session: GatewaySession = { id, pipeline, socket, seq: 0, teardownTimer: null };
    sessions.set(id, session);

    // Registered exactly once per pipeline's lifetime — see InterviewPipeline's own docstring on
    // why VoiceSession.onAudio()/EventBus listeners must never be re-registered per reconnect
    // (they're accumulating listener arrays with no unsubscribe on the VoiceSession side). Reading
    // `sessions.get(id)` fresh on every callback means a reconnect (which only ever mutates
    // `session.socket` in place) is picked up automatically without touching this registration.
    pipeline.session.onAudio((audio) => {
      const current = sessions.get(id);
      if (current?.socket && current.socket.readyState === WebSocket.OPEN) current.socket.send(audio);
    });
    pipeline.events.subscribeAll((event) => {
      const current = sessions.get(id);
      if (current) sendEvent(current, event);
    });

    pipeline.start().catch((e) => {
      log.error("voice-gateway: pipeline.start() failed", { sessionId: id, error: (e as Error).message });
      sendError(session, `Failed to start interview session: ${(e as Error).message}`);
    });

    log.info("voice-gateway: session created", { sessionId: id });
    return session;
  }

  wss.on("connection", (socket: WebSocket) => {
    let session: GatewaySession | null = null;

    socket.on("message", (data: RawData, isBinary: boolean) => {
      if (isBinary) {
        if (!session) return; // audio before `hello` is a protocol error — silently dropped
        try {
          session.pipeline.session.pushAudio(toArrayBuffer(data as Buffer));
        } catch (e) {
          sendError(session, (e as Error).message);
        }
        return;
      }

      let msg: ClientMessage;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }

      if (msg.type === "hello") {
        session = getOrCreateSession(msg.sessionId, socket);
        send(session, { type: "hello_ack", sessionId: session.id });
        return;
      }

      if (!session) return; // must say `hello` before anything else

      switch (msg.type) {
        case "speech_started":
          session.pipeline.session.notifySpeechStarted();
          break;
        case "speech_paused":
          session.pipeline.session.notifySpeechPaused();
          break;
        case "submit_utterance":
          session.pipeline.session.submitUtterance().catch((e) => sendError(session!, (e as Error).message));
          break;
        case "barge_in":
          session.pipeline.session.interrupt();
          break;
        case "end":
          socket.close(1000, "client ended interview");
          break;
      }
    });

    socket.on("close", () => {
      if (session) scheduleTeardown(session);
    });

    socket.on("error", (e: Error) => {
      log.warn("voice-gateway: socket error", { error: e.message, sessionId: session?.id });
    });
  });

  return {
    wss,
    sessionCount: () => sessions.size,
    close: async () => {
      for (const session of sessions.values()) {
        clearTeardown(session);
        await session.pipeline.end().catch(() => {});
      }
      sessions.clear();
      await new Promise<void>((resolve, reject) => {
        wss.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

// Started as a standalone process (`npm run voice-gateway`) rather than imported for its side
// effects — see the module docstring's testability note on why constructing the gateway never
// happens implicitly at import time.
if (require.main === module) {
  const port = parseInt(process.env.VOICE_WS_PORT ?? "3001", 10);
  createVoiceGateway({ port });
  // eslint-disable-next-line no-console
  console.log(`[voice-gateway] listening on port ${port}`);
}
