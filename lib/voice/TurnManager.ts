/**
 * Deterministic finite state machine for the voice interview turn lifecycle.
 *
 * `TurnManager` owns exactly one piece of state — the current `TurnState` — and one rule: a
 * transition is legal only if it appears in `TURN_TRANSITIONS`, the fixed adjacency list below.
 * There is no inference, scoring, or LLM call anywhere in this file: callers observe real signals
 * elsewhere in the pipeline (VAD onset/offset, STT completion, LLM completion, TTS completion,
 * a barge-in) and tell this module which state that signal implies; this module's only job is to
 * say yes or no to that request and, when it says yes, to record and broadcast the change. Moving
 * the *decision* of what a signal means into an LLM (or any other nondeterministic heuristic)
 * would defeat the purpose of having an auditable state graph at all, so this module deliberately
 * has no such hook.
 *
 * The eight states model one voice turn end to end:
 *
 *   IDLE            no session in progress / freshly reset.
 *   LISTENING       mic is open, waiting for the learner to start speaking.
 *   USER_SPEAKING   VAD currently reports active speech.
 *   USER_PAUSED     mid-answer silence that hasn't yet crossed the auto-stop threshold — the
 *                   learner may resume speaking (-> USER_SPEAKING) or the pause may be finalized
 *                   as the end of the turn (-> PROCESSING). See lib/vad.ts / VoiceRecorder.tsx's
 *                   AUTO_STOP_SILENCE_MS for the real signal that would drive that decision.
 *   PROCESSING      the finished recording is being transcribed (STT).
 *   AGENT_THINKING  the transcript has been handed to the agent, which is generating a reply.
 *   AGENT_SPEAKING  the agent's reply is being read aloud (TTS playback).
 *   INTERRUPTED     the learner started talking over the agent while it was thinking or speaking.
 *
 * State changes are broadcast as typed `TurnManagerEvent`s over a private `EventBus`
 * (lib/events/EventBus.ts) — `TURN_STATE_CHANGED` for every accepted transition and
 * `TURN_TRANSITION_REJECTED` for every rejected one, so a caller can observe both without
 * wrapping every `transition()` call in a try/catch.
 *
 * This module only defines the state graph — nothing in the app drives it yet.
 */

import { EventBus, type EventBusErrorHandler, type EventHandler, type Unsubscribe } from "../events/EventBus";

/** The eight states of one voice turn (see the module docstring for what each one means). */
export type TurnState =
  | "IDLE"
  | "LISTENING"
  | "USER_SPEAKING"
  | "USER_PAUSED"
  | "PROCESSING"
  | "AGENT_THINKING"
  | "AGENT_SPEAKING"
  | "INTERRUPTED";

/** Every `TurnState`, for iteration/validation. A data manifest, not a dispatcher. */
export const TURN_STATES: readonly TurnState[] = [
  "IDLE",
  "LISTENING",
  "USER_SPEAKING",
  "USER_PAUSED",
  "PROCESSING",
  "AGENT_THINKING",
  "AGENT_SPEAKING",
  "INTERRUPTED",
];

/**
 * The authoritative state graph: `TURN_TRANSITIONS[from]` lists every `to` that is legal from
 * `from`. Every non-`IDLE` state can reach `IDLE` — a session end or hard error is always
 * representable as a transition to `IDLE`, never a dead end. Self-transitions (`to === from`) are
 * never legal, even when not listed here — see `canTransition`.
 */
export const TURN_TRANSITIONS: Readonly<Record<TurnState, readonly TurnState[]>> = {
  IDLE: ["LISTENING"],
  LISTENING: ["USER_SPEAKING", "IDLE"],
  USER_SPEAKING: ["USER_PAUSED", "PROCESSING", "IDLE"],
  USER_PAUSED: ["USER_SPEAKING", "PROCESSING", "IDLE"],
  PROCESSING: ["AGENT_THINKING", "LISTENING", "IDLE"],
  AGENT_THINKING: ["AGENT_SPEAKING", "INTERRUPTED", "LISTENING", "IDLE"],
  AGENT_SPEAKING: ["LISTENING", "INTERRUPTED", "IDLE"],
  INTERRUPTED: ["LISTENING", "USER_SPEAKING", "IDLE"],
};

/** Broadcast on every transition `transition()`/a convenience method actually makes. */
export interface TurnStateChangedEvent {
  type: "TURN_STATE_CHANGED";
  from: TurnState;
  to: TurnState;
  /** Optional caller-supplied label for what triggered this transition (e.g. "vad_speech_end",
   *  "manual_stop", "tts_complete") — purely descriptive, never interpreted by this module. */
  reason?: string;
  timestamp: number;
}

/** Broadcast whenever a requested transition is illegal and is refused. */
export interface TurnTransitionRejectedEvent {
  type: "TURN_TRANSITION_REJECTED";
  from: TurnState;
  attempted: TurnState;
  reason?: string;
  timestamp: number;
}

export type TurnManagerEvent = TurnStateChangedEvent | TurnTransitionRejectedEvent;

/** Thrown by `transition()` (never by `tryTransition()`) when the requested transition is illegal. */
export class InvalidTurnTransitionError extends Error {
  readonly from: TurnState;
  readonly to: TurnState;

