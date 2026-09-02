import { describe, it, expect, vi } from "vitest";
import { InterviewPipeline } from "./InterviewPipeline";
import { MemoryEngine } from "../interview/MemoryEngine";
import { EvaluationQueue, InMemoryEvaluationJobStore } from "../interview/EvaluationQueue";
import type { EvaluationResult } from "../interview/EvaluationQueue";
import type { EvaluateFn } from "../interview/EvaluationWorker";
import type { EvidenceEvaluation } from "../interview/EvidenceEvaluator";
import type { LLMGenerateOptions, LLMMessage, LLMProvider, LLMResult, LLMTokenCallback } from "../providers/llm/types";
import type { STTProvider } from "../providers/stt/STTProvider";
import type { TTSProvider } from "../providers/tts/TTSProvider";

/** Matches lib/interview/ConversationEngine.test.ts's FakeLLMProvider — no mocking framework,
 *  plain dependency injection, per this repo's convention. */
class FakeLLMProvider implements LLMProvider {
  calls: Array<{ messages: LLMMessage[]; opts?: LLMGenerateOptions }> = [];
  private queue: Array<string | Error>;

  constructor(responses: Array<string | Error>) {
    this.queue = [...responses];
  }

  async generate(messages: LLMMessage[], opts?: LLMGenerateOptions): Promise<LLMResult> {
    this.calls.push({ messages, opts });
    const next = this.queue.shift();
    if (next === undefined) throw new Error("FakeLLMProvider: no more queued responses");
    if (next instanceof Error) throw next;
    return { text: next };
  }

  async generateStream(_messages: LLMMessage[], _onToken: LLMTokenCallback): Promise<LLMResult> {
    throw new Error("FakeLLMProvider.generateStream() should never be called by this pipeline");
  }
}

/** Matches lib/voice/VoiceSession.test.ts's FakeSTTProvider shape. */
class FakeSTTProvider implements STTProvider {
  connectCalls = 0;
  disconnectCalls = 0;
  sentAudio: ArrayBuffer[] = [];
  private readonly partialCbs: Array<(text: string) => void> = [];
  private readonly finalCbs: Array<(text: string) => void> = [];

  async connect(): Promise<void> {
    this.connectCalls++;
  }
  sendAudio(audio: ArrayBuffer): void {
    this.sentAudio.push(audio);
  }
  async disconnect(): Promise<void> {
    this.disconnectCalls++;
  }
  onPartial(cb: (text: string) => void): void {
    this.partialCbs.push(cb);
  }
  onFinal(cb: (text: string) => void): void {
    this.finalCbs.push(cb);
  }
  emitFinal(text: string): void {
    for (const cb of this.finalCbs) cb(text);
  }
}

/** No accumulating-listener leak in the fake itself is required to matter for these tests (only
 *  the pipeline's own single-registration discipline does) — this just records calls and lets
 *  tests drive audio/completion manually. */
class FakeTTSProvider implements TTSProvider {
  connectCalls = 0;
  disconnectCalls = 0;
  cancelCalls = 0;
  sentTexts: string[] = [];
  flushCalls = 0;
  private audioCbs: Array<(chunk: ArrayBuffer, sequence: number) => void> = [];
  private completeCbs: Array<() => void> = [];
  private seq = 0;

