import { describe, it, expect, afterEach, vi } from "vitest";
import { WebSocket } from "ws";
import type { AddressInfo } from "node:net";
import { createVoiceGateway, type VoiceGateway } from "./voice-gateway";
import { InterviewPipeline } from "../lib/voice/InterviewPipeline";
import { TurnManager } from "../lib/voice/TurnManager";
import { EvaluationQueue, InMemoryEvaluationJobStore } from "../lib/interview/EvaluationQueue";
import type { LLMGenerateOptions, LLMMessage, LLMProvider, LLMResult, LLMTokenCallback } from "../lib/providers/llm/types";
import type { STTProvider } from "../lib/providers/stt/STTProvider";
import type { TTSProvider } from "../lib/providers/tts/TTSProvider";

/** Matches lib/voice/InterviewPipeline.test.ts's fakes — no mocking framework, plain DI, per this
 *  repo's convention. Duplicated locally (rather than imported) since those classes aren't
 *  exported from that test file. */
class FakeLLMProvider implements LLMProvider {
  private queue: Array<string | Error>;
  constructor(responses: Array<string | Error>) {
    this.queue = [...responses];
  }
  async generate(_messages: LLMMessage[], _opts?: LLMGenerateOptions): Promise<LLMResult> {
    const next = this.queue.shift();
    if (next === undefined) throw new Error("FakeLLMProvider: no more queued responses");
    if (next instanceof Error) throw next;
    return { text: next };
  }
  async generateStream(_messages: LLMMessage[], _onToken: LLMTokenCallback): Promise<LLMResult> {
    throw new Error("should never be called");
  }
}

class FakeSTTProvider implements STTProvider {
  connectCalls = 0;
  disconnectCalls = 0;
  private readonly finalCbs: Array<(text: string) => void> = [];
  async connect(): Promise<void> {
    this.connectCalls++;
  }
  sendAudio(_audio: ArrayBuffer): void {}
  async disconnect(): Promise<void> {
    this.disconnectCalls++;
  }
  onPartial(_cb: (text: string) => void): void {}
  onFinal(cb: (text: string) => void): void {
    this.finalCbs.push(cb);
  }
  emitFinal(text: string): void {
    for (const cb of this.finalCbs) cb(text);
  }
}

class FakeTTSProvider implements TTSProvider {
  connectCalls = 0;
  disconnectCalls = 0;
  cancelCalls = 0;
  private audioCbs: Array<(chunk: ArrayBuffer, sequence: number) => void> = [];
  private completeCbs: Array<() => void> = [];
  private seq = 0;
  async connect(): Promise<void> {
    this.connectCalls++;
  }
  sendText(_text: string): void {}
  flush(): void {}
  cancel(): void {
    this.cancelCalls++;
  }
  async disconnect(): Promise<void> {
    this.disconnectCalls++;
  }
  onAudioChunk(cb: (chunk: ArrayBuffer, sequence: number) => void): void {
    this.audioCbs.push(cb);
  }
  onComplete(cb: () => void): void {
    this.completeCbs.push(cb);
  }
  emitAudio(text: string): void {
    const buf = new TextEncoder().encode(text).buffer;
    for (const cb of this.audioCbs) cb(buf, this.seq++);
  }
  emitComplete(): void {
    for (const cb of this.completeCbs) cb();
  }
}

const VALID_TURN_JSON = JSON.stringify({
  action: "FOLLOW_UP",
  speech: "How did you handle cache invalidation?",
  topic: "caching",
  evaluation_required: true,
});

interface FakesForSession {
  stt: FakeSTTProvider;
  tts: FakeTTSProvider;
  turnManager: TurnManager;
}

/** Builds a `pipelineFactory` that constructs a real `InterviewPipeline` per session, wired to
 *  test-controllable fake providers instead of any real Sarvam/Gemini network call — exactly the
 *  same harness pattern as lib/voice/InterviewPipeline.test.ts, just reused across the WS wire.
 *  Exposes each session's `TurnManager` too, so a test can wait for the gateway to have actually
 *  processed a "speech_started" message (a real round trip over the loopback socket) before
 *  simulating STT finalizing an utterance — otherwise the two race. */
