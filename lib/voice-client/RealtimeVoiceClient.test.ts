import { describe, it, expect } from "vitest";
import {
  RealtimeVoiceClient,
  RealtimeVoiceClientNotConnectedError,
  type RealtimeSocketLike,
} from "./RealtimeVoiceClient";
import type { InterviewEvent } from "../events/interviewEvents";

const READY_STATE_CONNECTING = 0;
const READY_STATE_OPEN = 1;
const READY_STATE_CLOSED = 3;

/** In-memory `RealtimeSocketLike` test double — no real network, matching this repo's plain-DI
 *  test convention (see lib/providers/tts/BulbulV3TTSProvider.test.ts's `FakeSocket` for the
 *  server-side equivalent of this same pattern). */
class FakeSocket implements RealtimeSocketLike {
  readyState = READY_STATE_CONNECTING;
  sent: Array<string | ArrayBufferLike> = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  send(data: string | ArrayBufferLike): void {
    this.sent.push(data);
  }
  close(code = 1000, reason = ""): void {
    this.readyState = READY_STATE_CLOSED;
    this.onclose?.({ code, reason });
  }
  simulateOpen(): void {
    this.readyState = READY_STATE_OPEN;
    this.onopen?.();
  }
  simulateJson(payload: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
  simulateBinary(buf: ArrayBuffer): void {
    this.onmessage?.({ data: buf });
  }
}

function sentJson(socket: FakeSocket, index: number): Record<string, unknown> {
  return JSON.parse(socket.sent[index] as string);
}

/** Connects a client against a fresh `FakeSocket`, driving it through open + hello_ack, and
 *  returns both once `connect()` has resolved. */
async function connected(
  overrides: Partial<ConstructorParameters<typeof RealtimeVoiceClient>[0]> = {}
): Promise<{ client: RealtimeVoiceClient; socket: FakeSocket }> {
  let socket!: FakeSocket;
  const client = new RealtimeVoiceClient({
    url: "ws://localhost:3001",
    createSocket: () => {
      socket = new FakeSocket();
      return socket;
    },
    ...overrides,
  });
  const connectPromise = client.connect();
  socket.simulateOpen();
  socket.simulateJson({ seq: 1, type: "hello_ack", sessionId: "session-xyz" });
  await connectPromise;
  return { client, socket };
}

describe("RealtimeVoiceClient — handshake", () => {
  it("sends hello (with the requested sessionId) once the socket opens", async () => {
    let socket!: FakeSocket;
    const client = new RealtimeVoiceClient({
      url: "ws://localhost:3001",
      sessionId: "reconnect-me",
      createSocket: () => {
        socket = new FakeSocket();
        return socket;
      },
    });
    const connectPromise = client.connect();
    socket.simulateOpen();
    expect(sentJson(socket, 0)).toEqual({ type: "hello", sessionId: "reconnect-me" });

    socket.simulateJson({ seq: 1, type: "hello_ack", sessionId: "reconnect-me" });
    await connectPromise;
    expect(client.sessionId).toBe("reconnect-me");
    expect(client.connectionState).toBe("open");
  });

  it("rejects connect() if the socket closes before hello_ack arrives", async () => {
    let socket!: FakeSocket;
    const client = new RealtimeVoiceClient({
      url: "ws://localhost:3001",
      createSocket: () => {
        socket = new FakeSocket();
        return socket;
      },
    });
    const connectPromise = client.connect();
    socket.simulateOpen();
    socket.close(1006, "abnormal closure");

    await expect(connectPromise).rejects.toThrow(/closed before hello_ack/);
    expect(client.connectionState).toBe("closed");
  });

  it("reports the connection closing after a successful connect via onConnectionClosed", async () => {
    const closes: Array<{ code: number; reason: string }> = [];
    const { socket } = await connected({ onConnectionClosed: (e) => closes.push(e) });
    socket.close(1000, "server shutdown");
    expect(closes).toEqual([{ code: 1000, reason: "server shutdown" }]);
  });
});

describe("RealtimeVoiceClient — outgoing messages", () => {
  it("sends speech_started / speech_paused / submit_utterance / barge_in / end as the documented JSON shapes", async () => {
    const { client, socket } = await connected();
    client.notifySpeechStarted();
    client.notifySpeechPaused();
    client.submitUtterance();
    client.bargeIn();
    client.end();

    const messages = socket.sent.slice(1).map((raw) => JSON.parse(raw as string)); // [0] was hello
    expect(messages).toEqual([
      { type: "speech_started" },
      { type: "speech_paused" },
      { type: "submit_utterance" },
      { type: "barge_in" },
      { type: "end" },
    ]);
  });

  it("sends audio frames as raw binary, not JSON-wrapped", async () => {
    const { client, socket } = await connected();
    const pcm = new ArrayBuffer(4);
    client.sendAudioFrame(pcm);
    expect(socket.sent[socket.sent.length - 1]).toBe(pcm);
  });

  it("throws RealtimeVoiceClientNotConnectedError for any send before connect() resolves", () => {
    const client = new RealtimeVoiceClient({
      url: "ws://localhost:3001",
      createSocket: () => new FakeSocket(),
    });
    expect(() => client.notifySpeechStarted()).toThrow(RealtimeVoiceClientNotConnectedError);
    expect(() => client.sendAudioFrame(new ArrayBuffer(1))).toThrow(RealtimeVoiceClientNotConnectedError);
  });

  it("throws for any send after disconnect()", async () => {
    const { client } = await connected();
    client.disconnect();
    expect(client.connectionState).toBe("closed");
    expect(() => client.submitUtterance()).toThrow(RealtimeVoiceClientNotConnectedError);
  });
});

describe("RealtimeVoiceClient — incoming messages", () => {
  it("routes a relayed event to onEvent", async () => {
    const events: InterviewEvent[] = [];
    const { socket } = await connected({ onEvent: (e) => events.push(e) });
    const finalTranscript: InterviewEvent = { type: "FINAL_TRANSCRIPT", text: "hello", timestamp: 1 };
    socket.simulateJson({ seq: 2, type: "event", event: finalTranscript });
    expect(events).toEqual([finalTranscript]);
  });

  it("routes a binary message to onAudio untouched", async () => {
    const audioChunks: ArrayBuffer[] = [];
    const { socket } = await connected({ onAudio: (a) => audioChunks.push(a) });
    const buf = new TextEncoder().encode("audio-bytes").buffer;
    socket.simulateBinary(buf);
    expect(audioChunks).toEqual([buf]);
  });

  it("routes a protocol error message to onProtocolError", async () => {
    const errors: string[] = [];
    const { socket } = await connected({ onProtocolError: (m) => errors.push(m) });
    socket.simulateJson({ seq: 2, type: "error", message: "boom" });
    expect(errors).toEqual(["boom"]);
  });

  it("detects a sequence gap without losing the running counter", async () => {
    const gaps: Array<[number, number]> = [];
    const { socket } = await connected({ onSequenceGap: (expected, actual) => gaps.push([expected, actual]) });
    // hello_ack was seq 1, so the next expected is 2.
    socket.simulateJson({ seq: 5, type: "event", event: { type: "SPEECH_STARTED", timestamp: 1 } });
    expect(gaps).toEqual([[2, 5]]);

    // No further gap reported for the immediately-following, correctly-numbered message.
    socket.simulateJson({ seq: 6, type: "event", event: { type: "SPEECH_ENDED", timestamp: 2 } });
    expect(gaps).toEqual([[2, 5]]);
  });
});
