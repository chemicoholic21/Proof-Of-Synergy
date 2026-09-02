import { describe, it, expect } from "vitest";
import { InferenceRouter } from "./InferenceRouter";

describe("InferenceRouter — empty/noise", () => {
  it("routes an empty transcript deterministically as EMPTY_OR_NOISE", () => {
    const router = new InferenceRouter();
    const decision = router.route({ transcript: "" });
    expect(decision.category).toBe("EMPTY_OR_NOISE");
    expect(decision.needsLLM).toBe(false);
    expect(decision.needsDeepEvaluation).toBe(false);
    expect(decision.isDeterministic).toBe(true);
    expect(decision.reducedContext).toBe(true);
    expect(decision.deterministicResponse).toMatchObject({ action: "REPEAT", evaluation_required: false });
  });

  it("treats whitespace-only input the same as empty", () => {
    const router = new InferenceRouter();
    expect(router.route({ transcript: "   \n\t " }).category).toBe("EMPTY_OR_NOISE");
  });
});

describe("InferenceRouter — acknowledgment", () => {
  it.each(["ok", "Okay.", "Yes!", "yeah", "Got it,", "Alright.", "Thank you", "sounds good"])(
    "classifies a bare acknowledgment %j deterministically",
    (transcript) => {
      const router = new InferenceRouter();
      const decision = router.route({ transcript });
      expect(decision.category).toBe("ACKNOWLEDGMENT");
      expect(decision.needsLLM).toBe(false);
      expect(decision.isDeterministic).toBe(true);
      expect(decision.deterministicResponse?.action).toBe("ACKNOWLEDGE");
    }
  );

  it("does not misclassify a substantive answer that merely starts with 'okay'", () => {
    const router = new InferenceRouter();
    const decision = router.route({
      transcript:
        "Okay, so let me explain how I built the caching layer using Redis and handled invalidation with a TTL-based strategy across our services.",
    });
    expect(decision.category).toBe("SUBSTANTIVE_ANSWER");
    expect(decision.needsDeepEvaluation).toBe(true);
  });
});

describe("InferenceRouter — don't-know", () => {
  it.each(["I don't know", "Not sure.", "No idea", "I'm not sure", "pass", "Dunno"])(
    "classifies a bare don't-know answer %j deterministically",
    (transcript) => {
      const router = new InferenceRouter();
      const decision = router.route({ transcript });
      expect(decision.category).toBe("DONT_KNOW");
      expect(decision.needsLLM).toBe(false);
      expect(decision.deterministicResponse?.action).toBe("NEXT_QUESTION");
    }
  );

  it("does not misclassify a substantive answer that merely expresses some uncertainty", () => {
    const router = new InferenceRouter();
    const decision = router.route({
      transcript:
        "I'm not sure if this is the most optimal approach, but here's what I'd do: use a write-through cache with a short TTL.",
    });
    expect(decision.category).toBe("SUBSTANTIVE_ANSWER");
    expect(decision.needsLLM).toBe(true);
    expect(decision.needsDeepEvaluation).toBe(true);
  });
});

describe("InferenceRouter — repeat requests", () => {
  it.each(["Can you repeat that?", "Sorry, what was the question?", "Could you say that again?", "Come again?"])(
    "classifies %j as a repeat request",
    (transcript) => {
      const router = new InferenceRouter();
      const decision = router.route({ transcript });
      expect(decision.category).toBe("REPEAT_REQUEST");
      expect(decision.deterministicResponse?.action).toBe("REPEAT");
    }
  );

  it("includes the last question in the canned repeat speech when given", () => {
    const router = new InferenceRouter();
    const decision = router.route({ transcript: "Can you repeat that?", lastQuestion: "How would you scale this system?" });
    expect(decision.deterministicResponse?.speech).toContain("How would you scale this system?");
  });

  it("falls back to a generic repeat speech when no last question is given", () => {
    const router = new InferenceRouter();
    const decision = router.route({ transcript: "Can you repeat that?" });
    expect(decision.deterministicResponse?.speech).toBe("Sure — let me say that again.");
  });

  it("does not misclassify a long substantive answer that happens to contain a repeat-like phrase", () => {
    const router = new InferenceRouter();
    const decision = router.route({
      transcript:
        "In this design I use a retry loop that keeps trying the operation, so if the request fails we say that again to the downstream service until it succeeds, handling backoff carefully across many microservices with jitter to ensure eventual consistency across the whole distributed system.",
    });
    expect(decision.category).toBe("SUBSTANTIVE_ANSWER");
  });
});

