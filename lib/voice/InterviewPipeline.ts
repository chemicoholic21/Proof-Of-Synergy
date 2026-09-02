/**
 * lib/voice/InterviewPipeline.ts
 *
 * Wires the previously-standalone, individually-tested modules from lib/interview/ and
 * lib/providers/ into the single running pipeline the "parallel event-driven architecture"
 * diagram describes, and hands the result to a `VoiceSession` (./VoiceSession.ts) as its
 * `generateReply` / `synthesizeSpeechStream`. Before this file existed, every one of those modules
 * had its own passing test suite but nothing ever called any of them from a live session — this is
 * the assembly step that makes the diagram real instead of a set of disconnected boxes.
 *
 * ## What "Turn Decision" + the three parallel lanes actually map to here
 *
 *   transcript
 *     -> InferenceRouter.route()                                    ["Turn Decision"]
 *          -> deterministic: return the canned speech, no LLM call at all
 *          -> needs the LLM:
 *               ContextBuilder.build()  -> ConversationEngine.nextTurn() -> ResponsePlanner.plan()
 *                                                                          ["Fast Response Lane"]
 *               -> EvaluationQueue.enqueue(), fired WITHOUT awaiting     ["Background Evaluation" kickoff]
 *               -> reply text returned to VoiceSession immediately, unblocked by the line above
 *
 *   EvaluationWorker (its own independent poll loop — see start(), never on the reply's critical path)
 *     -> defaultEvaluate() (heuristic coaching + communication metrics)
 *     -> EvidenceEvaluator.evaluate() (evidence-grounded technical scoring, a second/parallel use of
 *        the LLM distinct from the conversational one — see EvidenceEvaluator's own module docstring
 *        on why it deliberately differs from ConversationEngine's model choice)
 *     -> DifficultyController.decide()
 *     -> MemoryEngine mutation (adjustDifficulty/recordStrength/recordWeakness/recordCoveredTopic)
 *                                                                          ["Memory Update" / "Structured State"]
 *        which then feeds back into every future turn's ContextBuilder.build() call automatically,
 *        since ContextBuilder reads `memory.buildContextSummary()` live — no extra plumbing needed.
 *
 *   reply text -> SpeechChunker -> TTSProvider (Bulbul) -> onAudioChunk -> the per-chunk `onChunk`
 *     callback VoiceSession's `synthesizeSpeechStream` contract expects.
 *
 * `InterviewPipeline` owns one `VoiceSession` per instance, built from its own bound
 * `generateReply`/`synthesizeSpeechStream` methods, so a caller (the realtime gateway server, not
 * yet built as of this file) only ever constructs and talks to one object per live interview.
 *
 * ## Known, honest limitations
 * - `ConversationEngine.nextTurn()` returns one complete structured JSON response, not a true
 *   token stream (structured output can't be validated until the whole thing has arrived — see
 *   ConversationEngine's own module docstring). "Streaming" here means pushing the *complete* reply
 *   text through `SpeechChunker` for progressive Bulbul playback, not genuine token-by-token
 *   generation. The diagram's "Token Stream" box is therefore an honest simplification: chunked TTS
 *   delivery is real, sentence-by-sentence generation is not, and this file does not pretend
 *   otherwise.
 * - Contradiction *detection* (comparing an answer against something the candidate said earlier)
 *   is not implemented anywhere in this codebase yet; `DifficultyController`'s `CLARIFY_CONTRADICTION`
 *   rule only ever fires here if some other, not-yet-built component calls
 *   `memory.recordContradiction()` first. This file does not fabricate that detection.
 * - Interview kickoff (the opening question) is out of scope — this pipeline only wires the
 *   ongoing turn loop that runs after the first question has already been asked (see
 *   `initialQuestion` below to seed it from whatever asked that first question).
 * - Fully unit-testable with fakes: every real provider (`SarvamRealtimeSTT`, `BulbulV3TTSProvider`,
 *   `SarvamLLM`) is injectable and constructed lazily only when not supplied, matching every other
 *   module in this project. No `SARVAM_API_KEY`/`GEMINI_API_KEY` is required to exercise this file's
 *   own test suite.
 */

