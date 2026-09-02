import { describe, it, expect } from "vitest";
import { UtteranceGate } from "./UtteranceGate";

const LOUD = 0.5; // well above threshold
const QUIET = 0.0;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Tiny pad/timeout values so tests run fast while still exercising real wall-clock debouncing
// (UtteranceDetector uses performance.now() internally, same as everywhere else in this repo that
// tests timing-sensitive logic against real, small delays rather than mocking the clock).
//
// Per UtteranceDetector's actual semantics (see ../vad.ts): `isSpeaking` flips true on the very
// first loud frame (no onset debounce — favors low latency for the barge-in/turn-start signal);
// `speechPadMs` is instead a *minimum speaking duration* before silence is allowed to end it, and
// `silenceTimeoutMs` is the silence gap required both to declare `isFinal` and to let a new
// utterance start being recognized as fresh speech.
const FAST_CONFIG = { threshold: 0.1, speechPadMs: 15, silenceTimeoutMs: 15 };

describe("UtteranceGate", () => {
  it("emits speech_started on the very first loud frame, and never repeats it while still speaking", () => {
    const gate = new UtteranceGate(FAST_CONFIG);
    expect(gate.pushRms(LOUD)).toEqual(["speech_started"]);
    expect(gate.pushRms(LOUD)).toEqual([]);
    expect(gate.pushRms(LOUD)).toEqual([]);
  });

  it("never emits utterance_final while speech is still within its minimum duration, even if energy already dropped", async () => {
    const gate = new UtteranceGate(FAST_CONFIG);
    expect(gate.pushRms(LOUD)).toEqual(["speech_started"]);
    // Goes quiet immediately — but speechPadMs (15ms) hasn't elapsed since speech started yet, so
    // the detector isn't done considering this "speaking" and can't declare a final.
    expect(gate.pushRms(QUIET)).toEqual([]);
  });

  it("emits utterance_final only once, after the minimum speech duration and then a full silence timeout have both elapsed", async () => {
    const gate = new UtteranceGate(FAST_CONFIG);
    expect(gate.pushRms(LOUD)).toEqual(["speech_started"]);

    await wait(20); // clears speechPadMs — isSpeaking is now allowed to end
    expect(gate.pushRms(QUIET)).toEqual([]); // isSpeaking ends here, but isFinal doesn't yet

    await wait(20); // clears silenceTimeoutMs since silence started
    expect(gate.pushRms(QUIET)).toEqual(["utterance_final"]);

    expect(gate.pushRms(QUIET)).toEqual([]); // edge-triggered — no repeat while still silent
  });

  it("recognizes a fresh utterance (speech_started again) immediately once utterance_final has fired, with no explicit reset() needed", async () => {
    const gate = new UtteranceGate(FAST_CONFIG);
    gate.pushRms(LOUD);
    await wait(20);
    gate.pushRms(QUIET);
    await wait(20);
    expect(gate.pushRms(QUIET)).toEqual(["utterance_final"]);

    // By the time utterance_final fires, silenceTimeoutMs has already elapsed, so the very next
    // loud frame is immediately recognized as a new utterance's start.
    expect(gate.pushRms(LOUD)).toEqual(["speech_started"]);
  });

  it("reset() returns the gate to a cold-start state — the next loud frame signals speech_started again immediately", async () => {
    const gate = new UtteranceGate(FAST_CONFIG);
    gate.pushRms(LOUD);
    await wait(20);
    gate.pushRms(LOUD); // still mid-utterance, no new signal

    gate.reset();

    expect(gate.pushRms(LOUD)).toEqual(["speech_started"]);
    expect(gate.pushRms(LOUD)).toEqual([]);
  });
});
