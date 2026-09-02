import { describe, it, expect } from "vitest";
import {
  TurnManager,
  TURN_STATES,
  TURN_TRANSITIONS,
  InvalidTurnTransitionError,
  type TurnState,
  type TurnManagerEvent,
} from "./TurnManager";

describe("TURN_TRANSITIONS", () => {
  it("only references the eight declared TurnStates", () => {
    for (const from of TURN_STATES) {
      expect(TURN_TRANSITIONS[from]).toBeDefined();
      for (const to of TURN_TRANSITIONS[from]) {
        expect(TURN_STATES).toContain(to);
      }
    }
  });

  it("never lists a state as its own successor", () => {
    for (const from of TURN_STATES) {
      expect(TURN_TRANSITIONS[from]).not.toContain(from);
    }
  });

  it("can reach IDLE from every other state (no dead ends)", () => {
    for (const from of TURN_STATES) {
      if (from === "IDLE") continue;
      expect(TURN_TRANSITIONS[from]).toContain("IDLE");
    }
  });

  it("has exactly the eight states requested, in a stable manifest", () => {
    expect(new Set(TURN_STATES).size).toBe(8);
    expect(TURN_STATES).toEqual([
      "IDLE",
      "LISTENING",
      "USER_SPEAKING",
      "USER_PAUSED",
      "PROCESSING",
      "AGENT_THINKING",
      "AGENT_SPEAKING",
      "INTERRUPTED",
    ]);
  });
});

