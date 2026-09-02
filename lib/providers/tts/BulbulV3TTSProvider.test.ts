import { describe, it, expect, afterEach } from "vitest";
import {
  BulbulV3TTSProvider,
  splitForLowLatency,
  MAX_TEXT_MESSAGE_CHARS,
  type WebSocketLike,
  type CreateSocket,
  type BulbulTTSError,
} from "./BulbulV3TTSProvider";

/** In-memory stand-in for the `ws` WebSocket this module talks to — no real network, driven
 *  entirely by the test, matching this repo's existing plain-dependency-injection test style
 *  (see lib/providers/stt/SarvamRealtimeSTT.test.ts's FakeSocket). */
class FakeSocket implements WebSocketLike {
  readyState = 0; // CONNECTING — this provider genuinely waits for a real "open" event
  readonly url: string;
  readonly headers: Record<string, string>;
  sent: string[] = [];
  closeCalls: Array<{ code?: number; reason?: string }> = [];
  private readonly openHandlers: Array<() => void> = [];
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

  on(event: "open", listener: () => void): void;
  on(event: "message", listener: (data: unknown) => void): void;
  on(event: "close", listener: (code: number, reason: Buffer | string) => void): void;
  on(event: "error", listener: (err: Error) => void): void;
  on(event: "open" | "message" | "close" | "error", listener: (...args: never[]) => void): void {
    if (event === "open") this.openHandlers.push(listener as () => void);
    else if (event === "message") this.messageHandlers.push(listener as (data: unknown) => void);
    else if (event === "close") this.closeHandlers.push(listener as (code: number, reason: Buffer | string) => void);
    else this.errorHandlers.push(listener as (err: Error) => void);
  }

  emitOpen(): void {
    this.readyState = 1;
    for (const h of this.openHandlers) h();
  }