function fakePipelineFactory() {
  const bySessionId = new Map<string, FakesForSession>();
  let factoryCalls = 0;
  const factory = (sessionId: string): InterviewPipeline => {
    factoryCalls++;
    const stt = new FakeSTTProvider();
    const tts = new FakeTTSProvider();
    const turnManager = new TurnManager();
    bySessionId.set(sessionId, { stt, tts, turnManager });
    return new InterviewPipeline({
      sessionId,
      sttProvider: stt,
      ttsProvider: tts,
      turnManager,
      conversationLLM: new FakeLLMProvider([VALID_TURN_JSON, VALID_TURN_JSON, VALID_TURN_JSON]),
      evaluationQueue: new EvaluationQueue({ store: new InMemoryEvaluationJobStore() }),
      autoStartEvaluationWorker: false,
    });
  };
  return { factory, bySessionId, factoryCalls: () => factoryCalls };
}

function gatewayPort(gateway: VoiceGateway): number {
  return (gateway.wss.address() as AddressInfo).port;
}

/** Connects a `ws` client and splits incoming frames into parsed JSON messages vs raw binary
 *  buffers, in arrival order within each bucket. */
function connectClient(port: number): Promise<{
  socket: WebSocket;
  jsonMessages: Array<Record<string, unknown>>;
  binaryMessages: Buffer[];
}> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    const jsonMessages: Array<Record<string, unknown>> = [];
    const binaryMessages: Buffer[] = [];
    socket.on("message", (data: Buffer, isBinary: boolean) => {
      if (isBinary) binaryMessages.push(data);
      else jsonMessages.push(JSON.parse(data.toString()));
    });
    socket.once("open", () => resolve({ socket, jsonMessages, binaryMessages }));
    socket.once("error", reject);
  });
}

let activeGateway: VoiceGateway | null = null;

afterEach(async () => {
  if (activeGateway) {
    await activeGateway.close();
    activeGateway = null;
  }
});

describe("voice-gateway — session lifecycle", () => {
  it("issues a fresh sessionId and starts the pipeline on hello", async () => {
    const { factory, bySessionId } = fakePipelineFactory();
    activeGateway = createVoiceGateway({ port: 0, pipelineFactory: factory });
    const { socket, jsonMessages } = await connectClient(gatewayPort(activeGateway));

    socket.send(JSON.stringify({ type: "hello" }));
    await vi.waitFor(() => expect(jsonMessages.some((m) => m.type === "hello_ack")).toBe(true));

    const ack = jsonMessages.find((m) => m.type === "hello_ack")!;
    expect(typeof ack.sessionId).toBe("string");
    const fakes = bySessionId.get(ack.sessionId as string)!;
    await vi.waitFor(() => expect(fakes.stt.connectCalls).toBe(1));
    expect(fakes.tts.connectCalls).toBe(1);

    socket.close();
  });

  it("respects a caller-supplied sessionId instead of generating one", async () => {
    const { factory } = fakePipelineFactory();
    activeGateway = createVoiceGateway({ port: 0, pipelineFactory: factory });
    const { socket, jsonMessages } = await connectClient(gatewayPort(activeGateway));

    socket.send(JSON.stringify({ type: "hello", sessionId: "my-session-1" }));
    await vi.waitFor(() => expect(jsonMessages.some((m) => m.type === "hello_ack")).toBe(true));
    expect(jsonMessages.find((m) => m.type === "hello_ack")!.sessionId).toBe("my-session-1");

    socket.close();
  });
});