describe("TurnManager", () => {
  it("starts in IDLE by default", () => {
    expect(new TurnManager().state).toBe("IDLE");
  });

  it("accepts a custom initial state", () => {
    expect(new TurnManager("AGENT_SPEAKING").state).toBe("AGENT_SPEAKING");
  });

  it("canTransition() matches TURN_TRANSITIONS without mutating state", () => {
    const tm = new TurnManager("USER_SPEAKING");
    expect(tm.canTransition("USER_PAUSED")).toBe(true);
    expect(tm.canTransition("PROCESSING")).toBe(true);
    expect(tm.canTransition("AGENT_SPEAKING")).toBe(false); // not a direct edge from USER_SPEAKING
    expect(tm.state).toBe("USER_SPEAKING");
  });

  it("canTransition() rejects a self-transition even for a state with no listed self-edge", () => {
    const tm = new TurnManager("LISTENING");
    expect(tm.canTransition("LISTENING")).toBe(false);
  });

  it("transition() moves to a legal state and returns it", () => {
    const tm = new TurnManager("IDLE");
    expect(tm.transition("LISTENING")).toBe("LISTENING");
    expect(tm.state).toBe("LISTENING");
  });

  it("transition() throws InvalidTurnTransitionError for an illegal move and leaves state unchanged", () => {
    const tm = new TurnManager("IDLE");
    expect(() => tm.transition("AGENT_SPEAKING")).toThrow(InvalidTurnTransitionError);
    expect(tm.state).toBe("IDLE");
  });

  it("the thrown error carries the attempted from/to and a descriptive message", () => {
    const tm = new TurnManager("IDLE");
    try {
      tm.transition("PROCESSING");
      throw new Error("should not reach here");
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidTurnTransitionError);
      const err = e as InvalidTurnTransitionError;
      expect(err.from).toBe("IDLE");
      expect(err.to).toBe("PROCESSING");
      expect(err.message).toContain("IDLE");
      expect(err.message).toContain("PROCESSING");
    }
  });

  it("tryTransition() returns true/false instead of throwing, and only mutates state on success", () => {
    const tm = new TurnManager("IDLE");
    expect(tm.tryTransition("AGENT_SPEAKING")).toBe(false);
    expect(tm.state).toBe("IDLE");
    expect(tm.tryTransition("LISTENING")).toBe(true);
    expect(tm.state).toBe("LISTENING");
  });

  it("reset() is an idempotent no-op from IDLE and emits nothing", () => {
    const tm = new TurnManager("IDLE");
    const events: TurnManagerEvent[] = [];
    tm.subscribeAll((e) => events.push(e));
    expect(tm.reset()).toBe("IDLE");
    expect(events).toEqual([]);
  });

  it("reset() transitions to IDLE from any other state", () => {
    for (const from of TURN_STATES) {
      if (from === "IDLE") continue;
      const tm = new TurnManager(from);
      expect(tm.reset()).toBe("IDLE");
      expect(tm.state).toBe("IDLE");
    }
  });

  it("publishes TURN_STATE_CHANGED with from/to/reason/timestamp on a successful transition", () => {
    const tm = new TurnManager("IDLE");
    const events: TurnManagerEvent[] = [];
    tm.subscribe("TURN_STATE_CHANGED", (e) => events.push(e));
    tm.transition("LISTENING", "session_started");
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e).toMatchObject({ type: "TURN_STATE_CHANGED", from: "IDLE", to: "LISTENING", reason: "session_started" });
    expect(typeof (e as { timestamp: number }).timestamp).toBe("number");
  });

  it("publishes TURN_TRANSITION_REJECTED (and still throws) on an illegal transition", () => {
    const tm = new TurnManager("IDLE");
    const rejections: TurnManagerEvent[] = [];
    tm.subscribe("TURN_TRANSITION_REJECTED", (e) => rejections.push(e));
    expect(() => tm.transition("PROCESSING", "bad_call")).toThrow(InvalidTurnTransitionError);
    expect(rejections).toEqual([
      { type: "TURN_TRANSITION_REJECTED", from: "IDLE", attempted: "PROCESSING", reason: "bad_call", timestamp: expect.any(Number) },
    ]);
  });

  it("tryTransition() still publishes TURN_TRANSITION_REJECTED without throwing to the caller", () => {
    const tm = new TurnManager("IDLE");
    const rejections: TurnManagerEvent[] = [];
    tm.subscribe("TURN_TRANSITION_REJECTED", (e) => rejections.push(e));
    expect(tm.tryTransition("PROCESSING")).toBe(false);
    expect(rejections).toHaveLength(1);
  });

  it("subscribe() only delivers the subscribed event type", () => {
    const tm = new TurnManager("IDLE");
    const changed: TurnManagerEvent[] = [];
    tm.subscribe("TURN_STATE_CHANGED", (e) => changed.push(e));
    tm.tryTransition("PROCESSING"); // rejected -> must not appear in `changed`
    tm.transition("LISTENING"); // accepted -> must appear
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({ to: "LISTENING" });
  });

  it("unsubscribe (via the returned disposer) stops further delivery", () => {
    const tm = new TurnManager("IDLE");
    let count = 0;
    const unsubscribe = tm.subscribeAll(() => count++);
    tm.transition("LISTENING");
    unsubscribe();
    tm.transition("USER_SPEAKING");
    expect(count).toBe(1);
  });

  it("dispose() stops all event delivery but leaves state transitions working", () => {
    const tm = new TurnManager("IDLE");
    let count = 0;
    tm.subscribeAll(() => count++);
    tm.dispose();
    expect(tm.transition("LISTENING")).toBe("LISTENING");
    expect(tm.state).toBe("LISTENING");
    expect(count).toBe(0);
  });

  it("drives the documented happy-path voice turn end to end", () => {
    const tm = new TurnManager();
    const seen: Array<{ from: TurnState; to: TurnState }> = [];
    tm.subscribe("TURN_STATE_CHANGED", (e) => seen.push({ from: e.from, to: e.to }));

    tm.startListening();
    tm.userStartedSpeaking();
    tm.userPaused(); // mid-answer breath
    tm.userStartedSpeaking(); // resumes
    tm.beginProcessing();
    tm.beginAgentThinking();
    tm.beginAgentSpeaking();
    tm.startListening(); // playback finished -> next turn

    expect(seen.map((s) => s.to)).toEqual([
      "LISTENING",
      "USER_SPEAKING",
      "USER_PAUSED",
      "USER_SPEAKING",
      "PROCESSING",
      "AGENT_THINKING",
      "AGENT_SPEAKING",
      "LISTENING",
    ]);
    expect(tm.state).toBe("LISTENING");
  });

  it("supports a barge-in while the agent is thinking, returning to USER_SPEAKING", () => {
    const tm = new TurnManager("AGENT_THINKING");
    tm.interrupt("barge_in");
    expect(tm.state).toBe("INTERRUPTED");
    tm.userStartedSpeaking();
    expect(tm.state).toBe("USER_SPEAKING");
  });

  it("supports a barge-in while the agent is speaking, returning to LISTENING", () => {
    const tm = new TurnManager("AGENT_SPEAKING");
    tm.interrupt("barge_in");
    expect(tm.state).toBe("INTERRUPTED");
    tm.startListening();
    expect(tm.state).toBe("LISTENING");
  });

  it("rejects an interrupt attempt from a state where no one is talking", () => {
    const tm = new TurnManager("LISTENING");
    expect(tm.tryTransition("INTERRUPTED")).toBe(false);
    expect(tm.state).toBe("LISTENING");
  });
});

