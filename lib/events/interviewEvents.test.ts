import { describe, it, expect } from "vitest";
import { INTERVIEW_EVENT_TYPES, type InterviewEvent, type InterviewEventType } from "./interviewEvents";

describe("INTERVIEW_EVENT_TYPES", () => {
  it("has no duplicate entries", () => {
    expect(new Set(INTERVIEW_EVENT_TYPES).size).toBe(INTERVIEW_EVENT_TYPES.length);
  });

  it("lists every InterviewEvent variant exactly once", () => {
    // A compile-time exhaustiveness check: if a variant is ever added to InterviewEvent without a
    // matching entry here, this switch stops compiling — the runtime assertions below then confirm
    // the manifest and the union haven't drifted apart in the other direction either.
    function assertCovered(type: InterviewEventType): true {
      switch (type) {
        case "SPEECH_STARTED":
        case "SPEECH_ENDED":
        case "PARTIAL_TRANSCRIPT":
        case "FINAL_TRANSCRIPT":
        case "TURN_COMPLETED":
        case "AGENT_GENERATION_STARTED":
        case "AGENT_GENERATION_TOKEN":
        case "AGENT_GENERATION_COMPLETED":
        case "TTS_PLAYBACK_STARTED":
        case "TTS_PLAYBACK_COMPLETED":
        case "AGENT_INTERRUPTED":
        case "EVALUATION_COMPLETED":
        case "ERROR":
          return true;
      }
    }
    for (const type of INTERVIEW_EVENT_TYPES) {
      expect(assertCovered(type)).toBe(true);
    }
    expect(INTERVIEW_EVENT_TYPES.length).toBe(13);
  });
});

describe("InterviewEvent shapes", () => {
  it("accepts one literal object per variant (compile-time contract)", () => {
    const events: InterviewEvent[] = [
      { type: "SPEECH_STARTED", timestamp: 1 },
      { type: "SPEECH_ENDED", timestamp: 2 },
      { type: "PARTIAL_TRANSCRIPT", text: "hel", timestamp: 3 },
      { type: "FINAL_TRANSCRIPT", text: "hello", timestamp: 4 },
      { type: "TURN_COMPLETED", timestamp: 5 },
      { type: "AGENT_GENERATION_STARTED", timestamp: 6 },
      { type: "AGENT_GENERATION_TOKEN", token: "Hi", timestamp: 7 },
      { type: "AGENT_GENERATION_COMPLETED", text: "Hi there", timestamp: 8 },
      { type: "TTS_PLAYBACK_STARTED", timestamp: 9 },
      { type: "TTS_PLAYBACK_COMPLETED", timestamp: 10 },
      { type: "AGENT_INTERRUPTED", timestamp: 11 },
      { type: "AGENT_INTERRUPTED", interruptedStage: "TTS_PLAYBACK", timestamp: 12 },
      { type: "EVALUATION_COMPLETED", summary: "Solid answer.", timestamp: 13 },
      { type: "ERROR", stage: "TRANSCRIPTION", message: "STT timed out", timestamp: 14 },
      { type: "ERROR", stage: "AGENT_GENERATION", message: "no model configured", code: "service_unconfigured", timestamp: 15 },
    ];
    expect(events).toHaveLength(15);
    expect(events.every((e) => typeof e.timestamp === "number")).toBe(true);
  });

  it("narrows by `type` the way a discriminated union should", () => {
    const event: InterviewEvent = { type: "FINAL_TRANSCRIPT", text: "hello world", timestamp: 100 };
    if (event.type === "FINAL_TRANSCRIPT") {
      expect(event.text).toBe("hello world");
    } else {
      throw new Error("expected FINAL_TRANSCRIPT");
    }
  });
});