import { VoiceSession, type GenerateReply, type SynthesizeSpeechStream } from "./VoiceSession";
import { SpeechChunker, type SpeechChunkerOptions } from "./SpeechChunker";
import type { TurnManager } from "./TurnManager";
import { createInterviewEventBus, type InterviewEventBus } from "../events/EventBus";

import { InferenceRouter } from "../interview/InferenceRouter";
import { ContextBuilder, type ContextBuilderOptions, type ResumeFact } from "../interview/ContextBuilder";
import { ConversationEngine } from "../interview/ConversationEngine";
import { ResponsePlanner } from "../interview/ResponsePlanner";
import { MemoryEngine } from "../interview/MemoryEngine";
import { EvidenceEvaluator } from "../interview/EvidenceEvaluator";
import { DifficultyController } from "../interview/DifficultyController";
import { EvaluationQueue, InMemoryEvaluationJobStore } from "../interview/EvaluationQueue";
import { EvaluationWorker, defaultEvaluate, type EvaluateFn, type EvaluationWorkerEvent } from "../interview/EvaluationWorker";

import type { LLMMessage, LLMProvider } from "../providers/llm/types";
import { SarvamLLM } from "../providers/llm/SarvamLLM";
import type { STTProvider } from "../providers/stt/STTProvider";
import { SarvamRealtimeSTT } from "../providers/stt/SarvamRealtimeSTT";
import type { TTSProvider } from "../providers/tts/TTSProvider";
import { BulbulV3TTSProvider } from "../providers/tts/BulbulV3TTSProvider";

export interface InterviewPipelineOptions {
  /** Identifies this interview for `EvaluationQueue` job ids and logging. */
  sessionId: string;
  /** Passed straight through to `EvaluationQueue` jobs' `scenarioTitle`. */
  scenarioTitle?: string;
  /** Always-included interviewer persona/context — forwarded to `ContextBuilder.build()`. */
  stableInstructions?: string;
  /** The candidate's resume, pre-split into topic-tagged facts — forwarded to `ContextBuilder`. */
  resumeFacts?: ResumeFact[];
  /** Seeds `InferenceRouter`'s `lastQuestion` for a "could you repeat that" style deterministic
   *  reply on the very first turn, when the caller already asked an opening question before
   *  constructing this pipeline (see the module docstring's kickoff-is-out-of-scope note). */
  initialQuestion?: string;
  /** BCP-47-ish language tag used for the default `SarvamRealtimeSTT`/`BulbulV3TTSProvider`.
   *  Ignored for either one that's explicitly injected. Defaults to `"en-IN"`. */
  language?: string;

  sttProvider?: STTProvider;
  ttsProvider?: TTSProvider;
  /** LLM for `ConversationEngine` (the fast response lane). Defaults to a `SarvamLLM`. */
  conversationLLM?: LLMProvider;
  /** LLM for `EvidenceEvaluator` (background evaluation). Defaults to a separate `SarvamLLM`
   *  instance — see `EvidenceEvaluator`'s own docstring on why this is deliberately independent
   *  from `conversationLLM`. */
  evaluationLLM?: LLMProvider;

  memory?: MemoryEngine;
  eventBus?: InterviewEventBus;
  turnManager?: TurnManager;

  inferenceRouter?: InferenceRouter;
  contextBuilderOptions?: ContextBuilderOptions;
  responsePlanner?: ResponsePlanner;
  difficultyController?: DifficultyController;
  speechChunkerOptions?: SpeechChunkerOptions;

