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