  async connect(): Promise<void> {
    this.connectCalls++;
  }
  sendText(text: string): void {
    this.sentTexts.push(text);
  }
  flush(): void {
    this.flushCalls++;
  }
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

function toText(buf: ArrayBuffer): string {
  return new TextDecoder().decode(buf);
}

const VALID_TURN_JSON = JSON.stringify({
  action: "FOLLOW_UP",
  speech: "Interesting — how did you handle cache invalidation?",
  topic: "caching",
  evaluation_required: true,
});

const SUBSTANTIVE_ANSWER =
  "I used Redis for caching and designed a schema with proper indexing to keep lookups fast under heavy load.";

function harness(
  overrides: {
    conversationLLM?: LLMProvider;
    evaluationLLM?: LLMProvider;
    evaluate?: EvaluateFn;
    memory?: MemoryEngine;
    autoStartEvaluationWorker?: boolean;
  } = {}
) {
  const sttProvider = new FakeSTTProvider();
  const ttsProvider = new FakeTTSProvider();
  const conversationLLM = overrides.conversationLLM ?? new FakeLLMProvider([VALID_TURN_JSON]);
  const memory = overrides.memory ?? new MemoryEngine();
  const store = new InMemoryEvaluationJobStore();
  const evaluationQueue = new EvaluationQueue({ store });

  const pipeline = new InterviewPipeline({
    sessionId: "session-1",
    scenarioTitle: "Backend Engineer",
    sttProvider,
    ttsProvider,
    conversationLLM,
    evaluationLLM: overrides.evaluationLLM,
    evaluate: overrides.evaluate,
    memory,
    evaluationQueue,
    autoStartEvaluationWorker: overrides.autoStartEvaluationWorker ?? false,
  });

  return { pipeline, sttProvider, ttsProvider, conversationLLM, memory, evaluationQueue, store };
}

describe("InterviewPipeline — deterministic routing (no LLM call)", () => {
  it("answers a repeat request with a canned reply and never calls the LLM", async () => {
    const { pipeline, conversationLLM } = harness({ conversationLLM: new FakeLLMProvider([]) });
    void conversationLLM;
    const reply = await pipeline.generateReply("can you repeat that", new AbortController().signal);
    expect(reply).toContain("Sure");
  });

  it("does not enqueue an evaluation job for a deterministic (non-substantive) turn", async () => {
    const { pipeline, store } = harness();
    await pipeline.generateReply("okay", new AbortController().signal);
    expect(await store.listPending()).toEqual([]);
  });
});

describe("InterviewPipeline — the fast response lane (needs the LLM)", () => {
  it("routes a substantive answer through ContextBuilder -> ConversationEngine -> ResponsePlanner", async () => {
    const conversationLLM = new FakeLLMProvider([VALID_TURN_JSON]);
    const { pipeline } = harness({ conversationLLM });
    const reply = await pipeline.generateReply(SUBSTANTIVE_ANSWER, new AbortController().signal);

    expect(reply).toBe("Interesting — how did you handle cache invalidation?");
    expect(conversationLLM.calls).toHaveLength(1);
    // The candidate's own answer must be part of what's sent to the LLM as turn history.
    const sentText = conversationLLM.calls[0].messages.map((m: LLMMessage) => m.content).join(" ");
    expect(sentText).toContain("Redis");
  });

  it("fires evaluation enqueue in parallel (without blocking the returned reply)", async () => {
    const { pipeline, store } = harness();
    const reply = await pipeline.generateReply(SUBSTANTIVE_ANSWER, new AbortController().signal);
    expect(reply).toBeTruthy();

    // enqueue() is fire-and-forget from generateReply's perspective, but it's a synchronous-ish
    // in-memory write — give the microtask queue one tick to land before asserting on it.
    await Promise.resolve();
    await Promise.resolve();
    const pending = await store.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0].transcript).toBe(SUBSTANTIVE_ANSWER);
    expect(pending[0].sessionId).toBe("session-1");
  });

  it("does not enqueue evaluation for a short (needsDeepEvaluation: false) LLM-worthy answer", async () => {
    const shortJson = JSON.stringify({
      action: "ACKNOWLEDGE",
      speech: "Got it, thanks.",
      topic: "general",
      evaluation_required: false,
    });
    const { pipeline, store } = harness({ conversationLLM: new FakeLLMProvider([shortJson]) });
    await pipeline.generateReply("yeah I think so", new AbortController().signal);
    await Promise.resolve();
    expect(await store.listPending()).toHaveLength(0);
  });
});

