/**
 * Persistent job queue for asynchronous interview-answer evaluation:
 *
 *   Final answer -> Queue -> Evaluation worker
 *
 * This file is "the Queue" box — job definitions, persistence, and the enqueue/claim/complete/
 * fail lifecycle. `./EvaluationWorker.ts` is "the Evaluation worker" box that actually calls into
 * `lib/coaching.ts`/`lib/communication-metrics.ts`/`lib/prompts.ts` to score an answer.
 *
 * ## Why a queue at all
 *
 * `ConversationEngine`/`ResponsePlanner` (./ConversationEngine.ts, ./ResponsePlanner.ts) already
 * decide *whether* a candidate's answer is worth evaluating (`InterviewTurnResponse
 * .evaluation_required` -> `ResponsePlan.requiresEvaluation`) — both docstrings explicitly say
 * running that evaluation is the caller's job, not theirs. This module is that missing piece, but
 * as a queue rather than a direct call, because evaluation (an LLM summary call, in the default
 * worker) must never sit on the realtime response path: the interviewer has already spoken the
 * next question by the time an answer's evaluation finishes, or even starts. A caller enqueues a
 * finished answer (a fast, synchronous-feeling persistence write) and moves on immediately;
 * `EvaluationWorker` processes the backlog independently, on its own schedule.
 *
 * A caller (e.g. a future extension of `VoiceSession`) wires this in around the moment
 * `ResponsePlan.requiresEvaluation` is `true`:
 *
 *   if (plan.requiresEvaluation) {
 *     await queue.enqueue({ id: `${sessionId}:${turnIndex}`, sessionId, transcript, topic });
 *   }
 *
 * Nothing in this module is wired into `VoiceSession` yet — it's an independent, fully-tested
 * subsystem a caller opts into.
 *
 * ## Persistence
 *
 * `EvaluationJobStore` is the storage abstraction (mirroring the `STTProvider`/`TTSProvider`/
 * `LLMProvider` pattern elsewhere in `lib/providers/`). `FileEvaluationJobStore` is the default —
 * one JSON file per job under a data directory, written via a temp-file-then-rename so a save is
 * atomic (never a half-written file on disk), the exact durability pattern `lib/skill-graph.ts`
 * already uses for its own persistence. Unlike that file's store, a failed write here *throws*
 * rather than being silently logged and swallowed: skill-graph data has a client-side backup copy
 * (the browser holds its own copy and re-sends it), but a job has no such backup — losing a write
 * silently would mean silently losing an evaluation forever. `InMemoryEvaluationJobStore` is a
 * second, explicit implementation for tests (and for a deployment that doesn't need jobs to
 * survive a restart) — no disk I/O at all.
 *
 * ## Idempotency
 *
 * `enqueue()` takes a caller-supplied `id`. If a job with that `id` already exists, `enqueue()`
 * returns the existing job unchanged instead of creating a duplicate — so a caller that might
 * submit the same finished answer twice (a retried request, a duplicate event) never gets it
 * evaluated twice or double-counted. Callers should derive `id` from something stable per answer,
 * e.g. `` `${sessionId}:${turnIndex}` `` — never `Date.now()` or a fresh random id per call, which
 * would defeat the whole point.
 *
 * ## Retries and failure handling
 *
 * A job that fails (the worker's `evaluate()` call throws) goes back to `"pending"` with an
 * exponential backoff (`retryBaseDelayMs`, doubling, capped at `retryMaxDelayMs`) until
 * `maxAttempts` is reached, at which point it's marked `"dead_letter"` — a permanent, terminal
 * failure state a caller can query for and surface separately (e.g. a "coaching unavailable for
 * this answer" note), rather than being silently retried forever or silently dropped.
 *
 * ## Concurrency
 *
 * `claim()` is serialized through an in-process FIFO lock (the same pattern `lib/sarvam.ts`'s
 * `withChatSlot` already uses to bound concurrent Sarvam calls), so two `claim()` calls racing
 * within *this* process can never both pick up the same due job. This module targets a single
 * Node process (this app has no multi-process/distributed worker deployment) — a true
 * multi-process deployment would need the store's claim to be atomic at the storage layer itself
 * (e.g. a database `UPDATE ... WHERE status = 'pending' RETURNING *`), which `FileEvaluationJobStore`
 * does not attempt to provide.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type { CoachingEvent } from "../coaching";
import type { CommunicationMetrics } from "../types";
import { logger } from "../logger";

const log = logger.child({ module: "evaluation-queue" });

export type EvaluationJobStatus = "pending" | "processing" | "completed" | "failed" | "dead_letter";

/** What the evaluation worker produces for one answer. */
export interface EvaluationResult {
  summary: string;
  metrics: CommunicationMetrics;
  coachingEvents: CoachingEvent[];
}