  /** Defaults to a fresh, in-memory-backed `EvaluationQueue` — this pipeline doesn't assume a
   *  durable store; inject one backed by `FileEvaluationJobStore` (the queue's own default) for
   *  jobs that must survive a process restart. */
  evaluationQueue?: EvaluationQueue;
  /** Overrides the composed default evaluate function (defaultEvaluate + EvidenceEvaluator) — a
   *  test hook, or a way to swap in a different evaluation strategy entirely. */
  evaluate?: EvaluateFn;
  /** Forwarded to `EvaluationWorker.start()`. Default 1000ms. */
  evaluationIdleDelayMs?: number;
  /** Set `false` to keep the worker's poll loop from starting automatically — tests that want to
   *  drive evaluation deterministically should do this and call `evaluationWorker.processOne()`
   *  (via `runEvaluationOnce()` below) themselves instead of racing a background timer. */
  autoStartEvaluationWorker?: boolean;
  /** How long `synthesizeSpeechStream` waits for `TTSProvider.onComplete()` before treating the
   *  utterance as failed, so a stuck TTS connection can't hang a turn forever. Default 30000ms. */
  ttsTimeoutMs?: number;
}

/** Directives from `DifficultyController.decide()` that should record a new memory fact — see
 *  `handleEvaluationEvent()` below. `CLARIFY_CONTRADICTION` is deliberately absent: nothing new
 *  is learned about the candidate by resolving a contradiction that's already recorded. */
const STRENGTH_DIRECTIVES = new Set(["INCREASE_DIFFICULTY", "DEEPEN_TOPIC", "PROBE_DEPTH"]);

/**
 * Owns one live interview's worth of state and wiring: a `VoiceSession` (turn FSM + STT), the
 * fast-response generation chain, and a background `EvaluationWorker` feeding results back into
 * `MemoryEngine`. Construct one per interview session; call `start()` before use and `end()` when
 * the interview is over.
 */
export class InterviewPipeline {
  readonly session: VoiceSession;
  readonly memory: MemoryEngine;
  readonly events: InterviewEventBus;
  readonly evaluationQueue: EvaluationQueue;
  readonly evaluationWorker: EvaluationWorker;

  private readonly sessionId: string;
  private readonly scenarioTitle?: string;
  private readonly stableInstructions?: string;
  private readonly resumeFacts: ResumeFact[];
  private readonly language: string;
  private readonly ttsTimeoutMs: number;

  private readonly ttsProvider: TTSProvider;
  private readonly conversationLLM: LLMProvider;
  private readonly router: InferenceRouter;
  private readonly contextBuilderOptions: ContextBuilderOptions;
  private readonly responsePlanner: ResponsePlanner;
  private readonly difficultyController: DifficultyController;
  private readonly speechChunkerOptions: SpeechChunkerOptions | undefined;

  private readonly history: LLMMessage[] = [];
  private currentTopic = "general";
  private lastQuestion: string | undefined;
  private turnCounter = 0;

  /** The single in-flight TTS utterance, if any — see the module docstring's note on why
   *  `TTSProvider.onAudioChunk()`/`onComplete()` are registered exactly once rather than per turn
   *  (they're accumulating listener arrays with no unsubscribe; re-registering every turn would
   *  leak and let a finished turn's stale listener misfire on a later turn's audio). */
  private currentUtterance: { onChunk: (audio: ArrayBuffer) => void; finish: (err?: Error) => void } | null = null;