describe("InferenceRouter — end and skip requests", () => {
  it.each(["I'd like to end the interview now.", "Let's wrap it up.", "I'm done, thanks."])(
    "classifies %j as an end request",
    (transcript) => {
      const router = new InferenceRouter();
      const decision = router.route({ transcript });
      expect(decision.category).toBe("END_REQUEST");
      expect(decision.deterministicResponse?.action).toBe("END_INTERVIEW");
    }
  );

  it.each(["Can we move on to the next question?", "Let's skip this one.", "Next question please."])(
    "classifies %j as a skip request",
    (transcript) => {
      const router = new InferenceRouter();
      const decision = router.route({ transcript });
      expect(decision.category).toBe("SKIP_REQUEST");
      expect(decision.deterministicResponse?.action).toBe("NEXT_QUESTION");
    }
  );
});

describe("InferenceRouter — short vs. substantive answers", () => {
  it("routes a short but content-bearing answer through the LLM without deep evaluation or full context", () => {
    const router = new InferenceRouter();
    const decision = router.route({ transcript: "I used Redis for caching." });
    expect(decision.category).toBe("SHORT_ANSWER");
    expect(decision.needsLLM).toBe(true);
    expect(decision.needsDeepEvaluation).toBe(false);
    expect(decision.isDeterministic).toBe(false);
    expect(decision.reducedContext).toBe(true);
    expect(decision.contextBudget).toEqual({ maxRecentMessages: 2, maxRecentChars: 400 });
    expect(decision.deterministicResponse).toBeUndefined();
  });

  it("routes a substantive answer through the full pipeline", () => {
    const router = new InferenceRouter();
    const decision = router.route({
      transcript:
        "I built a distributed caching layer using Redis, with a write-through strategy and a short TTL to bound staleness across our microservices.",
    });
    expect(decision.category).toBe("SUBSTANTIVE_ANSWER");
    expect(decision.needsLLM).toBe(true);
    expect(decision.needsDeepEvaluation).toBe(true);
    expect(decision.isDeterministic).toBe(false);
    expect(decision.reducedContext).toBe(false);
    expect(decision.contextBudget).toBeUndefined();
    expect(decision.deterministicResponse).toBeUndefined();
  });

  it("treats the word count exactly at the threshold as substantive, and one below as short", () => {
    const router = new InferenceRouter({ shortAnswerWordThreshold: 5 });
    const short = router.route({ transcript: "one two three four" }); // 4 words
    const substantive = router.route({ transcript: "one two three four five" }); // 5 words
    expect(short.category).toBe("SHORT_ANSWER");
    expect(substantive.category).toBe("SUBSTANTIVE_ANSWER");
  });
});

describe("InferenceRouter — topic propagation", () => {
  it("defaults the deterministic response's topic to 'general'", () => {
    const router = new InferenceRouter();
    expect(router.route({ transcript: "okay" }).deterministicResponse?.topic).toBe("general");
  });

  it("uses the given topic for the deterministic response", () => {
    const router = new InferenceRouter();
    expect(router.route({ transcript: "okay", topic: "caching" }).deterministicResponse?.topic).toBe("caching");
  });
});

describe("InferenceRouter — configuration", () => {
  it("honors a custom controlPhraseMaxWords gate", () => {
    const router = new InferenceRouter({ controlPhraseMaxWords: 3 });
    // "Can you repeat that please" is 5 words - exceeds a controlPhraseMaxWords of 3, so it should
    // no longer be recognized as a control phrase, falling through to short/substantive instead.
    const decision = router.route({ transcript: "Can you repeat that please" });
    expect(decision.category).not.toBe("REPEAT_REQUEST");
  });

  it("honors a custom reducedContextBudget", () => {
    const router = new InferenceRouter({ reducedContextBudget: { maxRecentMessages: 1, maxRecentChars: 100 } });
    const decision = router.route({ transcript: "okay" });
    expect(decision.contextBudget).toEqual({ maxRecentMessages: 1, maxRecentChars: 100 });
  });
});

describe("InferenceRouter — determinism", () => {
  it("returns an identical decision for the same input", () => {
    const router = new InferenceRouter();
    const input = { transcript: "I used Redis for caching.", topic: "caching" };
    expect(router.route(input)).toEqual(router.route(input));
  });
});
