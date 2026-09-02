/**
 * Orchestration layer for one voice interview conversation.
 *
 * `VoiceSession` is where the pieces built in earlier phases meet: it owns an `STTProvider`
 * (lib/providers/stt/STTProvider.ts — any conforming implementation, batch or realtime), a
 * `TurnManager` (./TurnManager.ts — the deterministic turn-lifecycle FSM), and an `InterviewEvent`
 * bus (lib/events/EventBus.ts + lib/events/interviewEvents.ts), and coordinates them with
 * downstream agent-reply generation (LLM) and speech synthesis (TTS) to run one end-to-end voice
 * turn: audio in -> transcript -> agent reply -> synthesized speech -> ready for the next turn.
 *
 * This module contains no UI code whatsoever — no React, no DOM, no browser APIs. It doesn't
 * capture a microphone, run VAD, or play audio; those stay exactly where they already live
 * (`components/VoiceRecorder.tsx`, `lib/vad.ts`, `lib/tts-client.ts`) or, for a future realtime
 * bridge, in whatever server-side transport (e.g. a WebSocket route) drives this class. A caller
 * feeds this class two kinds of input — "the learner said/paused/stopped talking" and "here's a
 * chunk of their audio" — and reacts to what comes out: `InterviewEvent`s on `session.events`, and
 * synthesized reply audio via `onAudio()`.
 *
 * ## What this class controls
 *
 * - **STT connection**: `start()` connects the injected `STTProvider`; `pushAudio()` forwards
 *   captured audio to it; `submitUtterance()` asks it to finalize (see below); `end()` disconnects
 *   it. Transcripts arrive via the provider's own `onPartial`/`onFinal` callbacks, which this class
 *   translates into `PARTIAL_TRANSCRIPT`/`FINAL_TRANSCRIPT` events and turn-manager transitions.
 * - **LLM generation**: once a final transcript lands, `AGENT_GENERATION_STARTED` is published and
 *   the injected `generateReply` is called; success publishes `AGENT_GENERATION_COMPLETED` with the
 *   reply text and moves on to TTS; failure publishes an `ERROR` event and returns to `LISTENING`.
 * - **TTS generation**: `TTS_PLAYBACK_STARTED` is published and the injected `synthesizeSpeech` is
 *   called with the reply text; success publishes `TTS_PLAYBACK_COMPLETED`, hands the synthesized
 *   audio to every `onAudio()` callback, and returns to `LISTENING`. (These two event names are
 *   inherited from lib/events/interviewEvents.ts, where they were written to describe the
 *   browser's *playback* of audio — this class fires them at the *generation* boundary instead,
 *   since actual playback happens downstream, outside anything this class can observe. See that
 *   module's docstring; this is a deliberate, documented reuse, not a mismatch.)
 * - **Cancellation**: `interrupt()` aborts whichever of the two calls above is in flight (via
 *   `AbortController`), transitions to `INTERRUPTED`, and publishes `AGENT_INTERRUPTED`. `end()`
 *   also cancels any in-flight call as part of tearing the session down.
 * - **Session lifecycle**: `start()` / `end()` bookend the conversation — connecting/disconnecting
 *   the STT provider, seeding `TurnManager` at `LISTENING`, and (if this instance created its own
 *   event bus rather than being handed a shared one) disposing it on the way out.
 *
 * ## Utterance boundaries: two valid patterns
 *
 * `STTProvider.onFinal` is the only true signal an utterance is complete, but providers differ in
 * what triggers it:
 *   - A provider with native server-side speech segmentation (`SarvamRealtimeSTT`'s default VAD
 *     endpointing) fires `onFinal` **on its own** as the learner pauses — just call `pushAudio()`
 *     continuously and this class reacts automatically. `submitUtterance()` never needs to be
 *     called on this path.
 *   - A provider with no segmentation of its own (`SarvamSTTProvider`, which only ever transcribes
 *     "everything sent since connect()") only fires `onFinal` in response to `disconnect()`. For
 *     this provider, the caller **must** call `submitUtterance()` once per utterance (typically
 *     driven by the same VAD/auto-stop signal that already exists in `VoiceRecorder.tsx` today) —
 *     it finalizes the current utterance via the provider's own documented `disconnect()` contract
 *     ("any audio already sent is finalized before this resolves") and then reconnects the
 *     provider to accept the next one.
 *
 * `pushAudio()`/`submitUtterance()`/`interrupt()` all validate the current `TurnManager` state
 * before acting and throw (or, for `interrupt()`, return `false`) on a call that doesn't make
 * sense right now — the same "reject invalid transitions" discipline `TurnManager` itself applies.
 *
 * ## What this class deliberately does NOT do
 *
 * - Manage conversation history or scenario/system-prompt selection. The default `generateReply`
 *   is a single-turn wrapper with no memory of earlier turns — inject a closure that folds in
 *   history for anything beyond one exchange (that bookkeeping belongs one layer up, where
 *   `app/practice/page.tsx` already keeps it today).
 * - Guarantee true mid-flight cancellation of the default `generateReply`/`synthesizeSpeech`
 *   network calls — `lib/prompts.ts`/`lib/sarvam.ts` don't accept an external `AbortSignal` today,
 *   so the default wrappers can only stop VoiceSession from *acting* on a late result, not kill the
 *   underlying HTTP request. A caller that needs the request itself killed must inject its own
 *   cancellation-aware functions.
 * - Emit latency metrics. Every `InterviewEvent` already carries a `timestamp`; a caller that wants
 *   `lib/observability/VoiceMetrics.ts`-style numbers can subscribe to `session.events` and feed
 *   the marks in itself.
 */

