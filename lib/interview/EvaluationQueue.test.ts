import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  EvaluationQueue,
  InMemoryEvaluationJobStore,
  FileEvaluationJobStore,
  type EvaluationJobInput,
  type EvaluationResult,
} from "./EvaluationQueue";

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

const tempDirs: string[] = [];
async function tempStore(): Promise<FileEvaluationJobStore> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eval-queue-test-"));
  tempDirs.push(dir);
  return new FileEvaluationJobStore(dir);
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe("InMemoryEvaluationJobStore", () => {
  it("round-trips save/get and returns independent copies", async () => {
    const store = new InMemoryEvaluationJobStore();
    const job = { ...input(), status: "pending" as const, attempts: 0, maxAttempts: 3, nextAttemptAt: 0, createdAt: 0, updatedAt: 0 };
    await store.save(job);
    const fetched = await store.get(job.id);
    expect(fetched).toEqual(job);
    fetched!.transcript = "mutated";
    expect((await store.get(job.id))!.transcript).not.toBe("mutated"); // stored copy is isolated
  });

  it("get() returns null for an unknown id", async () => {
    expect(await new InMemoryEvaluationJobStore().get("nope")).toBeNull();
  });

  it("listPending() only returns pending jobs", async () => {
    const store = new InMemoryEvaluationJobStore();
    const base = { ...input(), attempts: 0, maxAttempts: 3, nextAttemptAt: 0, createdAt: 0, updatedAt: 0 };
    await store.save({ ...base, id: "a", status: "pending" });
    await store.save({ ...base, id: "b", status: "completed" });
    const pending = await store.listPending();
    expect(pending.map((j) => j.id)).toEqual(["a"]);
  });
});

describe("FileEvaluationJobStore", () => {
  it("round-trips save/get via disk", async () => {
    const store = await tempStore();
    const job = { ...input(), status: "pending" as const, attempts: 0, maxAttempts: 3, nextAttemptAt: 0, createdAt: 0, updatedAt: 0 };
    await store.save(job);
    expect(await store.get(job.id)).toEqual(job);
  });

  it("get() returns null when the job file doesn't exist (including a missing data dir)", async () => {
    const store = await tempStore();
    expect(await store.get("nope")).toBeNull();
  });

  it("listPending() returns [] when the data dir doesn't exist yet", async () => {
    const store = new FileEvaluationJobStore(path.join(os.tmpdir(), "eval-queue-never-created-" + Date.now()));
    expect(await store.listPending()).toEqual([]);
  });

  it("listPending() filters by status across multiple files on disk", async () => {
    const store = await tempStore();
    const base = { ...input(), attempts: 0, maxAttempts: 3, nextAttemptAt: 0, createdAt: 0, updatedAt: 0 };
    await store.save({ ...base, id: "a", status: "pending" });
    await store.save({ ...base, id: "b", status: "dead_letter" });
    await store.save({ ...base, id: "c", status: "pending" });
    const pending = (await store.listPending()).map((j) => j.id).sort();
    expect(pending).toEqual(["a", "c"]);
  });

  it("sanitizes an id with unsafe characters into a safe filename", async () => {
    const store = await tempStore();
    const job = { ...input(), id: "session/1:turn 1?", status: "pending" as const, attempts: 0, maxAttempts: 3, nextAttemptAt: 0, createdAt: 0, updatedAt: 0 };
    await expect(store.save(job)).resolves.toBeUndefined();
    expect(await store.get(job.id)).toEqual(job);
  });
});

describe("EvaluationQueue.enqueue()", () => {
  it("creates a new pending job with zero attempts and an immediately-due nextAttemptAt", async () => {
    const queue = new EvaluationQueue({ store: new InMemoryEvaluationJobStore() });
    const before = Date.now();
    const job = await queue.enqueue(input());
    expect(job.status).toBe("pending");
    expect(job.attempts).toBe(0);
    expect(job.maxAttempts).toBe(3);
    expect(job.nextAttemptAt).toBeGreaterThanOrEqual(before);
    expect(job.nextAttemptAt).toBeLessThanOrEqual(Date.now());
  });

  it("is idempotent: re-enqueuing the same id returns the original job, ignoring new input", async () => {
    const queue = new EvaluationQueue({ store: new InMemoryEvaluationJobStore() });
    const first = await queue.enqueue(input({ transcript: "original answer" }));
    const second = await queue.enqueue(input({ transcript: "a completely different answer" }));

    expect(second).toEqual(first);
    expect((await queue.get(first.id))!.transcript).toBe("original answer");
  });

  it("treats different ids as independent jobs", async () => {
    const queue = new EvaluationQueue({ store: new InMemoryEvaluationJobStore() });
    await queue.enqueue(input({ id: "a" }));
    await queue.enqueue(input({ id: "b" }));
    expect(await queue.get("a")).not.toBeNull();
    expect(await queue.get("b")).not.toBeNull();
  });
});