  constructor(opts: InterviewPipelineOptions) {
    this.sessionId = opts.sessionId;
    this.scenarioTitle = opts.scenarioTitle;
    this.stableInstructions = opts.stableInstructions;
    this.resumeFacts = opts.resumeFacts ?? [];
    this.lastQuestion = opts.initialQuestion;
    this.language = opts.language ?? "en-IN";
    this.ttsTimeoutMs = opts.ttsTimeoutMs ?? 30_000;

    this.memory = opts.memory ?? new MemoryEngine();
    this.events = opts.eventBus ?? createInterviewEventBus();
    this.router = opts.inferenceRouter ?? new InferenceRouter();
    this.contextBuilderOptions = opts.contextBuilderOptions ?? {};
    this.responsePlanner = opts.responsePlanner ?? new ResponsePlanner();
    this.difficultyController = opts.difficultyController ?? new DifficultyController();
    this.speechChunkerOptions = opts.speechChunkerOptions;

    this.conversationLLM = opts.conversationLLM ?? new SarvamLLM();
    this.ttsProvider = opts.ttsProvider ?? new BulbulV3TTSProvider({ languageCode: this.language });
    const sttProvider = opts.sttProvider ?? new SarvamRealtimeSTT();

    // Registered once, for this pipeline's whole lifetime — see `currentUtterance`'s doc comment.
    this.ttsProvider.onAudioChunk((audio) => this.currentUtterance?.onChunk(audio));
    this.ttsProvider.onComplete(() => this.currentUtterance?.finish());

    const evidenceEvaluator = new EvidenceEvaluator({ llm: opts.evaluationLLM });
    const evaluate: EvaluateFn =
      opts.evaluate ??
      (async (job) => {
        const base = await defaultEvaluate(job);
        try {
          const evidence = await evidenceEvaluator.evaluate({ answer: job.transcript, topic: job.topic });
          return { ...base, evidence };
        } catch {
          // Evidence scoring is a bonus signal for difficulty adjustment, not a hard requirement —
          // a failure here still leaves the base coaching/metrics result intact.
          return base;
        }
      });

    this.evaluationQueue = opts.evaluationQueue ?? new EvaluationQueue({ store: new InMemoryEvaluationJobStore() });
    this.evaluationWorker = new EvaluationWorker({
      queue: this.evaluationQueue,
      evaluate,
      onEvent: (event) => this.handleEvaluationEvent(event),
    });
    if (opts.autoStartEvaluationWorker ?? true) {
      this.evaluationWorker.start({ idleDelayMs: opts.evaluationIdleDelayMs ?? 1000 });
    }

    this.session = new VoiceSession({
      sttProvider,
      turnManager: opts.turnManager,
      eventBus: this.events,
      generateReply: this.generateReply,
      synthesizeSpeechStream: this.synthesizeSpeechStream,
    });
  }

  /** Connects the TTS provider (once, for the session's whole lifetime — `TTSProvider.connect()`
   *  called again mid-conversation would reset it, per its own contract) and starts the
   *  `VoiceSession`'s STT connection. */
  async start(): Promise<void> {
    await this.ttsProvider.connect();
    await this.session.start();
  }

  /** Stops the background evaluation loop, ends the `VoiceSession`, and disconnects the TTS
   *  provider. Safe to call once the interview is over; does not throw if disconnecting fails. */
  async end(): Promise<void> {
    this.evaluationWorker.stop();
    await this.session.end();
    await this.ttsProvider.disconnect().catch(() => {});
  }

  /** Drives one evaluation job synchronously instead of waiting on the background poll loop —
   *  intended for tests constructed with `autoStartEvaluationWorker: false`. */
  async runEvaluationOnce(): Promise<boolean> {
    return this.evaluationWorker.processOne();
  }

  /** The `GenerateReply` handed to this pipeline's `VoiceSession` — the "Turn Decision" +
   *  "Fast Response Lane" + background-evaluation-kickoff chain described in the module docstring. */
  generateReply: GenerateReply = async (transcript, signal) => {
    this.turnCounter += 1;
    const turnId = `${this.sessionId}:${this.turnCounter}`;

    const routing = this.router.route({
      transcript,
      topic: this.currentTopic,
      lastQuestion: this.lastQuestion,
    });

    if (routing.isDeterministic && routing.deterministicResponse) {
      const { speech, topic } = routing.deterministicResponse;
      this.currentTopic = topic;
      this.lastQuestion = speech;
      return speech;
    }

    this.history.push({ role: "user", content: transcript });

    const builder =
      routing.reducedContext && routing.contextBudget
        ? new ContextBuilder({
            ...this.contextBuilderOptions,
            maxRecentMessages: routing.contextBudget.maxRecentMessages,
            maxRecentChars: routing.contextBudget.maxRecentChars,
          })
        : new ContextBuilder(this.contextBuilderOptions);

    const built = builder.build({
      stableInstructions: this.stableInstructions,
      memory: this.memory,
      currentTopic: this.currentTopic,
      resumeFacts: this.resumeFacts,
      recentTurns: this.history,
    });

    const engine = new ConversationEngine({ llm: this.conversationLLM, systemPrompt: built.systemPromptExtra });
    const decision = await engine.nextTurn(built.messages, { signal });
    const plan = this.responsePlanner.plan(decision);

    this.history.push({ role: "assistant", content: decision.speech });
    this.currentTopic = plan.topic;
    if (plan.expectsUserAnswer) this.lastQuestion = plan.ttsText;

    if (routing.needsDeepEvaluation && plan.requiresEvaluation) {
      // Fire-and-forget: this is the literal "parallel" branch — the fast response below returns
      // to VoiceSession (and starts being spoken) without ever waiting on evaluation to finish.
      void this.evaluationQueue
        .enqueue({
          id: turnId,
          sessionId: this.sessionId,
          transcript,
          topic: plan.topic,
          scenarioTitle: this.scenarioTitle,
        })
        .catch(() => {
          // Best-effort: a failed enqueue only loses coaching/difficulty feedback for this one
          // turn — it never blocks or corrupts the live conversation, which has already moved on.
        });
    }

    return plan.ttsText;
  };

