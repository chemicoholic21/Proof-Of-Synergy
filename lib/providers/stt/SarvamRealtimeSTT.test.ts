import { describe, it, expect, afterEach } from "vitest";
import { SarvamRealtimeSTT, type WebSocketLike, type CreateSocket, type SarvamRealtimeSTTError } from "./SarvamRealtimeSTT";

/**
 * In-memory stand-in for the `ws` WebSocket this module talks to, driven entirely by the test —
 * no real network, no mocking framework, matching this repo's existing plain-dependency-injection
 * test style (see lib/providers/stt/SarvamSTTProvider.test.ts's injected `transcribe`).
 */
class FakeSocket implements WebSocketLike {
  readyState = 1; // OPEN — the WS handshake itself isn't this module's concern, only the app-level session.begin handshake is
  readonly url: string;
  readonly headers: Record<string, string>;
  sent: string[] = [];
  closeCalls: Array<{ code?: number; reason?: string }> = [];
  private readonly messageHandlers: Array<(data: unknown) => void> = [];
  private readonly closeHandlers: Array<(code: number, reason: Buffer | string) => void> = [];
  private readonly errorHandlers: Array<(err: Error) => void> = [];

  constructor(url: string, headers: Record<string, string>) {
    this.url = url;
    this.headers = headers;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
    if (this.readyState === 3) return;
    this.readyState = 3;
    for (const h of this.closeHandlers) h(code ?? 1000, reason ?? "");
  }

  on(event: "message", listener: (data: unknown) => void): void;
  on(event: "close", listener: (code: number, reason: Buffer | string) => void): void;
  on(event: "error", listener: (err: Error) => void): void;
  on(event: "message" | "close" | "error", listener: (...args: never[]) => void): void {
    if (event === "message") this.messageHandlers.push(listener as (data: unknown) => void);
    else if (event === "close") this.closeHandlers.push(listener as (code: number, reason: Buffer | string) => void);
    else this.errorHandlers.push(listener as (err: Error) => void);
  }

  /** Test helper: deliver a JSON server message. */
  emitMessage(obj: Record<string, unknown>): void {
    for (const h of this.messageHandlers) h(JSON.stringify(obj));
  }

  /** Test helper: simulate the server (or network) closing the connection unexpectedly. */
  emitClose(code: number, reason = ""): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    for (const h of this.closeHandlers) h(code, reason);
  }

  emitError(err: Error): void {
    for (const h of this.errorHandlers) h(err);
  }

  sentEvents(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s));
  }
}