import { TurnManager, type TurnState } from "./TurnManager";
import { createInterviewEventBus, type InterviewEventBus } from "../events/EventBus";
import type { InterviewErrorStage, InterviewEvent, InterviewInterruptedStage } from "../events/interviewEvents";
import type { STTProvider } from "../providers/stt/STTProvider";
import { generatePartnerReply, SCENARIO_SYSTEM } from "../prompts";
import { sarvamTTS } from "../sarvam";
import { logger } from "../logger";

const log = logger.child({ module: "voice-session" });

export type GenerateReply = (transcript: string, signal: AbortSignal) => Promise<string>;
export type SynthesizeSpeech = (text: string, signal: AbortSignal) => Promise<ArrayBuffer>;
export type AudioCallback = (audio: ArrayBuffer, text: string) => void;

export interface VoiceSessionOptions {
  /** The STT vendor this session talks to — any conforming `STTProvider` works interchangeably. */
  sttProvider: STTProvider;
  /** Defaults to a fresh `TurnManager()` (starts at `IDLE`). Inject one to share FSM state with
   *  another component, or to start from a non-default state in a test. */
  turnManager?: TurnManager;
  /** Defaults to a fresh, privately-owned event bus, disposed automatically by `end()`. Inject one
   *  to share a single `InterviewEvent` stream with other consumers — in that case `end()` will
   *  NOT dispose it, since those other consumers may still need it. */
  eventBus?: InterviewEventBus;
  /** System prompt for the default `generateReply`. Ignored if `generateReply` is supplied.
   *  Defaults to `SCENARIO_SYSTEM` from lib/prompts.ts. */
  systemPrompt?: string;
  /** Target language for the default `synthesizeSpeech`. Ignored if `synthesizeSpeech` is
   *  supplied. Defaults to `"en-IN"`. */
  language?: string;
  /** Produces the agent's reply text for one finalized user turn. See the module docstring for
   *  the default implementation's known limitations (no history, no true cancellation). */
  generateReply?: GenerateReply;
  /** Synthesizes speech audio for the agent's reply text. Same known limitations as
   *  `generateReply` above. */
  synthesizeSpeech?: SynthesizeSpeech;
}

