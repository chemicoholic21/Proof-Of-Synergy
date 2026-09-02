import { describe, it, expect } from "vitest";
import { ResponsePlanner, clampWords, DEFAULT_MAX_WORDS_BY_ACTION } from "./ResponsePlanner";
import { INTERVIEW_ACTIONS, type InterviewTurnResponse } from "./ConversationEngine";

function response(overrides: Partial<InterviewTurnResponse> = {}): InterviewTurnResponse {
  return {
    action: "FOLLOW_UP",
    speech: "Can you explain that further?",
    topic: "distributed systems",
    evaluation_required: true,
    ...overrides,
  };
}

function words(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

describe("clampWords", () => {
  it("returns text unchanged when it's already within the word budget", () => {
    expect(clampWords("short and sweet", 10)).toBe("short and sweet");
  });

  it("trims to the word budget without cutting mid-word, appending an ellipsis when no sentence boundary is found", () => {
    const text = "one two three four five six seven eight nine ten";
    const result = clampWords(text, 5);
    expect(result).toBe("one two three four five…");
    expect(words(result.replace("…", ""))).toHaveLength(5);
  });

  it("prefers ending at the last sentence boundary within the kept window over a mid-budget ellipsis cut", () => {
    const text = "Tell me more. What happens under load? Extra words that would be cut off here regardless.";
    const result = clampWords(text, 8);
    expect(result).toBe("Tell me more. What happens under load?");
    expect(result.endsWith("…")).toBe(false);
  });

  it("never produces more words than the budget", () => {
    const text = "a b c d e f g h i j k l m n o p";
    expect(words(clampWords(text, 4).replace("…", ""))).toHaveLength(4);
  });
});

describe("ResponsePlanner.plan()", () => {
  it("is deterministic — the same input always produces the same output", () => {
    const planner = new ResponsePlanner();
    const input = response();
    expect(planner.plan(input)).toEqual(planner.plan(input));
  });

  it("carries action/topic through unchanged", () => {
    const planner = new ResponsePlanner();
    const plan = planner.plan(response({ action: "CLARIFY", topic: "caching strategy" }));
    expect(plan.action).toBe("CLARIFY");
    expect(plan.topic).toBe("caching strategy");
  });

  it("shouldSpeak is true and ttsText equals the (short) speech when there's something to say", () => {
    const planner = new ResponsePlanner();
    const plan = planner.plan(response({ speech: "Can you explain that further?" }));
    expect(plan.shouldSpeak).toBe(true);
    expect(plan.ttsText).toBe("Can you explain that further?");
  });

  it("shouldSpeak is false and ttsText is empty when speech is blank or whitespace-only", () => {
    const planner = new ResponsePlanner();
    for (const speech of ["", "   ", "\n\t"]) {
      const plan = planner.plan(response({ speech, action: "NEXT_QUESTION" }));
      expect(plan.shouldSpeak).toBe(false);
      expect(plan.ttsText).toBe("");
      expect(plan.expectsUserAnswer).toBe(false); // nothing was said, so nothing can expect an answer
    }
  });

  it("clamps ttsText to the per-action word budget", () => {
    const planner = new ResponsePlanner();
    const longSpeech = Array.from({ length: 100 }, (_, i) => `word${i}`).join(" ");
    const plan = planner.plan(response({ action: "ACKNOWLEDGE", speech: longSpeech, evaluation_required: false }));
    const wordCount = words(plan.ttsText.replace("…", "")).length;
    expect(wordCount).toBeLessThanOrEqual(DEFAULT_MAX_WORDS_BY_ACTION.ACKNOWLEDGE);
  });

  it("honors a custom per-action word budget override", () => {
    const planner = new ResponsePlanner({ maxWordsByAction: { FOLLOW_UP: 3 } });
    const plan = planner.plan(response({ action: "FOLLOW_UP", speech: "one two three four five six" }));
    expect(words(plan.ttsText.replace("…", ""))).toHaveLength(3);
  });

  it.each([
    ["FOLLOW_UP", true],
    ["NEXT_QUESTION", true],
    ["CLARIFY", true],
    ["REPEAT", true],
    ["ACKNOWLEDGE", false],
    ["END_INTERVIEW", false],
  ] as const)("expectsUserAnswer for %s is %s when there is something to say", (action, expected) => {
    const planner = new ResponsePlanner();
    const plan = planner.plan(response({ action, speech: "Some non-empty thing to say." }));
    expect(plan.expectsUserAnswer).toBe(expected);
  });

  it("endsInterview is true only for END_INTERVIEW", () => {
    const planner = new ResponsePlanner();
    for (const action of INTERVIEW_ACTIONS) {
      const plan = planner.plan(response({ action }));
      expect(plan.endsInterview).toBe(action === "END_INTERVIEW");
    }
  });

  it("passes evaluation_required through for actions where it's meaningful", () => {
    const planner = new ResponsePlanner();
    for (const action of ["FOLLOW_UP", "NEXT_QUESTION", "CLARIFY", "ACKNOWLEDGE"] as const) {
      expect(planner.plan(response({ action, evaluation_required: true })).requiresEvaluation).toBe(true);
      expect(planner.plan(response({ action, evaluation_required: false })).requiresEvaluation).toBe(false);
    }
  });

  it("forces requiresEvaluation to false for REPEAT and END_INTERVIEW regardless of evaluation_required", () => {
    const planner = new ResponsePlanner();
    for (const action of ["REPEAT", "END_INTERVIEW"] as const) {
      expect(planner.plan(response({ action, evaluation_required: true })).requiresEvaluation).toBe(false);
      expect(planner.plan(response({ action, evaluation_required: false })).requiresEvaluation).toBe(false);
    }
  });
});