function harness(opts: ConstructorParameters<typeof SarvamRealtimeSTT>[0] = {}) {
  const sockets: FakeSocket[] = [];
  const createSocket: CreateSocket = (url, socketOpts) => {
    const s = new FakeSocket(url, socketOpts.headers);
    sockets.push(s);
    return s;
  };
  const provider = new SarvamRealtimeSTT({ apiKey: "test-key", createSocket, ...opts });
  return { provider, sockets, latest: () => sockets[sockets.length - 1] };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toArrayBuffer(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

describe("SarvamRealtimeSTT — construction and validation", () => {
  it("throws if instantiated where `window` exists (must be server-side only)", () => {
    (globalThis as { window?: unknown }).window = {};
    try {
      expect(() => new SarvamRealtimeSTT({ apiKey: "k" })).toThrow(/server-side/);
    } finally {
      delete (globalThis as { window?: unknown }).window;
    }
  });

  it("rejects an invalid enum option at construction time rather than failing at connect()", () => {
    expect(() => new SarvamRealtimeSTT({ apiKey: "k", mode: "bogus" as never })).toThrow(/invalid mode/);
    expect(() => new SarvamRealtimeSTT({ apiKey: "k", streamType: "bogus" as never })).toThrow(/invalid streamType/);
    expect(() => new SarvamRealtimeSTT({ apiKey: "k", sampleRate: 44100 as never })).toThrow(/invalid sampleRate/);
  });

  it("builds the query string with saaras:v3-realtime and sensible defaults", () => {
    const { provider, sockets } = harness();
    provider.connect(); // fire and forget — we only need the URL createSocket was called with
    const url = new URL(sockets[0].url);
    expect(url.origin + url.pathname).toBe("wss://api.sarvam.ai/speech-to-text-realtime/ws");
    expect(url.searchParams.get("model")).toBe("saaras:v3-realtime");
    expect(url.searchParams.get("language_code")).toBe("auto");
    expect(url.searchParams.get("endpointing")).toBe("vad");
    expect(url.searchParams.get("sample_rate")).toBe("16000");
  });

  it("sends the API key via the API-SUBSCRIPTION-KEY header, never in the URL", () => {
    const { provider, sockets } = harness({ apiKey: "shh-secret" });
    provider.connect();
    expect(sockets[0].headers["API-SUBSCRIPTION-KEY"]).toBe("shh-secret");
    expect(sockets[0].url).not.toContain("shh-secret");
  });
});

describe("SarvamRealtimeSTT — connection lifecycle", () => {
  it("connect() resolves once session.begin arrives", async () => {
    const { provider, sockets } = harness();
    const connectPromise = provider.connect();
    sockets[0].emitMessage({ event: "session.begin", request_id: "req-1" });
    await expect(connectPromise).resolves.toBeUndefined();
    expect(provider.requestId).toBe("req-1");
  });

  it("connect() rejects on a fatal error event that arrives before session.begin", async () => {
    const { provider, sockets } = harness({ reconnect: { enabled: false } });
    const connectPromise = provider.connect();
    sockets[0].emitMessage({ event: "error", code: "invalid_config", is_fatal: true, message: "bad sample rate" });
    await expect(connectPromise).rejects.toThrow(/invalid_config/);
  });

  it("connect() rejects if SARVAM_API_KEY is not configured and no apiKey override is given", async () => {
    const provider = new SarvamRealtimeSTT({ apiKey: "" });
    await expect(provider.connect()).rejects.toThrow(/SARVAM_API_KEY/);
  });

  it("connect() times out if session.begin never arrives", async () => {
    const { provider } = harness({ connectTimeoutMs: 15 });
    await expect(provider.connect()).rejects.toThrow(/timed out/);
  });
});

describe("SarvamRealtimeSTT — audio streaming and transcripts", () => {
  it("throws if sendAudio() is called before connect()", () => {
    const { provider } = harness();
    expect(() => provider.sendAudio(toArrayBuffer("x"))).toThrow(/connect/);
  });

  it("base64-encodes each chunk as an audio_input event once connected", async () => {
    const { provider, sockets } = harness();
    const connectPromise = provider.connect();
    sockets[0].emitMessage({ event: "session.begin" });
    await connectPromise;

    provider.sendAudio(toArrayBuffer("hello"));
    const [event] = sockets[0].sentEvents();
    expect(event.event).toBe("audio_input");
    expect(Buffer.from(event.audio as string, "base64").toString("utf-8")).toBe("hello");
  });

  it("delivers transcript.partial and transcript.final to the right callbacks", async () => {
    const { provider, sockets } = harness();
    const connectPromise = provider.connect();
    sockets[0].emitMessage({ event: "session.begin" });
    await connectPromise;

    const partials: string[] = [];
    const finals: string[] = [];
    provider.onPartial((t) => partials.push(t));
    provider.onFinal((t) => finals.push(t));

    sockets[0].emitMessage({ event: "transcript.partial", text: "hel" });
    sockets[0].emitMessage({ event: "transcript.partial", text: "hello" });
    sockets[0].emitMessage({ event: "transcript.final", text: "hello world" });

    expect(partials).toEqual(["hel", "hello"]);
    expect(finals).toEqual(["hello world"]);
  });

  it("surfaces Sarvam's VAD speech_start/speech_end via onVadEvent", async () => {
    const { provider, sockets } = harness();
    const connectPromise = provider.connect();
    sockets[0].emitMessage({ event: "session.begin" });
    await connectPromise;

    const events: Array<{ type: string; confidence?: number }> = [];
    provider.onVadEvent((e) => events.push({ type: e.type, confidence: e.confidence }));

    sockets[0].emitMessage({ event: "vad.speech_start", utterance_idx: 0, confidence: "0.9" });
    sockets[0].emitMessage({ event: "vad.speech_end", utterance_idx: 0, confidence: "0.8" });

    expect(events).toEqual([
      { type: "speech_start", confidence: 0.9 },
      { type: "speech_end", confidence: 0.8 },
    ]);
  });

  it("replies to a server ping with a pong", async () => {
    const { provider, sockets } = harness();
    const connectPromise = provider.connect();
    sockets[0].emitMessage({ event: "session.begin" });
    await connectPromise;

    sockets[0].emitMessage({ event: "ping" });
    expect(sockets[0].sentEvents()).toContainEqual({ event: "pong" });
  });

  it("ignores a malformed frame instead of throwing", async () => {
    const { provider, sockets } = harness();
    const connectPromise = provider.connect();
    sockets[0].emitMessage({ event: "session.begin" });
    await connectPromise;
    expect(() => sockets[0].emitMessage.call(sockets[0], undefined as never)).not.toThrow();
  });
});

describe("SarvamRealtimeSTT — errors", () => {
  it("onError() receives a non-fatal app-level error without ending the session", async () => {
    const { provider, sockets } = harness();
    const connectPromise = provider.connect();
    sockets[0].emitMessage({ event: "session.begin" });
    await connectPromise;

    const errors: SarvamRealtimeSTTError[] = [];
    provider.onError((e) => errors.push(e));
    sockets[0].emitMessage({ event: "error", code: "rate_limited", is_fatal: false, message: "slow down" });

    expect(errors).toEqual([{ code: "rate_limited", message: "slow down", isFatal: false, statusCode: undefined }]);
    expect(() => provider.sendAudio(toArrayBuffer("still alive"))).not.toThrow();
  });

  it("a socket-level error is reported via onError as non-fatal (the following close decides the outcome)", async () => {
    const { provider, sockets } = harness();
    const connectPromise = provider.connect();
    sockets[0].emitMessage({ event: "session.begin" });
    await connectPromise;

    const errors: SarvamRealtimeSTTError[] = [];
    provider.onError((e) => errors.push(e));
    sockets[0].emitError(new Error("ECONNRESET"));

    expect(errors).toEqual([{ code: "socket_error", message: "ECONNRESET", isFatal: false }]);
  });
});

describe("SarvamRealtimeSTT — reconnect handling", () => {
  it("reconnects with backoff after an unexpected, recoverable close, and flushes audio queued during the gap", async () => {
    const { provider, sockets } = harness({ reconnect: { baseDelayMs: 5, maxAttempts: 3 } });
    const connectPromise = provider.connect();
    sockets[0].emitMessage({ event: "session.begin", request_id: "r1" });
    await connectPromise;

    sockets[0].emitClose(1011); // recoverable: server error, not our own shutdown
    // The socket is down but the session is still logically active — sendAudio should queue, not throw.
    expect(() => provider.sendAudio(toArrayBuffer("queued while down"))).not.toThrow();
    expect(sockets).toHaveLength(1);

    await sleep(20); // let the backoff timer fire and open a second socket
    expect(sockets).toHaveLength(2);
    expect(sockets[1].sent).toHaveLength(0); // not flushed yet - no session.begin on socket 2 yet

    sockets[1].emitMessage({ event: "session.begin", request_id: "r2" });
    await sleep(0);

    expect(provider.requestId).toBe("r2");
    const flushed = sockets[1].sentEvents();
    expect(flushed).toHaveLength(1);
    expect(Buffer.from(flushed[0].audio as string, "base64").toString("utf-8")).toBe("queued while down");
  });

  it("gives up and reports a fatal reconnect_exhausted error after maxAttempts failed reconnects", async () => {
    const { provider, sockets } = harness({ reconnect: { baseDelayMs: 5, maxAttempts: 1 } });
    const connectPromise = provider.connect();
    sockets[0].emitMessage({ event: "session.begin" });
    await connectPromise;

    const errors: SarvamRealtimeSTTError[] = [];
    provider.onError((e) => errors.push(e));

    sockets[0].emitClose(1011); // triggers reconnect attempt #1
    await sleep(20);
    expect(sockets).toHaveLength(2);
    sockets[1].emitClose(1011); // fails before session.begin -> attempt #1 already used -> exhausted
    await sleep(0);

    expect(errors).toContainEqual(
      expect.objectContaining({ code: "reconnect_exhausted", isFatal: true })
    );
    expect(() => provider.sendAudio(toArrayBuffer("too late"))).toThrow(/connect/);
  });

  it("never reconnects after a non-recoverable close (app rejected the config)", async () => {
    const { provider, sockets } = harness({ reconnect: { baseDelayMs: 5 } });
    const connectPromise = provider.connect();
    sockets[0].emitMessage({ event: "session.begin" });
    await connectPromise;

    const errors: SarvamRealtimeSTTError[] = [];
    provider.onError((e) => errors.push(e));
    sockets[0].emitClose(4000);
    await sleep(20);

    expect(sockets).toHaveLength(1); // no reconnect attempt was made
    expect(errors).toContainEqual(expect.objectContaining({ code: "invalid_config", isFatal: true }));
    expect(() => provider.sendAudio(toArrayBuffer("too late"))).toThrow(/connect/);
  });

  it("does not reconnect after our own intentional disconnect()", async () => {
    const { provider, sockets } = harness({ reconnect: { baseDelayMs: 5 } });
    const connectPromise = provider.connect();
    sockets[0].emitMessage({ event: "session.begin" });
    await connectPromise;

    const disconnectPromise = provider.disconnect();
    sockets[0].emitMessage({ event: "session.end" });
    await disconnectPromise;

    await sleep(20);
    expect(sockets).toHaveLength(1); // never opened a second socket
  });
});

describe("SarvamRealtimeSTT — clean shutdown", () => {
  it("disconnect() sends end, waits for session.end, then closes the socket", async () => {
    const { provider, sockets } = harness();
    const connectPromise = provider.connect();
    sockets[0].emitMessage({ event: "session.begin" });
    await connectPromise;

    const disconnectPromise = provider.disconnect();
    expect(sockets[0].sentEvents()).toContainEqual({ event: "end" });
    sockets[0].emitMessage({ event: "session.end", total_utterances: 1 });
    await disconnectPromise;

    expect(sockets[0].closeCalls).toEqual([{ code: 1000, reason: "client disconnect" }]);
  });

  it("disconnect() falls back to closing after disconnectTimeoutMs if session.end never arrives", async () => {
    const { provider, sockets } = harness({ disconnectTimeoutMs: 10 });
    const connectPromise = provider.connect();
    sockets[0].emitMessage({ event: "session.begin" });
    await connectPromise;

    await provider.disconnect(); // no session.end ever sent
    expect(sockets[0].closeCalls).toEqual([{ code: 1000, reason: "client disconnect" }]);
  });

  it("disconnect() is idempotent - calling it twice is safe and closes only once", async () => {
    const { provider, sockets } = harness({ disconnectTimeoutMs: 10 });
    const connectPromise = provider.connect();
    sockets[0].emitMessage({ event: "session.begin" });
    await connectPromise;

    await provider.disconnect();
    await expect(provider.disconnect()).resolves.toBeUndefined();
    expect(sockets[0].closeCalls).toHaveLength(1);
  });

  it("disconnect() before connect() is a safe no-op", async () => {
    const { provider } = harness();
    await expect(provider.disconnect()).resolves.toBeUndefined();
  });

  it("sendAudio() after disconnect() throws rather than silently buffering for a future session", async () => {
    const { provider, sockets } = harness({ disconnectTimeoutMs: 10 });
    const connectPromise = provider.connect();
    sockets[0].emitMessage({ event: "session.begin" });
    await connectPromise;
    await provider.disconnect();

    expect(() => provider.sendAudio(toArrayBuffer("late"))).toThrow(/connect/);
  });

  it("a fresh connect() after disconnect() starts a new, independent session", async () => {
    const { provider, sockets } = harness({ disconnectTimeoutMs: 10 });
    const first = provider.connect();
    sockets[0].emitMessage({ event: "session.begin", request_id: "r1" });
    await first;
    await provider.disconnect();

    const second = provider.connect();
    sockets[1].emitMessage({ event: "session.begin", request_id: "r2" });
    await second;

    expect(provider.requestId).toBe("r2");
    provider.sendAudio(toArrayBuffer("new session"));
    expect(sockets[1].sentEvents().at(-1)?.event).toBe("audio_input");
  });
});

describe("SarvamRealtimeSTT — VAD / config updates", () => {
  it("updateConfig() sends a config.update event with only the provided fields", async () => {
    const { provider, sockets } = harness();
    const connectPromise = provider.connect();
    sockets[0].emitMessage({ event: "session.begin" });
    await connectPromise;

    provider.updateConfig({ languageCode: "hi-IN", vad: { threshold: 0.5, silenceDurationMs: 800 } });

    const [event] = sockets[0].sentEvents();
    expect(event).toEqual({
      event: "config.update",
      language_code: "hi-IN",
      threshold: "0.5",
      silence_duration_ms: 800,
    });
  });

  it("updateConfig() throws when there is no open connection", () => {
    const { provider } = harness();
    expect(() => provider.updateConfig({ languageCode: "en-IN" })).toThrow(/open connection/);
  });
});

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});