function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === "AbortError";
}

function defaultGenerateReply(systemPrompt: string): GenerateReply {
  return async (transcript, signal) => {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    return generatePartnerReply(systemPrompt, transcript, { temperature: 0.7, maxTokens: 800 });
  };
}

function defaultSynthesizeSpeech(language: string): SynthesizeSpeech {
  return async (text, signal) => {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    const base64 = await sarvamTTS(text, language);
    const buf = Buffer.from(base64, "base64");
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  };
}

/** Which `InterviewInterruptedStage` a barge-in during `state` corresponds to, if any. */
function interruptedStageFor(state: TurnState): InterviewInterruptedStage | undefined {
  if (state === "AGENT_THINKING") return "AGENT_GENERATION";
  if (state === "AGENT_SPEAKING") return "TTS_PLAYBACK";
  return undefined;
}

export class VoiceSession {
  readonly turnManager: TurnManager;
  readonly events: InterviewEventBus;

  private readonly sttProvider: STTProvider;
  private readonly ownsEventBus: boolean;
  private readonly generateReply: GenerateReply;
  private readonly synthesizeSpeech: SynthesizeSpeech;

  private readonly audioCallbacks: AudioCallback[] = [];

  private started = false;
  private ended = false;
  private finalReceivedForCurrentUtterance = false;
  private activeAbortController: AbortController | null = null;

  constructor(opts: VoiceSessionOptions) {
    this.sttProvider = opts.sttProvider;
    this.turnManager = opts.turnManager ?? new TurnManager();
    this.ownsEventBus = !opts.eventBus;
    this.events = opts.eventBus ?? createInterviewEventBus();
    this.generateReply = opts.generateReply ?? defaultGenerateReply(opts.systemPrompt ?? SCENARIO_SYSTEM);
    this.synthesizeSpeech = opts.synthesizeSpeech ?? defaultSynthesizeSpeech(opts.language ?? "en-IN");
  }

  // -- Session lifecycle --------------------------------------------------------------------------

  /** Connect the STT provider and start listening for the learner's first turn. Call once per
   *  conversation — construct a new `VoiceSession` for a new one. */
  async start(): Promise<void> {
    if (this.started) throw new Error("VoiceSession.start() called more than once.");
    this.started = true;

    this.sttProvider.onPartial((text) => this.handlePartialTranscript(text));
    this.sttProvider.onFinal((text) => this.handleFinalTranscript(text));

    await this.sttProvider.connect();
    this.turnManager.startListening("session_started");
  }

  /** Cancel any in-flight generation, disconnect the STT provider, and reset to `IDLE`. Safe to
   *  call once the session is already ended (subsequent calls are no-ops). */
  async end(): Promise<void> {
    if (this.ended) return;
    this.ended = true;

    this.activeAbortController?.abort();
    this.activeAbortController = null;

    try {
      await this.sttProvider.disconnect();
    } catch (e) {
      this.publishError("TRANSCRIPTION", `error disconnecting STT provider during end(): ${(e as Error).message}`);
    }

    this.turnManager.reset("session_ended");
    this.turnManager.dispose();
    if (this.ownsEventBus) this.events.dispose();
  }

  // -- STT connection / audio streaming -------------------------------------------------------------

  /** The learner started talking (or resumed after a pause). Valid from `LISTENING`, `USER_PAUSED`,
   *  or `INTERRUPTED` (a barge-in); a no-op from anywhere else. */
  notifySpeechStarted(): boolean {
    const ok = this.turnManager.tryTransition("USER_SPEAKING", "speech_started");
    if (ok) this.events.publish({ type: "SPEECH_STARTED", timestamp: Date.now() });
    return ok;
  }