// Exhaustively checks every one of the 8x8 (from, to) pairs against TURN_TRANSITIONS, so "every
// valid state transition" and "invalid transition handling" are both covered without relying on
// hand-picked spot checks to happen to hit every edge (and every non-edge) in the graph.
describe("TurnManager - exhaustive transition matrix", () => {
  for (const from of TURN_STATES) {
    for (const to of TURN_STATES) {
      const isLegal = from !== to && TURN_TRANSITIONS[from].includes(to);

      it(`${from} -> ${to} is ${isLegal ? "accepted" : "rejected"}`, () => {
        const tm = new TurnManager(from);
        const events: TurnManagerEvent[] = [];
        tm.subscribeAll((e) => events.push(e));

        const accepted = tm.tryTransition(to);

        expect(accepted).toBe(isLegal);
        if (isLegal) {
          expect(tm.state).toBe(to);
          expect(events).toEqual([
            { type: "TURN_STATE_CHANGED", from, to, timestamp: expect.any(Number) },
          ]);
        } else {
          expect(tm.state).toBe(from); // state must never change on a rejected attempt
          expect(events).toEqual([
            { type: "TURN_TRANSITION_REJECTED", from, attempted: to, timestamp: expect.any(Number) },
          ]);
        }
      });
    }
  }

  it("transition() (the throwing form) agrees with tryTransition() on every pair", () => {
    for (const from of TURN_STATES) {
      for (const to of TURN_STATES) {
        const isLegal = from !== to && TURN_TRANSITIONS[from].includes(to);
        const tm = new TurnManager(from);
        if (isLegal) {
          expect(() => tm.transition(to)).not.toThrow();
          expect(tm.state).toBe(to);
        } else {
          expect(() => tm.transition(to)).toThrow(InvalidTurnTransitionError);
          expect(tm.state).toBe(from);
        }
      }
    }
  });
});