describe("voice-gateway — a full turn over the wire", () => {
  it("relays events and streamed TTS audio back to the client for one turn", async () => {
    const { factory, bySessionId } = fakePipelineFactory();
    activeGateway = createVoiceGateway({ port: 0, pipelineFactory: factory });
    const { socket, jsonMessages, binaryMessages } = await connectClient(gatewayPort(activeGateway));

    socket.send(JSON.stringify({ type: "hello", sessionId: "turn-session" }));
    await vi.waitFor(() => expect(jsonMessages.some((m) => m.type === "hello_ack")).toBe(true));
    const fakes = bySessionId.get("turn-session")!;
    await vi.waitFor(() => expect(fakes.stt.connectCalls).toBe(1));

    socket.send(JSON.stringify({ type: "speech_started" }));
    await vi.waitFor(() => expect(fakes.turnManager.state).toBe("USER_SPEAKING"));
    fakes.stt.emitFinal("I used Redis for caching and designed indexes for fast lookups.");

    // The FINAL_TRANSCRIPT / AGENT_GENERATION_COMPLETED events should arrive as relayed
    // `InterviewEvent`s, and the agent's reply should reach the TTS provider.
    await vi.waitFor(() => {
      expect(jsonMessages.some((m) => (m as { event?: { type?: string } }).event?.type === "FINAL_TRANSCRIPT")).toBe(
        true
      );
    });

    fakes.tts.emitAudio("synthesized-audio-bytes");
    fakes.tts.emitComplete();

    await vi.waitFor(() => expect(binaryMessages.length).toBeGreaterThan(0));
    expect(binaryMessages[0].toString()).toBe("synthesized-audio-bytes");

    await vi.waitFor(() => {
      expect(
        jsonMessages.some((m) => (m as { event?: { type?: string } }).event?.type === "TTS_PLAYBACK_COMPLETED")
      ).toBe(true);
    });

    // Every JSON message (hello_ack + every relayed event) carries a strictly increasing seq.
    const seqs = jsonMessages.map((m) => m.seq as number);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);

    socket.close();
  });

  it("drops binary audio sent before hello instead of throwing", async () => {
    const { factory } = fakePipelineFactory();
    activeGateway = createVoiceGateway({ port: 0, pipelineFactory: factory });
    const { socket } = await connectClient(gatewayPort(activeGateway));

    expect(() => socket.send(Buffer.from([1, 2, 3]))).not.toThrow();
    // Give the server a tick to (not) crash on it.
    await new Promise((r) => setTimeout(r, 20));
    expect(activeGateway.sessionCount()).toBe(0);

    socket.close();
  });
});

describe("voice-gateway — reconnection", () => {
  it("reattaches the same pipeline instance when the same sessionId reconnects within the grace period", async () => {
    const { factory, factoryCalls } = fakePipelineFactory();
    activeGateway = createVoiceGateway({ port: 0, pipelineFactory: factory, reconnectGraceMs: 5000 });
    const port = gatewayPort(activeGateway);

    const first = await connectClient(port);
    first.socket.send(JSON.stringify({ type: "hello", sessionId: "reconnect-session" }));
    await vi.waitFor(() => expect(first.jsonMessages.some((m) => m.type === "hello_ack")).toBe(true));
    expect(factoryCalls()).toBe(1);

    first.socket.close();
    await new Promise((r) => setTimeout(r, 20));

    const second = await connectClient(port);
    second.socket.send(JSON.stringify({ type: "hello", sessionId: "reconnect-session" }));
    await vi.waitFor(() => expect(second.jsonMessages.some((m) => m.type === "hello_ack")).toBe(true));

    // Reconnecting must not construct a brand-new pipeline (and therefore not a brand-new
    // MemoryEngine/history) for the same sessionId.
    expect(factoryCalls()).toBe(1);
    expect(activeGateway.sessionCount()).toBe(1);

    second.socket.close();
  });

  it("tears down the pipeline (disconnecting STT/TTS) once the reconnect grace period elapses", async () => {
    const { factory, bySessionId } = fakePipelineFactory();
    activeGateway = createVoiceGateway({ port: 0, pipelineFactory: factory, reconnectGraceMs: 30 });
    const port = gatewayPort(activeGateway);

    const client = await connectClient(port);
    client.socket.send(JSON.stringify({ type: "hello", sessionId: "expiring-session" }));
    await vi.waitFor(() => expect(client.jsonMessages.some((m) => m.type === "hello_ack")).toBe(true));
    const fakes = bySessionId.get("expiring-session")!;
    await vi.waitFor(() => expect(fakes.stt.connectCalls).toBe(1));

    client.socket.close();

    await vi.waitFor(() => expect(activeGateway!.sessionCount()).toBe(0), { timeout: 2000 });
    expect(fakes.stt.disconnectCalls).toBe(1);
    expect(fakes.tts.disconnectCalls).toBe(1);
  });
});

describe("voice-gateway — cancellation", () => {
  it("handles barge_in without throwing even with no turn in flight", async () => {
    const { factory } = fakePipelineFactory();
    activeGateway = createVoiceGateway({ port: 0, pipelineFactory: factory });
    const { socket, jsonMessages } = await connectClient(gatewayPort(activeGateway));

    socket.send(JSON.stringify({ type: "hello", sessionId: "barge-session" }));
    await vi.waitFor(() => expect(jsonMessages.some((m) => m.type === "hello_ack")).toBe(true));

    expect(() => socket.send(JSON.stringify({ type: "barge_in" }))).not.toThrow();
    await new Promise((r) => setTimeout(r, 20));

    socket.close();
  });
});