  /** The `SynthesizeSpeechStream` handed to this pipeline's `VoiceSession` — chunks `text` through
   *  `SpeechChunker` and feeds each chunk to the (already-connected) `TTSProvider`, resolving when
   *  Bulbul reports the utterance complete. See the module docstring's "Known limitations" on why
   *  this is chunked-delivery streaming, not token-level streaming. */
  synthesizeSpeechStream: SynthesizeSpeechStream = async (text, onChunk, signal) => {
    const trimmed = text.trim();
    if (!trimmed || signal.aborted) return;

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let timeoutHandle: ReturnType<typeof setTimeout>;

      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        signal.removeEventListener("abort", onAbort);
        this.currentUtterance = null;
        if (err) reject(err);
        else resolve();
      };

      const onAbort = () => {
        this.ttsProvider.cancel();
        finish();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      timeoutHandle = setTimeout(
        () => finish(new Error(`InterviewPipeline: TTS did not complete within ${this.ttsTimeoutMs}ms`)),
        this.ttsTimeoutMs
      );

      this.currentUtterance = {
        onChunk: (audio) => {
          if (!signal.aborted) onChunk(audio);
        },
        finish,
      };

      const chunker = new SpeechChunker(this.speechChunkerOptions);
      chunker.onChunk((piece) => {
        if (!signal.aborted) this.ttsProvider.sendText(piece);
      });
      chunker.onComplete(() => {
        if (!signal.aborted) this.ttsProvider.flush();
      });

      chunker.push(trimmed);
      chunker.flush();
    });
  };

  /** The "Background Evaluation -> Memory Update" chain: applies `DifficultyController`'s
   *  recommendation to `MemoryEngine` once an evaluation job completes. Runs on the
   *  `EvaluationWorker`'s own poll loop, never on `generateReply`'s critical path. */
  private handleEvaluationEvent(event: EvaluationWorkerEvent): void {
    if (event.type !== "completed") return;
    const evidence = event.result.evidence;
    if (!evidence) return;

    const decision = this.difficultyController.decide({
      evaluation: evidence,
      topic: event.job.topic,
      memory: this.memory,
    });
    this.memory.adjustDifficulty(decision.difficultyDelta, decision.reason);

    const evidenceQuote = evidence.evidence[0]?.quote;
    if (decision.directive === "SIMPLIFY") {
      this.memory.recordWeakness({ description: decision.reason, topic: event.job.topic, evidenceQuote });
    } else if (STRENGTH_DIRECTIVES.has(decision.directive)) {
      this.memory.recordStrength({ description: decision.reason, topic: event.job.topic, evidenceQuote });
    } else if (decision.directive === "CHANGE_TOPIC") {
      this.memory.recordCoveredTopic(event.job.topic);
    }
    // CLARIFY_CONTRADICTION: nothing new to record — see STRENGTH_DIRECTIVES's doc comment.
  }
}