  /** The learner is mid-answer but has paused (not yet a finalized end of turn). Valid only from
   *  `USER_SPEAKING`. */
  notifySpeechPaused(): boolean {
    return this.turnManager.tryTransition("USER_PAUSED", "speech_paused");
  }

  /** Forward one chunk of captured audio to the STT provider. Requires `USER_SPEAKING` or
   *  `USER_PAUSED` — call `notifySpeechStarted()` first. Throws on misuse rather than silently
   *  dropping audio, matching `STTProvider.sendAudio()`'s own documented contract. */
  pushAudio(chunk: ArrayBuffer): void {
    const state = this.turnManager.state;
    if (state !== "USER_SPEAKING" && state !== "USER_PAUSED") {
      throw new Error(`VoiceSession.pushAudio() is invalid from state ${state} — call notifySpeechStarted() first.`);
    }
    this.sttProvider.sendAudio(chunk);
  }

  /**
   * The learner's turn is over — finalize the current utterance. Required for a provider with no
   * native segmentation of its own (see the module docstring); optional (a "force it now") for one
   * that already segments utterances server-side. Requires `USER_SPEAKING` or `USER_PAUSED`.
   */
  async submitUtterance(): Promise<void> {
    const state = this.turnManager.state;
    if (state !== "USER_SPEAKING" && state !== "USER_PAUSED") {
      throw new Error(`VoiceSession.submitUtterance() is invalid from state ${state}.`);
    }

    // Reach PROCESSING ourselves so the "no speech captured" fallback below (-> LISTENING) is
    // always a legal edge, even if the provider never calls onFinal at all this cycle.
    // handleFinalTranscript() also makes this same call for the case where the provider finalizes
    // before we get here (e.g. synchronously inside disconnect(), below) — a harmless no-op
    // self-transition the second time either way runs.
    this.turnManager.tryTransition("PROCESSING", "utterance_submitted");
    this.events.publish({ type: "SPEECH_ENDED", timestamp: Date.now() });
    this.finalReceivedForCurrentUtterance = false;

    try {
      await this.sttProvider.disconnect();
    } catch (e) {
      this.publishError("TRANSCRIPTION", (e as Error).message);
    }

    if (!this.finalReceivedForCurrentUtterance) {
      // No speech was actually captured (or the provider produced nothing, per its own documented
      // contract for an empty session) — nothing to hand to the agent. Don't get stuck waiting for
      // a transcript that's never coming; go back to listening for the next attempt.
      this.turnManager.tryTransition("LISTENING", "empty_utterance");
    }

    try {
      await this.sttProvider.connect(); // prep a fresh session/buffer for the next utterance
    } catch (e) {
      this.publishError("TRANSCRIPTION", `failed to reconnect STT provider: ${(e as Error).message}`);
    }
  }

  // -- Cancellation ---------------------------------------------------------------------------------

  /**
   * The learner interrupted the agent while it was thinking or speaking. Aborts whichever call is
   * in flight, transitions to `INTERRUPTED`, and publishes `AGENT_INTERRUPTED`. Returns `false`
   * (and does nothing) if the agent wasn't actually thinking or speaking — e.g. it's already
   * finished, or the learner is still mid-answer themselves.
   */
  interrupt(): boolean {
    const stage = interruptedStageFor(this.turnManager.state);
    const ok = this.turnManager.tryTransition("INTERRUPTED", "barge_in");
    if (!ok) return false;

    this.activeAbortController?.abort();
    this.activeAbortController = null;
    this.events.publish({ type: "AGENT_INTERRUPTED", interruptedStage: stage, timestamp: Date.now() });
    return true;
  }

  // -- Reply audio -----------------------------------------------------------------------------------

  /** Register a callback for the agent's synthesized reply audio, delivered once per completed
   *  turn alongside the reply text. This class never plays audio itself — see the module docstring. */
  onAudio(callback: AudioCallback): void {
    this.audioCallbacks.push(callback);
  }

  // -- Internals --------------------------------------------------------------------------------------