/** Everything a caller supplies when enqueuing one finished answer for evaluation. */
export interface EvaluationJobInput {
  /** Caller-supplied idempotency key — see the module docstring. Re-enqueuing the same `id` is a
   *  safe no-op that returns the existing job. */
  id: string;
  sessionId: string;
  /** The candidate's final answer text. */
  transcript: string;
  /** Short topic label, e.g. from `InterviewTurnResponse.topic` (./ConversationEngine.ts). */
  topic: string;
  /** Optional context passed straight through to the default worker's summary prompt. */
  scenarioTitle?: string;
  /** Optional — feeds `extractDNA`'s speech-rate calculation (lib/communication-metrics.ts). */
  durationSec?: number;
}

export interface EvaluationJob extends EvaluationJobInput {
  status: EvaluationJobStatus;
  attempts: number;
  maxAttempts: number;
  /** Epoch ms. `claim()` only picks up a `"pending"` job once `Date.now() >= nextAttemptAt`. */
  nextAttemptAt: number;
  createdAt: number;
  updatedAt: number;
  lastError?: string;
  result?: EvaluationResult;
}

/** Storage abstraction for `EvaluationJob`s. See the module docstring for the two implementations
 *  below (`FileEvaluationJobStore`, `InMemoryEvaluationJobStore`). */
export interface EvaluationJobStore {
  get(id: string): Promise<EvaluationJob | null>;
  /** Persists `job` in full, overwriting any existing record with the same `id`. Must throw on
   *  failure — a caller relying on this for durability needs to know a save didn't happen. */
  save(job: EvaluationJob): Promise<void>;
  /** Every job currently in `"pending"` status, in no particular order — `EvaluationQueue.claim()`
   *  applies the `nextAttemptAt`/ordering logic on top of this. */
  listPending(): Promise<EvaluationJob[]>;
}

/** No disk I/O — for tests, or a deployment that doesn't need jobs to survive a process restart. */
export class InMemoryEvaluationJobStore implements EvaluationJobStore {
  private readonly jobs = new Map<string, EvaluationJob>();

  async get(id: string): Promise<EvaluationJob | null> {
    const job = this.jobs.get(id);
    return job ? structuredClone(job) : null;
  }

  async save(job: EvaluationJob): Promise<void> {
    this.jobs.set(job.id, structuredClone(job));
  }

  async listPending(): Promise<EvaluationJob[]> {
    return [...this.jobs.values()].filter((j) => j.status === "pending").map((j) => structuredClone(j));
  }
}

/** One JSON file per job, written atomically (temp file + rename). See the module docstring for
 *  why a failed save throws here rather than being logged and swallowed. */
export class FileEvaluationJobStore implements EvaluationJobStore {
  private readonly dataDir: string;

  constructor(dataDir?: string) {
    this.dataDir = dataDir ?? path.join(process.cwd(), ".evaluation-queue");
  }

  private fileFor(id: string): string {
    const safe = id.replace(/[^a-zA-Z0-9_:-]/g, "_").slice(0, 150) || "job";
    return path.join(this.dataDir, `${safe}.json`);
  }