describe("TurnManager - named transition specs", () => {
  it("LISTENING -> USER_SPEAKING: VAD reports the learner started talking", () => {
    const tm = new TurnManager("LISTENING");
    const events: TurnManagerEvent[] = [];
    tm.subscribe("TURN_STATE_CHANGED", (e) => events.push(e));

    expect(tm.userStartedSpeaking("vad_speech_start")).toBe("USER_SPEAKING");

    expect(tm.state).toBe("USER_SPEAKING");
    expect(events).toEqual([
      {
        type: "TURN_STATE_CHANGED",
        from: "LISTENING",
        to: "USER_SPEAKING",
        reason: "vad_speech_start",
        timestamp: expect.any(Number),
      },
    ]);
  });

  it("USER_SPEAKING -> USER_PAUSED: VAD reports a mid-answer silence below the auto-stop threshold", () => {
    const tm = new TurnManager("USER_SPEAKING");
    const events: TurnManagerEvent[] = [];
    tm.subscribe("TURN_STATE_CHANGED", (e) => events.push(e));

    expect(tm.userPaused("vad_silence_below_autostop")).toBe("USER_PAUSED");

    expect(tm.state).toBe("USER_PAUSED");
    expect(events).toEqual([
      {
        type: "TURN_STATE_CHANGED",
        from: "USER_SPEAKING",
        to: "USER_PAUSED",
        reason: "vad_silence_below_autostop",
        timestamp: expect.any(Number),
      },
    ]);
  });

  it("AGENT_SPEAKING -> INTERRUPTED: the learner barges in while the agent is talking", () => {
    const tm = new TurnManager("AGENT_SPEAKING");
    const events: TurnManagerEvent[] = [];
    tm.subscribe("TURN_STATE_CHANGED", (e) => events.push(e));

    expect(tm.interrupt("barge_in")).toBe("INTERRUPTED");

    expect(tm.state).toBe("INTERRUPTED");
    expect(events).toEqual([
      {
        type: "TURN_STATE_CHANGED",
        from: "AGENT_SPEAKING",
        to: "INTERRUPTED",
        reason: "barge_in",
        timestamp: expect.any(Number),
      },
    ]);
  });
});

describe("TurnManager - interruption while the agent is speaking/thinking", () => {
  it("can be interrupted mid-reply (AGENT_THINKING) and mid-playback (AGENT_SPEAKING)", () => {
    for (const from of ["AGENT_THINKING", "AGENT_SPEAKING"] as const) {
      const tm = new TurnManager(from);
      expect(tm.tryTransition("INTERRUPTED")).toBe(true);
      expect(tm.state).toBe("INTERRUPTED");
    }
  });

  it("cannot be interrupted from any state where the agent isn't generating or speaking", () => {
    for (const from of TURN_STATES) {
      if (from === "AGENT_THINKING" || from === "AGENT_SPEAKING" || from === "INTERRUPTED") continue;
      const tm = new TurnManager(from);
      expect(tm.tryTransition("INTERRUPTED")).toBe(false);
      expect(tm.state).toBe(from);
    }
  });

  it("after being interrupted mid-playback, the mic can reopen for the learner's follow-up", () => {
    const tm = new TurnManager("AGENT_SPEAKING");
    tm.interrupt();
    expect(tm.startListening()).toBe("LISTENING");
  });

  it("after being interrupted mid-reply, the learner's speech (already underway) is reflected directly", () => {
    const tm = new TurnManager("AGENT_THINKING");
    tm.interrupt();
    expect(tm.userStartedSpeaking()).toBe("USER_SPEAKING");
  });

  it("an interruption can also be abandoned back to IDLE (session ended mid-barge-in)", () => {
    const tm = new TurnManager("AGENT_SPEAKING");
    tm.interrupt();
    expect(tm.reset()).toBe("IDLE");
  });

  it("INTERRUPTED cannot jump straight back into agent activity - the agent must restart via PROCESSING", () => {
    const tm = new TurnManager("AGENT_SPEAKING");
    tm.interrupt();
    expect(tm.tryTransition("AGENT_THINKING")).toBe(false);
    expect(tm.tryTransition("AGENT_SPEAKING")).toBe(false);
    expect(tm.tryTransition("PROCESSING")).toBe(false);
    expect(tm.state).toBe("INTERRUPTED");
  });
});