describe("InterviewPipeline — chunked TTS delivery", () => {
  it("pushes reply text through the TTS provider and resolves once onComplete fires", async () => {
    const { pipeline, ttsProvider } = harness();
    const chunks: ArrayBuffer[] = [];
    const controller = new AbortController();

    const done = pipeline.synthesizeSpeechStream("Hello there, candidate.", (audio) => chunks.push(audio), controller.signal);

    // Give the chunker's synchronous push/flush a tick to reach the TTS provider.
    await Promise.resolve();
    expect(ttsProvider.sentTexts.join("")).toContain("Hello there, candidate.");
    expect(ttsProvider.flushCalls).toBeGreaterThan(0);

    ttsProvider.emitAudio("audio-1");
    ttsProvider.emitComplete();
    await done;

    expect(chunks).toHaveLength(1);
    expect(toText(chunks[0])).toBe("audio-1");
  });

  it("does not misdeliver a later turn's audio into an earlier, already-settled turn's callback", async () => {
    const { pipeline, ttsProvider } = harness();
    const turn1Chunks: ArrayBuffer[] = [];
    const turn2Chunks: ArrayBuffer[] = [];

    const done1 = pipeline.synthesizeSpeechStream("First reply.", (a) => turn1Chunks.push(a), new AbortController().signal);
    await Promise.resolve();
    ttsProvider.emitAudio("t1-audio");
    ttsProvider.emitComplete();
    await done1;

    const done2 = pipeline.synthesizeSpeechStream("Second reply.", (a) => turn2Chunks.push(a), new AbortController().signal);
    await Promise.resolve();
    ttsProvider.emitAudio("t2-audio");
    ttsProvider.emitComplete();
    await done2;

    expect(turn1Chunks).toHaveLength(1);
    expect(toText(turn1Chunks[0])).toBe("t1-audio");
    expect(turn2Chunks).toHaveLength(1);
    expect(toText(turn2Chunks[0])).toBe("t2-audio");
  });

  it("cancels the TTS provider and resolves (without rejecting) when the signal aborts mid-utterance", async () => {
    const { pipeline, ttsProvider } = harness();
    const controller = new AbortController();
    const done = pipeline.synthesizeSpeechStream("Some long reply.", () => {}, controller.signal);
    await Promise.resolve();

    controller.abort();
    await expect(done).resolves.toBeUndefined();
    expect(ttsProvider.cancelCalls).toBe(1);
  });

  it("resolves immediately without touching the TTS provider for empty/whitespace text", async () => {
    const { pipeline, ttsProvider } = harness();
    await pipeline.synthesizeSpeechStream("   ", () => {}, new AbortController().signal);
    expect(ttsProvider.sentTexts).toHaveLength(0);
  });

  it("rejects if the TTS provider never reports completion within the configured timeout", async () => {
    const sttProvider = new FakeSTTProvider();
    const ttsProvider = new FakeTTSProvider();
    const pipeline = new InterviewPipeline({
      sessionId: "session-timeout",
      sttProvider,
      ttsProvider,
      conversationLLM: new FakeLLMProvider([]),
      autoStartEvaluationWorker: false,
      ttsTimeoutMs: 20,
    });

    await expect(pipeline.synthesizeSpeechStream("Hello.", () => {}, new AbortController().signal)).rejects.toThrow(
      /did not complete/
    );
  });
});