  private handlePartialTranscript(text: string): void {
    this.events.publish({ type: "PARTIAL_TRANSCRIPT", text, timestamp: Date.now() });
  }

  private handleFinalTranscript(text: string): void {
    this.finalReceivedForCurrentUtterance = true;
    // Reach PROCESSING regardless of whether submitUtterance() already got us there (the provider
    // has no native segmentation) or the provider is finalizing on its own via server-side VAD
    // (already in USER_SPEAKING/USER_PAUSED) — tryTransition() is a safe no-op if we're already
    // there (a self-transition is always rejected without changing state).
    this.turnManager.tryTransition("PROCESSING", "stt_final_transcript");

    this.events.publish({ type: "FINAL_TRANSCRIPT", text, timestamp: Date.now() });
    this.events.publish({ type: "TURN_COMPLETED", timestamp: Date.now() });
    void this.runAgentTurn(text);
  }

  /** Runs the LLM -> TTS leg of one turn. Never throws — every failure is reported as an `ERROR`
   *  event and returns the session to `LISTENING` instead. */
  private async runAgentTurn(transcript: string): Promise<void> {
    if (!this.turnManager.tryTransition("AGENT_THINKING", "agent_turn_started")) {
      log.warn("runAgentTurn: cannot start from current state", { state: this.turnManager.state });
      return;
    }
    this.events.publish({ type: "AGENT_GENERATION_STARTED", timestamp: Date.now() });

    const generationController = new AbortController();
    this.activeAbortController = generationController;
    let replyText: string;
    try {
      replyText = await this.generateReply(transcript, generationController.signal);
    } catch (e) {
      if (generationController.signal.aborted || isAbortError(e)) return; // interrupt() already handled state + events
      this.publishError("AGENT_GENERATION", (e as Error).message);
      this.turnManager.tryTransition("LISTENING", "agent_generation_failed");
      return;
    } finally {
      if (this.activeAbortController === generationController) this.activeAbortController = null;
    }
    // A `generateReply` implementation that doesn't itself honor `signal` may resolve normally
    // even after interrupt() aborted it — never act on that result once aborted, since interrupt()
    // has already moved the turn on (published AGENT_INTERRUPTED, transitioned to INTERRUPTED).
    if (generationController.signal.aborted) return;
    this.events.publish({ type: "AGENT_GENERATION_COMPLETED", text: replyText, timestamp: Date.now() });

    if (!this.turnManager.tryTransition("AGENT_SPEAKING", "tts_started")) {
      log.warn("runAgentTurn: cannot start TTS from current state", { state: this.turnManager.state });
      return; // e.g. interrupted between the two legs
    }
    this.events.publish({ type: "TTS_PLAYBACK_STARTED", timestamp: Date.now() });

    const ttsController = new AbortController();
    this.activeAbortController = ttsController;
    let audio: ArrayBuffer;
    try {
      audio = await this.synthesizeSpeech(replyText, ttsController.signal);
    } catch (e) {
      if (ttsController.signal.aborted || isAbortError(e)) return;
      this.publishError("TTS_PLAYBACK", (e as Error).message);
      this.turnManager.tryTransition("LISTENING", "tts_failed");
      return;
    } finally {
      if (this.activeAbortController === ttsController) this.activeAbortController = null;
    }
    // Same non-cooperative-abort guard as the generation leg above.
    if (ttsController.signal.aborted) return;
    this.events.publish({ type: "TTS_PLAYBACK_COMPLETED", timestamp: Date.now() });

    for (const callback of this.audioCallbacks) callback(audio, replyText);
    this.turnManager.tryTransition("LISTENING", "turn_complete");
  }

  private publishError(stage: InterviewErrorStage, message: string, code?: string): void {
    log.warn("voice session error", { stage, message, code });
    this.events.publish({ type: "ERROR", stage, message, code, timestamp: Date.now() });
  }
}