  async get(id: string): Promise<EvaluationJob | null> {
    try {
      const raw = await fs.readFile(this.fileFor(id), "utf-8");
      return JSON.parse(raw) as EvaluationJob;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }

  async save(job: EvaluationJob): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true });
    const dest = this.fileFor(job.id);
    const tmp = `${dest}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(job), "utf-8");
    await fs.rename(tmp, dest); // atomic replace — never a half-written job file on disk
  }

  async listPending(): Promise<EvaluationJob[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.dataDir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
    const jobs: EvaluationJob[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      try {
        const raw = await fs.readFile(path.join(this.dataDir, entry), "utf-8");
        const job = JSON.parse(raw) as EvaluationJob;
        if (job.status === "pending") jobs.push(job);
      } catch (e) {
        log.warn("skipping unreadable job file", { entry, error: (e as Error).message });
      }
    }
    return jobs;
  }
}

export interface EvaluationQueueOptions {
  /** Defaults to a `FileEvaluationJobStore` (durable, survives a restart). */
  store?: EvaluationJobStore;
  /** Default 3. */
  maxAttempts?: number;
  /** Default 2000ms, doubling per attempt, capped at `retryMaxDelayMs`. */
  retryBaseDelayMs?: number;
  /** Default 60000ms. */
  retryMaxDelayMs?: number;
}

export class EvaluationQueue {
  private readonly store: EvaluationJobStore;
  private readonly maxAttempts: number;
  private readonly retryBaseDelayMs: number;
  private readonly retryMaxDelayMs: number;

  /** FIFO lock serializing claim() within this process — see the module docstring on concurrency. */
  private claimLock: Promise<void> = Promise.resolve();

  constructor(opts: EvaluationQueueOptions = {}) {
    this.store = opts.store ?? new FileEvaluationJobStore();
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.retryBaseDelayMs = opts.retryBaseDelayMs ?? 2000;
    this.retryMaxDelayMs = opts.retryMaxDelayMs ?? 60_000;
  }

  /**
   * Enqueue one finished answer for evaluation. Idempotent: if `input.id` already has a job,
   * returns it unchanged rather than creating (or resetting) a duplicate. Fast — a single
   * persistence write, never itself calling into evaluation logic — safe to `await` from the
   * realtime response path without blocking it on anything slow.
   */
  async enqueue(input: EvaluationJobInput): Promise<EvaluationJob> {
    const existing = await this.store.get(input.id);
    if (existing) return existing;

    const now = Date.now();
    const job: EvaluationJob = {
      ...input,
      status: "pending",
      attempts: 0,
      maxAttempts: this.maxAttempts,
      nextAttemptAt: now,
      createdAt: now,
      updatedAt: now,
    };
    await this.store.save(job);
    return job;
  }

  /**
   * Atomically (within this process — see the module docstring) picks up one due job, marks it
   * `"processing"`, increments its attempt count, persists that, and returns it. Returns `null` if
   * nothing is currently due. The oldest-due job wins when more than one qualifies.
   */
  async claim(now: number = Date.now()): Promise<EvaluationJob | null> {
    return this.withClaimLock(async () => {
      const pending = await this.store.listPending();
      const due = pending.filter((j) => j.nextAttemptAt <= now);
      if (due.length === 0) return null;
      due.sort((a, b) => a.nextAttemptAt - b.nextAttemptAt || a.createdAt - b.createdAt);

      const job = due[0];
      job.status = "processing";
      job.attempts += 1;
      job.updatedAt = now;
      await this.store.save(job);
      return job;
    });
  }

  /** Mark a claimed job as successfully evaluated, storing its result. */
  async complete(id: string, result: EvaluationResult): Promise<void> {
    const job = await this.store.get(id);
    if (!job) return;
    job.status = "completed";
    job.result = result;
    job.lastError = undefined;
    job.updatedAt = Date.now();
    await this.store.save(job);
  }

  /**
   * Mark a claimed job's attempt as failed. Schedules a retry with exponential backoff if
   * `attempts < maxAttempts`; otherwise marks the job `"dead_letter"` — a permanent failure a
   * caller can query for (`get()`) and surface separately, never retried again.
   */
  async fail(id: string, error: string): Promise<void> {
    const job = await this.store.get(id);
    if (!job) return;

    job.lastError = error;
    job.updatedAt = Date.now();
    if (job.attempts >= job.maxAttempts) {
      job.status = "dead_letter";
      log.warn("evaluation job exhausted retries", { id, attempts: job.attempts, error });
    } else {
      job.status = "pending";
      const delay = Math.min(this.retryBaseDelayMs * 2 ** (job.attempts - 1), this.retryMaxDelayMs);
      job.nextAttemptAt = Date.now() + delay;
      log.warn("evaluation job failed, will retry", { id, attempt: job.attempts, delayMs: delay, error });
    }
    await this.store.save(job);
  }

  async get(id: string): Promise<EvaluationJob | null> {
    return this.store.get(id);
  }

  private async withClaimLock<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.claimLock;
    let release!: () => void;
    this.claimLock = new Promise<void>((resolve) => (release = resolve));
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