describe("InterviewPipeline — background evaluation feeds back into MemoryEngine", () => {
  it("applies a difficulty increase and records a strength when evidence scoring is strong", async () => {
    const strongEvidence: EvidenceEvaluation = {
      technical_correctness: 9,
      technical_depth: 8,
      communication: 8,
      evidence: [{ quote: "I used Redis for caching", assessment: "solid, specific experience" }],
      follow_up_opportunity: null as unknown as string,
    };
    const evaluate: EvaluateFn = async (job) => {
      const result: EvaluationResult = {
        summary: "Strong answer.",
        metrics: { wordCount: 10, fillerCount: 0, confidence: 90 } as EvaluationResult["metrics"],
        coachingEvents: [],
        evidence: strongEvidence,
      };
      void job;
      return result;
    };

    const memory = new MemoryEngine();
    const { pipeline, store } = harness({ evaluate, memory, autoStartEvaluationWorker: false });

    await pipeline.generateReply(SUBSTANTIVE_ANSWER, new AbortController().signal);
    await Promise.resolve();
    await Promise.resolve();
    expect(await store.listPending()).toHaveLength(1);

    const before = memory.getDifficulty();
    const processed = await pipeline.runEvaluationOnce();
    expect(processed).toBe(true);

    expect(memory.getDifficulty()).toBeGreaterThan(before);
    const facts = memory.getFactsForTopic("caching");
    expect(facts.strengths.length).toBeGreaterThan(0);
  });

  it("records a weakness and does not raise difficulty when evidence scoring is weak", async () => {
    const weakEvidence: EvidenceEvaluation = {
      technical_correctness: 2,
      technical_depth: 2,
      communication: 5,
      evidence: [{ quote: "I used Redis for caching", assessment: "shallow, no real depth" }],
      follow_up_opportunity: null as unknown as string,
    };
    const evaluate: EvaluateFn = async () => ({
      summary: "Weak answer.",
      metrics: { wordCount: 10, fillerCount: 0, confidence: 40 } as EvaluationResult["metrics"],
      coachingEvents: [],
      evidence: weakEvidence,
    });

    const memory = new MemoryEngine();
    const { pipeline } = harness({ evaluate, memory, autoStartEvaluationWorker: false });

    const before = memory.getDifficulty();
    await pipeline.generateReply(SUBSTANTIVE_ANSWER, new AbortController().signal);
    await Promise.resolve();
    await Promise.resolve();
    await pipeline.runEvaluationOnce();

    expect(memory.getDifficulty()).toBeLessThanOrEqual(before);
    const facts = memory.getFactsForTopic("caching");
    expect(facts.weaknesses.length).toBeGreaterThan(0);
  });

  it("does not touch MemoryEngine when the evaluation result carries no evidence", async () => {
    const evaluate: EvaluateFn = async () => ({
      summary: "No evidence scoring available.",
      metrics: { wordCount: 10, fillerCount: 0, confidence: 50 } as EvaluationResult["metrics"],
      coachingEvents: [],
    });
    const memory = new MemoryEngine();
    const { pipeline } = harness({ evaluate, memory, autoStartEvaluationWorker: false });

    const before = memory.getDifficulty();
    await pipeline.generateReply(SUBSTANTIVE_ANSWER, new AbortController().signal);
    await Promise.resolve();
    await Promise.resolve();
    await pipeline.runEvaluationOnce();

    expect(memory.getDifficulty()).toBe(before);
  });
});

describe("InterviewPipeline — end-to-end through the underlying VoiceSession", () => {
  it("a full utterance -> reply -> TTS chunk cycle runs through session.events without throwing", async () => {
    const { pipeline, sttProvider, ttsProvider } = harness();
    await pipeline.start();
    expect(sttProvider.connectCalls).toBe(1);
    expect(ttsProvider.connectCalls).toBe(1);

    const audioChunks: ArrayBuffer[] = [];
    pipeline.session.onAudio((audio) => audioChunks.push(audio));

    pipeline.session.notifySpeechStarted();
    sttProvider.emitFinal(SUBSTANTIVE_ANSWER);
    // Let generateReply's async chain (ContextBuilder -> ConversationEngine -> ResponsePlanner)
    // resolve and reach the TTS leg.
    await vi.waitFor(() => {
      expect(ttsProvider.sentTexts.length).toBeGreaterThan(0);
    });

    ttsProvider.emitAudio("agent-audio");
    ttsProvider.emitComplete();

    await vi.waitFor(() => {
      expect(audioChunks.length).toBeGreaterThan(0);
    });
    expect(toText(audioChunks[0])).toBe("agent-audio");

    await pipeline.end();
    expect(sttProvider.disconnectCalls).toBe(1);
    expect(ttsProvider.disconnectCalls).toBe(1);
  });
});
