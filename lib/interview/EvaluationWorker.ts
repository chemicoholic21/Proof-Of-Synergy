/**
 * The "Evaluation worker" box in:
 *
 *   Final answer -> Queue (./EvaluationQueue.ts) -> Evaluation worker (this file)
 *
 * `EvaluationWorker` pulls due jobs off an `EvaluationQueue` and scores them via an injected
 * `evaluate()` function, reporting success/failure back to the queue (which owns retry/backoff/
 * dead-lettering — see EvaluationQueue.ts). This file never touches the realtime response path
 * itself; it only ever runs against jobs that already landed in the queue.
 *
 * The default `evaluate()` reuses exactly what `app/api/coaching/summary`/`app/api/coaching/metrics`
 * already do today — `extractDNA` (lib/communication-metrics.ts) for metrics, `analyzeWithHeuristics`
 * (lib/coaching.ts) for coaching events, and Sarvam-then-Gemini (`generateWithSarvam`/
 * `generateWithGemini`, lib/prompts.ts) for the written summary — but with one deliberate
 * difference in failure posture. Those routes serve a live HTTP request, so they must respond with
 * *something* right now and fall back to a heuristic summary the instant the LLM call fails.
 * A background job has no such deadline: letting a transient LLM failure (a timeout, a 500, a rate
 * limit) *throw* here means `EvaluationQueue.fail()` schedules a retry for when the provider might
 * be back, which produces a *better* summary than immediately settling for the heuristic-only one.
 * The heuristic fallback is still used, but only for the one condition retrying can't fix at all:
 * neither Sarvam nor Gemini is configured.
 */

import { extractDNA } from "../communication-metrics";
import { analyzeWithHeuristics } from "../coaching";
import { generateWithSarvam, generateWithGemini, summaryUserPrompt, SUMMARY_SYSTEM } from "../prompts";
import { sarvamConfigured, geminiConfigured } from "../env";
import { logger } from "../logger";
import type { EvaluationJob, EvaluationQueue, EvaluationResult } from "./EvaluationQueue";
import type { CommunicationMetrics } from "../types";
import type { CoachingEvent } from "../coaching";

const log = logger.child({ module: "evaluation-worker" });

export type EvaluateFn = (job: EvaluationJob) => Promise<EvaluationResult>;

/** A short, honest, non-LLM summary — used only when no chat provider is configured at all (a
 *  permanent condition retrying the job would never fix), never as a first-choice fallback. */
function heuristicSummary(metrics: CommunicationMetrics, coachingEvents: CoachingEvent[]): string {
  const highlights = coachingEvents
    .filter((e) => e.type === "positive")
    .slice(0, 2)
    .map((e) => e.suggestion || e.text);
  const improvements = coachingEvents
    .filter((e) => e.type !== "positive")
    .slice(0, 2)
    .map((e) => e.suggestion || e.text);

  const parts = [`You spoke ${metrics.wordCount} words with a confidence score of ${metrics.confidence}/100.`];
  if (highlights.length) parts.push(`Strengths: ${highlights.join("; ")}.`);
  if (improvements.length) parts.push(`Try next: ${improvements.join("; ")}.`);
  return parts.join(" ");
}

async function generateSummary(job: EvaluationJob, metrics: CommunicationMetrics, coachingEvents: CoachingEvent[]): Promise<string> {
  if (!sarvamConfigured() && !geminiConfigured()) {
    return heuristicSummary(metrics, coachingEvents);
  }

  const user = summaryUserPrompt({
    fillerCount: metrics.fillerCount,
    confidence: metrics.confidence,
    wordCount: metrics.wordCount,
    scenarioTitle: job.scenarioTitle ?? job.topic,
    coachingEvents: coachingEvents.map((e) => ({ type: e.type, text: e.text })),
  });

  if (sarvamConfigured()) {
    try {
      return await generateWithSarvam(SUMMARY_SYSTEM, user, { temperature: 0.4, maxTokens: 300 });
    } catch (e) {
      if (!geminiConfigured()) throw e; // no fallback provider — let the queue retry this failure
      log.warn("evaluation summary: sarvam failed, falling back to gemini", { error: (e as Error).message });
    }
  }
  return await generateWithGemini(SUMMARY_SYSTEM, user, { temperature: 0.4, maxTokens: 300 }); // let a real failure propagate and retry
}

