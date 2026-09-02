import { describe, it, expect } from "vitest";
import { EvaluationQueue, InMemoryEvaluationJobStore, type EvaluationJobInput, type EvaluationResult, type EvaluationJob } from "./EvaluationQueue";
import { EvaluationWorker, defaultEvaluate, type EvaluationWorkerEvent } from "./EvaluationWorker";

function input(overrides: Partial<EvaluationJobInput> = {}): EvaluationJobInput {
  return {
    id: "session-1:turn-1",
    sessionId: "session-1",
    transcript: "I built a caching layer using Redis to reduce database load.",
    topic: "caching",
    ...overrides,
  };
}

const RESULT: EvaluationResult = {
  summary: "Solid, concrete answer.",
  metrics: {
    wordCount: 10,
    fillerCount: 0,
    fillerRate: 0,
    hedgeCount: 0,
    vocabularyRichness: 1,
    avgSentenceLength: 10,
    confidenceMarkers: 1,
    confidence: 80,
    technicalDepth: 1,
    speechRateWpm: null,
    topFillers: [],
  },
  coachingEvents: [],
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("EvaluationWorker.processOne()", () => {
  it("returns false and never calls evaluate() when the queue is empty", async () => {
    const queue = new EvaluationQueue({ store: new InMemoryEvaluationJobStore() });
    let calls = 0;
    const worker = new EvaluationWorker({
      queue,
      evaluate: async () => {
        calls++;
        return RESULT;
      },
    });

    expect(await worker.processOne()).toBe(false);
    expect(calls).toBe(0);
  });

  it("claims a job, evaluates it, and marks it completed with the result", async () => {
    const queue = new EvaluationQueue({ store: new InMemoryEvaluationJobStore() });
    const job = await queue.enqueue(input());
    const received: EvaluationJob[] = [];
    const worker = new EvaluationWorker({
      queue,
      evaluate: async (j) => {
        received.push(j);
        return RESULT;
      },
    });

    expect(await worker.processOne()).toBe(true);
    expect(received).toHaveLength(1);
    expect(received[0].id).toBe(job.id);
    const final = await queue.get(job.id);
    expect(final?.status).toBe("completed");
    expect(final?.result).toEqual(RESULT);
  });

  it("reports evaluate() failures to the queue instead of throwing", async () => {
    const queue = new EvaluationQueue({ store: new InMemoryEvaluationJobStore(), maxAttempts: 3 });
    const job = await queue.enqueue(input());
    const worker = new EvaluationWorker({
      queue,
      evaluate: async () => {
        throw new Error("llm down");
      },
    });

    await expect(worker.processOne()).resolves.toBe(true);
    const final = await queue.get(job.id);
    expect(final?.status).toBe("pending"); // attempts=1 < maxAttempts=3 -> scheduled for retry
    expect(final?.lastError).toBe("llm down");
  });

  it("emits a completed/failed event per job without ever throwing from a broken onEvent", async () => {
    const queue = new EvaluationQueue({ store: new InMemoryEvaluationJobStore() });
    await queue.enqueue(input({ id: "ok" }));
    await queue.enqueue(input({ id: "bad" }));

    const events: EvaluationWorkerEvent[] = [];
    const worker = new EvaluationWorker({
      queue,
      evaluate: async (job) => {
        if (job.id === "bad") throw new Error("boom");
        return RESULT;
      },
      onEvent: (e) => {
        events.push(e);
        throw new Error("onEvent itself is broken"); // must not propagate
      },
    });

    await expect(worker.processOne()).resolves.toBe(true);
    await expect(worker.processOne()).resolves.toBe(true);

    const types = events.map((e) => e.type).sort();
    expect(types).toEqual(["completed", "failed"]);
    const failed = events.find((e) => e.type === "failed") as Extract<EvaluationWorkerEvent, { type: "failed" }>;
    expect(failed.error.message).toBe("boom");
  });
});

describe("EvaluationWorker.start()/stop()", () => {
  it("drains a backlog of jobs on an interval and stops taking new ones after stop()", async () => {
    const queue = new EvaluationQueue({ store: new InMemoryEvaluationJobStore() });
    await queue.enqueue(input({ id: "a" }));
    await queue.enqueue(input({ id: "b" }));

    const processed: string[] = [];
    const worker = new EvaluationWorker({
      queue,
      evaluate: async (job) => {
        processed.push(job.id);
        return RESULT;
      },
    });

    worker.start({ idleDelayMs: 5, busyDelayMs: 0 });
    await sleep(30);
    worker.stop();
    expect(processed.sort()).toEqual(["a", "b"]);

    await queue.enqueue(input({ id: "c" }));
    await sleep(30);
    expect(processed).not.toContain("c"); // stop() actually stopped the loop
  });

  it("start() is idempotent — calling it twice does not spawn a second loop", async () => {
    const queue = new EvaluationQueue({ store: new InMemoryEvaluationJobStore() });
    await queue.enqueue(input());
    let calls = 0;
    const worker = new EvaluationWorker({ queue, evaluate: async () => { calls++; return RESULT; } });

    worker.start({ idleDelayMs: 5 });
    worker.start({ idleDelayMs: 5 }); // no-op
    await sleep(20);
    worker.stop();
    expect(calls).toBe(1); // only ever one job to process, processed exactly once
  });

  it("stop() before start() (and a repeat stop()) are safe no-ops", () => {
    const queue = new EvaluationQueue({ store: new InMemoryEvaluationJobStore() });
    const worker = new EvaluationWorker({ queue, evaluate: async () => RESULT });
    expect(() => {
      worker.stop();
      worker.stop();
    }).not.toThrow();
  });
});

describe("defaultEvaluate", () => {
  it("computes real metrics and coaching events, and falls back to a heuristic summary when no LLM provider is configured", async () => {
    // This sandbox has neither SARVAM_API_KEY nor GEMINI_API_KEY set, so defaultEvaluate's summary
    // step deterministically takes its no-provider-configured heuristic path — exercised for real,
    // not mocked.
    const job = await new EvaluationQueue({ store: new InMemoryEvaluationJobStore() }).enqueue(
      input({ transcript: "I designed a rate limiter using a sliding window counter in Redis." })
    );

    const result = await defaultEvaluate(job);

    expect(result.metrics.wordCount).toBeGreaterThan(0);
    expect(typeof result.summary).toBe("string");
    expect(result.summary.length).toBeGreaterThan(0);
    expect(result.summary).toContain(`${result.metrics.wordCount} words`);
    expect(Array.isArray(result.coachingEvents)).toBe(true);
  });

  it("is usable as an EvaluationWorker's evaluate() function end to end", async () => {
    const queue = new EvaluationQueue({ store: new InMemoryEvaluationJobStore() });
    const job = await queue.enqueue(input());
    const worker = new EvaluationWorker({ queue }); // no evaluate override -> defaultEvaluate

    expect(await worker.processOne()).toBe(true);
    const final = await queue.get(job.id);
    expect(final?.status).toBe("completed");
    expect(final?.result?.summary.length).toBeGreaterThan(0);
  });
});