  emitMessage(obj: Record<string, unknown>): void {
    for (const h of this.messageHandlers) h(JSON.stringify(obj));
  }

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

function harness(opts: ConstructorParameters<typeof BulbulV3TTSProvider>[0] = {}) {
  const sockets: FakeSocket[] = [];
  const createSocket: CreateSocket = (url, socketOpts) => {
    const s = new FakeSocket(url, socketOpts.headers);
    sockets.push(s);
    return s;
  };
  const provider = new BulbulV3TTSProvider({ apiKey: "test-key", createSocket, ...opts });
  return { provider, sockets };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function connected(overrides: ConstructorParameters<typeof BulbulV3TTSProvider>[0] = {}) {
  const h = harness(overrides);
  const connectPromise = h.provider.connect();
  h.sockets[0].emitOpen();
  await connectPromise;
  return h;
}

function base64Of(text: string): string {
  return Buffer.from(text, "utf-8").toString("base64");
}

describe("BulbulV3TTSProvider — construction and validation", () => {
  it("throws if instantiated where `window` exists (must be server-side only)", () => {
    (globalThis as { window?: unknown }).window = {};
    try {
      expect(() => new BulbulV3TTSProvider({ apiKey: "k" })).toThrow(/server-side/);
    } finally {
      delete (globalThis as { window?: unknown }).window;
    }
  });

  it("validates pace, temperature, minBufferSize, maxChunkLength, and sampleRate ranges", () => {
    expect(() => new BulbulV3TTSProvider({ apiKey: "k", pace: 3 })).toThrow(/pace/);
    expect(() => new BulbulV3TTSProvider({ apiKey: "k", temperature: 2 })).toThrow(/temperature/);
    expect(() => new BulbulV3TTSProvider({ apiKey: "k", minBufferSize: 1 })).toThrow(/minBufferSize/);
    expect(() => new BulbulV3TTSProvider({ apiKey: "k", maxChunkLength: 1000 })).toThrow(/maxChunkLength/);
    expect(() => new BulbulV3TTSProvider({ apiKey: "k", sampleRate: 44100 as never })).toThrow(/sampleRate/);
  });

  it("builds the WS URL with model=bulbul:v3 and send_completion_event, and sends the API key via header", () => {
    const { provider, sockets } = harness({ apiKey: "shh-secret" });
    provider.connect();
    const url = new URL(sockets[0].url);
    expect(url.origin + url.pathname).toBe("wss://api.sarvam.ai/text-to-speech/ws");
    expect(url.searchParams.get("model")).toBe("bulbul:v3");
    expect(url.searchParams.get("send_completion_event")).toBe("true");
    expect(sockets[0].headers["api-subscription-key"]).toBe("shh-secret");
    expect(sockets[0].url).not.toContain("shh-secret");
  });
});

describe("BulbulV3TTSProvider — connection lifecycle", () => {
  it("connect() resolves once the socket opens and sends the config message with sensible defaults", async () => {
    const { sockets } = await connected();
    const [config] = sockets[0].sentEvents();
    expect(config).toMatchObject({
      type: "config",
      data: {
        language_code: "en-IN",
        speaker: "shubh",
        model: "bulbul:v3",
        pace: 1.0,
        speech_sample_rate: 24000,
        enable_preprocessing: true,
        output_audio_codec: "mp3",
        min_buffer_size: 50,
        max_chunk_length: 150,
      },
    });
  });

  it("connect() honors custom voice settings", async () => {
    const { sockets } = await connected({
      languageCode: "hi-IN",
      speaker: "manisha",
      pace: 1.5,
      temperature: 0.7,
      sampleRate: 16000,
      outputAudioCodec: "wav",
    });
    const [config] = sockets[0].sentEvents();
    expect(config.data).toMatchObject({
      language_code: "hi-IN",
      speaker: "manisha",
      pace: 1.5,
      temperature: 0.7,
      speech_sample_rate: 16000,
      output_audio_codec: "wav",
    });
  });

  it("connect() times out if the socket never opens", async () => {
    const { provider } = harness({ connectTimeoutMs: 15 });
    await expect(provider.connect()).rejects.toThrow(/timed out/);
  });

  it("connect() rejects if SARVAM_API_KEY is not configured and no apiKey override is given", async () => {
    const provider = new BulbulV3TTSProvider({ apiKey: "" });
    await expect(provider.connect()).rejects.toThrow(/SARVAM_API_KEY/);
  });
});

describe("BulbulV3TTSProvider — incremental text submission", () => {
  it("throws if sendText() is called before connect()", () => {
    const { provider } = harness();
    expect(() => provider.sendText("hello")).toThrow(/connect/);
  });

  it("sends short text as a single text message", async () => {
    const { provider, sockets } = await connected();
    provider.sendText("Tell me about your last project.");
    const events = sockets[0].sentEvents().filter((e) => e.type === "text");
    expect(events).toEqual([{ type: "text", data: { text: "Tell me about your last project." } }]);
  });

  it("splits text longer than the configured limit into multiple ordered messages", async () => {
    const { provider, sockets } = await connected({ maxTextMessageChars: 20 });
    provider.sendText("one two three four five six seven eight nine ten");
    const pieces = sockets[0]
      .sentEvents()
      .filter((e) => e.type === "text")
      .map((e) => (e.data as { text: string }).text);
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.every((p) => p.length <= 20)).toBe(true);
    expect(pieces.join(" ").replace(/\s+/g, " ")).toBe("one two three four five six seven eight nine ten");
  });
});

describe("splitForLowLatency", () => {
  it("returns the text unchanged (as a single piece) when within the limit", () => {
    expect(splitForLowLatency("short text", 500)).toEqual(["short text"]);
  });

  it("returns an empty array for blank input", () => {
    expect(splitForLowLatency("   ", 500)).toEqual([]);
  });

  it("prefers splitting at a sentence boundary within the window", () => {
    const text = "First sentence here. Second sentence here. Third one runs long enough to overflow.";
    const pieces = splitForLowLatency(text, 40);
    // The first 40-char window only fully contains "First sentence here." (the second sentence is
    // cut off mid-way through), so the split lands there rather than mid-sentence.
    expect(pieces[0]).toBe("First sentence here.");
    expect(pieces[0].endsWith(".")).toBe(true);
    expect(pieces.every((p) => p.length <= 40)).toBe(true);
    // Rejoining every piece reconstructs the original text (modulo the whitespace consumed at cuts).
    expect(pieces.join(" ")).toBe(text);
  });

  it("falls back to a word boundary and never cuts mid-word", () => {
    const text = "supercalifragilisticexpialidocious word two three four five six seven";
    const pieces = splitForLowLatency(text, 15);
    for (const piece of pieces) {
      expect(text).toContain(piece.trim());
    }
  });

  it("defaults MAX_TEXT_MESSAGE_CHARS to 500 (Sarvam's own low-latency recommendation)", () => {
    expect(MAX_TEXT_MESSAGE_CHARS).toBe(500);
  });
});

describe("BulbulV3TTSProvider — audio chunk ordering and completion", () => {
  it("delivers ordered audio chunks and fires onComplete on the final event", async () => {
    const { provider, sockets } = await connected();
    const received: Array<{ text: string; sequence: number }> = [];
    provider.onAudioChunk((chunk, sequence) => {
      received.push({ text: Buffer.from(chunk).toString("utf-8"), sequence });
    });
    let completed = 0;
    provider.onComplete(() => completed++);

    sockets[0].emitMessage({ type: "audio", data: { audio: base64Of("chunk-a"), content_type: "audio/mp3" } });
    sockets[0].emitMessage({ type: "audio", data: { audio: base64Of("chunk-b"), content_type: "audio/mp3" } });
    sockets[0].emitMessage({ type: "event", data: { event_type: "final" } });

    expect(received).toEqual([
      { text: "chunk-a", sequence: 0 },
      { text: "chunk-b", sequence: 1 },
    ]);
    expect(completed).toBe(1);
  });

  it("does not treat a non-final event as completion", async () => {
    const { provider, sockets } = await connected();
    let completed = 0;
    provider.onComplete(() => completed++);
    sockets[0].emitMessage({ type: "event", data: { event_type: "progress" } });
    expect(completed).toBe(0);
  });
});

describe("BulbulV3TTSProvider — flush", () => {
  it("sends a flush message when connected", async () => {
    const { provider, sockets } = await connected();
    provider.flush();
    expect(sockets[0].sentEvents()).toContainEqual({ type: "flush" });
  });

  it("is a harmless no-op when not connected", () => {
    const { provider } = harness();
    expect(() => provider.flush()).not.toThrow();
  });
});

describe("BulbulV3TTSProvider — errors", () => {
  it("onError() receives Bulbul's own error events without ending the session", async () => {
    const { provider, sockets } = await connected();
    const errors: BulbulTTSError[] = [];
    provider.onError((e) => errors.push(e));
    sockets[0].emitMessage({ type: "error", data: { message: "bad request", code: 400 } });
    expect(errors).toEqual([{ code: "400", message: "bad request", isFatal: false }]);
    expect(() => provider.sendText("still alive")).not.toThrow();
  });

  it("reports a socket-level error via onError as non-fatal", async () => {
    const { sockets, provider } = await connected();
    const errors: BulbulTTSError[] = [];
    provider.onError((e) => errors.push(e));
    sockets[0].emitError(new Error("ECONNRESET"));
    expect(errors).toEqual([{ code: "socket_error", message: "ECONNRESET", isFatal: false }]);
  });
});

describe("BulbulV3TTSProvider — cancellation and stale audio", () => {
  it("cancel() closes the current socket and opens a fresh one, ready for a new utterance", async () => {
    const { provider, sockets } = await connected();
    provider.cancel();
    expect(sockets[0].closeCalls).toHaveLength(1);
    await sleep(0);
    expect(sockets).toHaveLength(2);

    sockets[1].emitOpen();
    await sleep(0);
    expect(() => provider.sendText("new utterance")).not.toThrow();
  });

  it("discards audio that arrives on the cancelled socket after cancel() was called", async () => {
    const { provider, sockets } = await connected();
    const received: string[] = [];
    provider.onAudioChunk((chunk) => received.push(Buffer.from(chunk).toString("utf-8")));

    sockets[0].emitMessage({ type: "audio", data: { audio: base64Of("before-cancel") } });
    provider.cancel();
    // Simulate audio that was already in flight over the network when cancel() fired.
    sockets[0].emitMessage({ type: "audio", data: { audio: base64Of("stale-after-cancel") } });

    expect(received).toEqual(["before-cancel"]);
  });

  it("resets the audio sequence counter for the new session after cancel()", async () => {
    const { provider, sockets } = await connected();
    const sequences: number[] = [];
    provider.onAudioChunk((_chunk, seq) => sequences.push(seq));

    sockets[0].emitMessage({ type: "audio", data: { audio: base64Of("a") } });
    sockets[0].emitMessage({ type: "audio", data: { audio: base64Of("b") } });
    provider.cancel();
    await sleep(0);
    sockets[1].emitOpen();
    sockets[1].emitMessage({ type: "audio", data: { audio: base64Of("c") } });

    expect(sequences).toEqual([0, 1, 0]);
  });

  it("cancel() before connect() is a safe no-op", () => {
    const { provider } = harness();
    expect(() => provider.cancel()).not.toThrow();
  });
});

describe("BulbulV3TTSProvider — reconnect handling", () => {
  it("reconnects with backoff after an unexpected close, resending config and flushing queued text", async () => {
    const { provider, sockets } = await connected({ reconnect: { baseDelayMs: 5, maxAttempts: 3 } });

    sockets[0].emitClose(1006); // unexpected close
    expect(() => provider.sendText("queued while down")).not.toThrow();
    expect(sockets).toHaveLength(1);

    await sleep(20);
    expect(sockets).toHaveLength(2);
    expect(sockets[1].sentEvents()).toHaveLength(0); // not open yet - nothing sent

    sockets[1].emitOpen();
    await sleep(0);

    const events = sockets[1].sentEvents();
    expect(events[0].type).toBe("config");
    expect(events.slice(1)).toContainEqual({ type: "text", data: { text: "queued while down" } });
  });

  it("gives up and reports a fatal reconnect_exhausted error after maxAttempts failed reconnects", async () => {
    const { provider, sockets } = await connected({ reconnect: { baseDelayMs: 5, maxAttempts: 1 } });
    const errors: BulbulTTSError[] = [];
    provider.onError((e) => errors.push(e));

    sockets[0].emitClose(1006);
    await sleep(20);
    expect(sockets).toHaveLength(2);
    sockets[1].emitClose(1006); // fails before opening -> attempt #1 already used -> exhausted
    await sleep(0);

    expect(errors).toContainEqual(expect.objectContaining({ code: "reconnect_exhausted", isFatal: true }));
    expect(() => provider.sendText("too late")).toThrow(/connect/);
  });

  it("does not reconnect after our own intentional disconnect()", async () => {
    const { provider, sockets } = await connected({ reconnect: { baseDelayMs: 5 } });
    const disconnectPromise = provider.disconnect();
    sockets[0].emitMessage({ type: "event", data: { event_type: "final" } });
    await disconnectPromise;

    await sleep(20);
    expect(sockets).toHaveLength(1);
  });
});

describe("BulbulV3TTSProvider — clean shutdown", () => {
  it("disconnect() flushes, waits for the final completion event, then closes", async () => {
    const { provider, sockets } = await connected();
    const disconnectPromise = provider.disconnect();
    expect(sockets[0].sentEvents()).toContainEqual({ type: "flush" });
    sockets[0].emitMessage({ type: "event", data: { event_type: "final" } });
    await disconnectPromise;
    expect(sockets[0].closeCalls).toEqual([{ code: 1000, reason: "client disconnect" }]);
  });

  it("disconnect() falls back to closing after disconnectTimeoutMs if no completion event arrives", async () => {
    const { provider, sockets } = await connected({ disconnectTimeoutMs: 10 });
    await provider.disconnect();
    expect(sockets[0].closeCalls).toEqual([{ code: 1000, reason: "client disconnect" }]);
  });

  it("disconnect() is idempotent", async () => {
    const { provider, sockets } = await connected({ disconnectTimeoutMs: 10 });
    await provider.disconnect();
    await expect(provider.disconnect()).resolves.toBeUndefined();
    expect(sockets[0].closeCalls).toHaveLength(1);
  });

  it("disconnect() before connect() is a safe no-op", async () => {
    const { provider } = harness();
    await expect(provider.disconnect()).resolves.toBeUndefined();
  });

  it("sendText() after disconnect() throws rather than silently buffering for a future session", async () => {
    const { provider } = await connected({ disconnectTimeoutMs: 10 });
    await provider.disconnect();
    expect(() => provider.sendText("late")).toThrow(/connect/);
  });
});

describe("BulbulV3TTSProvider — configurable voice settings", () => {
  it("updateVoiceSettings() re-sends config with merged settings", async () => {
    const { provider, sockets } = await connected({ speaker: "shubh" });
    provider.updateVoiceSettings({ speaker: "vidya", pace: 1.2 });
    const configs = sockets[0].sentEvents().filter((e) => e.type === "config");
    expect(configs).toHaveLength(2);
    expect(configs[1].data).toMatchObject({ speaker: "vidya", pace: 1.2, language_code: "en-IN" });
  });

  it("updateVoiceSettings() throws when there is no open connection", () => {
    const { provider } = harness();
    expect(() => provider.updateVoiceSettings({ speaker: "vidya" })).toThrow(/open connection/);
  });

  it("updateVoiceSettings() validates pace/temperature ranges", async () => {
    const { provider } = await connected();
    expect(() => provider.updateVoiceSettings({ pace: 10 })).toThrow(/pace/);
  });
});

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});