/** Default `evaluate()`: metrics + heuristic coaching events are always computed locally (fast,
 *  no network); the summary tries an LLM first and only degrades to a heuristic one when no
 *  provider is configured at all — see the module docstring. */
export const defaultEvaluate: EvaluateFn = async (job) => {
  const metrics = extractDNA(job.transcript, job.durationSec);
  const { coachingEvents } = analyzeWithHeuristics(job.transcript, metrics);
  const summary = await generateSummary(job, metrics, coachingEvents);
  return { summary, metrics, coachingEvents };
};

export type EvaluationWorkerEvent =
  | { type: "completed"; job: EvaluationJob; result: EvaluationResult }
  | { type: "failed"; job: EvaluationJob; error: Error };

export interface EvaluationWorkerOptions {
  queue: EvaluationQueue;
  /** Defaults to `defaultEvaluate` (see above). Inject your own to score answers differently, or
   *  as a fake in tests. */
  evaluate?: EvaluateFn;
  /** Observability hook: fired after every processed job, success or failure. Never throws back
   *  into the worker — an exception from this callback is caught and logged, not propagated. */
  onEvent?: (event: EvaluationWorkerEvent) => void;
}

export class EvaluationWorker {
  private readonly queue: EvaluationQueue;
  private readonly evaluate: EvaluateFn;
  private readonly onEvent: ((event: EvaluationWorkerEvent) => void) | undefined;
  private loopTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(opts: EvaluationWorkerOptions) {
    this.queue = opts.queue;
    this.evaluate = opts.evaluate ?? defaultEvaluate;
    this.onEvent = opts.onEvent;
  }

  /**
   * Claim and process a single due job, if any. Returns `true` if a job was found (whether it
   * then succeeded or failed), `false` if the queue had nothing due right now. Never throws — a
   * failure in `evaluate()` is caught and reported to the queue via `fail()`, not raised here.
   */
  async processOne(): Promise<boolean> {
    const job = await this.queue.claim();
    if (!job) return false;

    try {
      const result = await this.evaluate(job);
      await this.queue.complete(job.id, result);
      this.emit({ type: "completed", job, result });
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      await this.queue.fail(job.id, error.message);
      this.emit({ type: "failed", job, error });
    }
    return true;
  }

  /**
   * Runs `processOne()` in a loop, waiting `idleDelayMs` after an empty queue and `busyDelayMs`
   * (default 0 — immediately) after processing a job, so a backlog drains quickly without a tight
   * empty-queue polling loop burning cycles. Call `stop()` to end the loop; safe to call `start()`
   * more than once (a second call while already running is a no-op).
   */
  start(opts: { idleDelayMs?: number; busyDelayMs?: number } = {}): void {
    if (this.running) return;
    this.running = true;
    const idleDelayMs = opts.idleDelayMs ?? 1000;
    const busyDelayMs = opts.busyDelayMs ?? 0;

    const tick = async () => {
      if (!this.running) return;
      let processed = false;
      try {
        processed = await this.processOne();
      } catch (e) {
        // processOne() is designed to never throw, but a broken injected onEvent() or an
        // unexpected queue-layer error must still never kill the loop outright.
        log.warn("evaluation worker tick failed unexpectedly", { error: (e as Error).message });
      }
      if (!this.running) return;
      this.loopTimer = setTimeout(tick, processed ? busyDelayMs : idleDelayMs);
    };

    void tick();
  }

  /** Stop the loop started by `start()`. Does not interrupt a job currently mid-`evaluate()` call.
   *  Safe to call more than once, or before `start()` was ever called. */
  stop(): void {
    this.running = false;
    if (this.loopTimer) {
      clearTimeout(this.loopTimer);
      this.loopTimer = null;
    }
  }

  private emit(event: EvaluationWorkerEvent): void {
    if (!this.onEvent) return;
    try {
      this.onEvent(event);
    } catch (e) {
      log.warn("evaluation worker onEvent callback threw", { error: (e as Error).message });
    }
  }
}