describe("TurnManager - user pause behavior", () => {
  it("supports repeated pause/resume cycles within a single answer", () => {
    const tm = new TurnManager("USER_SPEAKING");
    for (let i = 0; i < 3; i++) {
      expect(tm.userPaused()).toBe("USER_PAUSED");
      expect(tm.userStartedSpeaking()).toBe("USER_SPEAKING");
    }
    expect(tm.state).toBe("USER_SPEAKING");
  });

  it("a pause can be finalized as the end of the turn (-> PROCESSING) instead of resuming", () => {
    const tm = new TurnManager("USER_SPEAKING");
    tm.userPaused("vad_silence_below_autostop");
    expect(tm.beginProcessing("autostop_silence_elapsed")).toBe("PROCESSING");
    expect(tm.state).toBe("PROCESSING");
  });

  it("a pause can be abandoned back to IDLE without ever finishing the turn", () => {
    const tm = new TurnManager("USER_SPEAKING");
    tm.userPaused();
    expect(tm.reset()).toBe("IDLE");
  });

  it("a paused turn cannot skip straight into agent activity, bypassing STT", () => {
    const tm = new TurnManager("USER_PAUSED");
    expect(tm.tryTransition("AGENT_THINKING")).toBe(false);
    expect(tm.tryTransition("AGENT_SPEAKING")).toBe(false);
    expect(tm.state).toBe("USER_PAUSED");
  });

  it("pausing is only legal while the learner is actually speaking", () => {
    for (const from of TURN_STATES) {
      if (from === "USER_SPEAKING") continue;
      const tm = new TurnManager(from);
      expect(tm.tryTransition("USER_PAUSED")).toBe(false);
    }
  });
});

describe("TurnManager - cleanup and reset behavior", () => {
  it("reset() clears back to IDLE from every reachable state and emits exactly one event each time", () => {
    for (const from of TURN_STATES) {
      if (from === "IDLE") continue;
      const tm = new TurnManager(from);
      const events: TurnManagerEvent[] = [];
      tm.subscribeAll((e) => events.push(e));
      expect(tm.reset("cleanup")).toBe("IDLE");
      expect(tm.state).toBe("IDLE");
      expect(events).toEqual([
        { type: "TURN_STATE_CHANGED", from, to: "IDLE", reason: "cleanup", timestamp: expect.any(Number) },
      ]);
    }
  });

  it("reset() is idempotent: calling it again from IDLE never emits a second event", () => {
    const tm = new TurnManager("AGENT_SPEAKING");
    let count = 0;
    tm.subscribeAll(() => count++);
    tm.reset();
    expect(count).toBe(1);
    tm.reset();
    tm.reset();
    expect(count).toBe(1);
  });

  it("dispose() can be called more than once without throwing", () => {
    const tm = new TurnManager();
    expect(() => {
      tm.dispose();
      tm.dispose();
    }).not.toThrow();
  });

  it("dispose() only silences event delivery - transition()/tryTransition()/reset() keep working", () => {
    const tm = new TurnManager("IDLE");
    tm.dispose();
    tm.transition("LISTENING");
    tm.userStartedSpeaking();
    expect(tm.tryTransition("PROCESSING")).toBe(true);
    expect(tm.reset()).toBe("IDLE");
  });

  it("subscribing after dispose() returns a disposer that never fires and is itself safe to call", () => {
    const tm = new TurnManager("IDLE");
    tm.dispose();
    let count = 0;
    const unsubscribe = tm.subscribeAll(() => count++);
    tm.transition("LISTENING");
    expect(count).toBe(0);
    expect(() => unsubscribe()).not.toThrow();
  });

  it("unsubscribing one listener leaves other independent listeners receiving events (no over-broad cleanup)", () => {
    const tm = new TurnManager("IDLE");
    let a = 0;
    let b = 0;
    const unsubscribeA = tm.subscribeAll(() => a++);
    tm.subscribeAll(() => b++);

    tm.transition("LISTENING");
    unsubscribeA();
    tm.transition("USER_SPEAKING");

    expect(a).toBe(1);
    expect(b).toBe(2);
  });

  it("a fresh TurnManager after cleanup starts clean: no leftover listeners fire on it", () => {
    const first = new TurnManager("IDLE");
    let calls = 0;
    first.subscribeAll(() => calls++);
    first.dispose();

    const second = new TurnManager("IDLE");
    second.transition("LISTENING");
    expect(calls).toBe(0); // the disposed instance's listeners must never leak onto a new instance
  });
});