  constructor(from: TurnState, to: TurnState) {
    const allowed = TURN_TRANSITIONS[from];
    super(
      allowed.length > 0
        ? `Invalid turn transition: ${from} -> ${to}. Allowed from ${from}: ${allowed.join(", ")}.`
        : `Invalid turn transition: ${from} -> ${to}. ${from} has no outgoing transitions.`
    );
    this.name = "InvalidTurnTransitionError";
    this.from = from;
    this.to = to;
  }
}

/**
 * Deterministic finite state machine for one voice interview session's turn lifecycle.
 *
 * Not thread-safe in the sense of concurrent async transitions racing — like the rest of this
 * codebase's client-side state, it assumes single-threaded JS mutation, one `transition()` call
 * completing (synchronously) before the next begins.
 */
export class TurnManager {
  private currentState: TurnState;
  private readonly bus: EventBus<TurnManagerEvent>;

  constructor(initialState: TurnState = "IDLE", opts: { onError?: EventBusErrorHandler<TurnManagerEvent> } = {}) {
    this.currentState = initialState;
    this.bus = new EventBus<TurnManagerEvent>(opts);
  }

  /** The current state. */
  get state(): TurnState {
    return this.currentState;
  }

  /** True if `to` is a legal transition from the current state. Never throws, never mutates state. */
  canTransition(to: TurnState): boolean {
    if (to === this.currentState) return false; // a "transition" to the same state is not a change
    return TURN_TRANSITIONS[this.currentState].includes(to);
  }

  /**
   * Attempt to move to `to`. On success, updates `state` and publishes `TURN_STATE_CHANGED`,
   * then returns the new state. On failure, publishes `TURN_TRANSITION_REJECTED` (so subscribers
   * see the rejection even if the caller catches the throw below) and throws
   * `InvalidTurnTransitionError` without changing `state`.
   */
  transition(to: TurnState, reason?: string): TurnState {
    if (!this.canTransition(to)) {
      this.bus.publish({
        type: "TURN_TRANSITION_REJECTED",
        from: this.currentState,
        attempted: to,
        reason,
        timestamp: Date.now(),
      });
      throw new InvalidTurnTransitionError(this.currentState, to);
    }
    const from = this.currentState;
    this.currentState = to;
    this.bus.publish({ type: "TURN_STATE_CHANGED", from, to, reason, timestamp: Date.now() });
    return to;
  }

  /** Same as `transition()`, but returns `false` instead of throwing when `to` is illegal. */
  tryTransition(to: TurnState, reason?: string): boolean {
    try {
      this.transition(to, reason);
      return true;
    } catch (e) {
      if (e instanceof InvalidTurnTransitionError) return false;
      throw e;
    }
  }

  // -- Named conveniences -----------------------------------------------------------------------
  // Thin, purely mechanical wrappers around transition() — each just names the TurnState it asks
  // for. They exist for readability at call sites, not to add any decision logic of their own.

  /** Mic open, waiting for speech. */
  startListening(reason?: string): TurnState {
    return this.transition("LISTENING", reason);
  }

  /** VAD reports the learner has started speaking. */
  userStartedSpeaking(reason?: string): TurnState {
    return this.transition("USER_SPEAKING", reason);
  }

  /** VAD reports a mid-answer silence that hasn't been finalized as the end of the turn yet. */
  userPaused(reason?: string): TurnState {
    return this.transition("USER_PAUSED", reason);
  }

  /** The recording is finalized; hand it off to STT. */
  beginProcessing(reason?: string): TurnState {
    return this.transition("PROCESSING", reason);
  }

  /** The transcript is ready; the agent is generating a reply. */
  beginAgentThinking(reason?: string): TurnState {
    return this.transition("AGENT_THINKING", reason);
  }

  /** The agent's reply is ready and is being read aloud. */
  beginAgentSpeaking(reason?: string): TurnState {
    return this.transition("AGENT_SPEAKING", reason);
  }

  /** The learner started talking over the agent while it was thinking or speaking. */
  interrupt(reason?: string): TurnState {
    return this.transition("INTERRUPTED", reason);
  }

  /** Return to `IDLE`. Idempotent: a no-op (no event, no throw) if already `IDLE`, since ending an
   *  already-ended session isn't a state change worth reporting. */
  reset(reason?: string): TurnState {
    if (this.currentState === "IDLE") return "IDLE";
    return this.transition("IDLE", reason);
  }

  // -- Event subscription -------------------------------------------------------------------------
  // Thin delegation to the private bus so callers get typed pub/sub without reaching into (or being
  // able to publish onto) this instance's internals.

  /** Subscribe to one `TurnManagerEvent` type. Returns an `Unsubscribe` disposer. */
  subscribe<TType extends TurnManagerEvent["type"]>(
    type: TType,
    handler: EventHandler<Extract<TurnManagerEvent, { type: TType }>>
  ): Unsubscribe {
    return this.bus.subscribe(type, handler);
  }

  /** Subscribe to every `TurnManagerEvent` regardless of type. Returns an `Unsubscribe` disposer. */
  subscribeAll(handler: EventHandler<TurnManagerEvent>): Unsubscribe {
    return this.bus.subscribeAll(handler);
  }

  /** Remove every subscription and make this manager's event stream permanently inert. State
   *  (`state`, `transition()`, etc.) keeps working — only event delivery stops. */
  dispose(): void {
    this.bus.dispose();
  }
}