describe("EvaluationQueue.claim()", () => {
  it("returns null when nothing is pending", async () => {
    const queue = new EvaluationQueue({ store: new InMemoryEvaluationJobStore() });
    expect(await queue.claim()).toBeNull();
  });

  it("claims a due job, marking it processing and incrementing attempts", async () => {
    const queue = new EvaluationQueue({ store: new InMemoryEvaluationJobStore() });
    await queue.enqueue(input());
    const claimed = await queue.claim();
    expect(claimed?.status).toBe("processing");
    expect(claimed?.attempts).toBe(1);
    expect((await queue.get(input().id))?.status).toBe("processing");
  });

  it("does not claim a job whose nextAttemptAt is in the future", async () => {
    const store = new InMemoryEvaluationJobStore();
    const queue = new EvaluationQueue({ store });
    const job = await queue.enqueue(input());
    await store.save({ ...job, nextAttemptAt: Date.now() + 60_000 });
    expect(await queue.claim()).toBeNull();
  });

  it("claims the oldest-due job first when several qualify", async () => {
    const store = new InMemoryEvaluationJobStore();
    const queue = new EvaluationQueue({ store });
    const a = await queue.enqueue(input({ id: "a" }));
    const b = await queue.enqueue(input({ id: "b" }));
    await store.save({ ...a, nextAttemptAt: 200, createdAt: 200 });
    await store.save({ ...b, nextAttemptAt: 100, createdAt: 100 });

    const claimed = await queue.claim(1000);
    expect(claimed?.id).toBe("b");
  });

  it("never lets two concurrent claim() calls pick up the same job", async () => {
    const store = new InMemoryEvaluationJobStore();
    const queue = new EvaluationQueue({ store });
    for (let i = 0; i < 5; i++) await queue.enqueue(input({ id: `job-${i}` }));

    const claims = await Promise.all(Array.from({ length: 5 }, () => queue.claim()));
    const ids = claims.map((c) => c?.id);
    expect(new Set(ids).size).toBe(5); // all five distinct — no duplicate claims
    expect(ids.every(Boolean)).toBe(true);
  });
});

describe("EvaluationQueue.complete()", () => {
  it("marks a job completed and stores its result", async () => {
    const queue = new EvaluationQueue({ store: new InMemoryEvaluationJobStore() });
    const job = await queue.enqueue(input());
    await queue.claim();
    await queue.complete(job.id, RESULT);

    const final = await queue.get(job.id);
    expect(final?.status).toBe("completed");
    expect(final?.result).toEqual(RESULT);
  });

  it("is a no-op for an unknown id", async () => {
    const queue = new EvaluationQueue({ store: new InMemoryEvaluationJobStore() });
    await expect(queue.complete("nope", RESULT)).resolves.toBeUndefined();
  });
});

describe("EvaluationQueue.fail()", () => {
  it("schedules a retry with exponential backoff while attempts remain", async () => {
    const queue = new EvaluationQueue({ store: new InMemoryEvaluationJobStore(), maxAttempts: 3, retryBaseDelayMs: 100 });
    const job = await queue.enqueue(input());
    await queue.claim(); // attempts -> 1
    const beforeFail = Date.now();
    await queue.fail(job.id, "network blip");

    const afterFirstFail = await queue.get(job.id);
    expect(afterFirstFail?.status).toBe("pending");
    expect(afterFirstFail?.lastError).toBe("network blip");
    expect(afterFirstFail?.nextAttemptAt).toBeGreaterThanOrEqual(beforeFail + 100);
  });

  it("doubles the backoff delay on each successive failure", async () => {
    const queue = new EvaluationQueue({ store: new InMemoryEvaluationJobStore(), maxAttempts: 5, retryBaseDelayMs: 100, retryMaxDelayMs: 100_000 });
    const job = await queue.enqueue(input());

    await queue.claim(); // attempt 1
    const t0 = Date.now();
    await queue.fail(job.id, "err1");
    const delay1 = (await queue.get(job.id))!.nextAttemptAt - t0;

    await queue.claim(Date.now() + 1_000_000); // force-claim regardless of nextAttemptAt by using a far-future "now"
    const t1 = Date.now();
    await queue.fail(job.id, "err2");
    const delay2 = (await queue.get(job.id))!.nextAttemptAt - t1;

    expect(delay2).toBeGreaterThan(delay1);
  });

  it("marks the job dead_letter once maxAttempts is exhausted, and it is never claimed again", async () => {
    const queue = new EvaluationQueue({ store: new InMemoryEvaluationJobStore(), maxAttempts: 2, retryBaseDelayMs: 1 });
    const job = await queue.enqueue(input());

    await queue.claim();
    await queue.fail(job.id, "err1"); // attempts=1 < maxAttempts=2 -> pending
    await queue.claim(Date.now() + 1_000_000);
    await queue.fail(job.id, "err2"); // attempts=2 >= maxAttempts=2 -> dead_letter

    const final = await queue.get(job.id);
    expect(final?.status).toBe("dead_letter");
    expect(final?.lastError).toBe("err2");
    expect(await queue.claim(Date.now() + 1_000_000_000)).toBeNull();
  });

  it("is a no-op for an unknown id", async () => {
    const queue = new EvaluationQueue({ store: new InMemoryEvaluationJobStore() });
    await expect(queue.fail("nope", "boom")).resolves.toBeUndefined();
  });
});
