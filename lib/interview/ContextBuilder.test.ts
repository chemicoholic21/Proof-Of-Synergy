import { describe, it, expect } from "vitest";
import { ContextBuilder, topicsRelated, selectRecentTurns, selectResumeFacts, type ResumeFact } from "./ContextBuilder";
import { MemoryEngine } from "./MemoryEngine";
import type { LLMMessage } from "../providers/llm/types";

function msg(role: LLMMessage["role"], content: string): LLMMessage {
  return { role, content };
}

describe("topicsRelated", () => {
  it("matches identical topics regardless of case/whitespace", () => {
    expect(topicsRelated("Caching", "  caching  ")).toBe(true);
  });

  it("matches when one topic is a substring of the other", () => {
    expect(topicsRelated("caching", "caching strategy")).toBe(true);
    expect(topicsRelated("Redis caching layer", "caching")).toBe(true);
  });

  it("returns false for unrelated topics", () => {
    expect(topicsRelated("caching", "networking")).toBe(false);
  });

  it("returns false when either topic is empty", () => {
    expect(topicsRelated("", "caching")).toBe(false);
    expect(topicsRelated("caching", "   ")).toBe(false);
  });
});

describe("selectRecentTurns", () => {
  it("keeps everything when under both the message-count and character budgets", () => {
    const turns = [msg("user", "hi"), msg("assistant", "hello")];
    const { kept, omittedCount } = selectRecentTurns(turns, 8, 2000);
    expect(kept).toEqual(turns);
    expect(omittedCount).toBe(0);
  });

  it("keeps only the most recent maxMessages, reporting the rest as omitted", () => {
    const turns = Array.from({ length: 10 }, (_, i) => msg(i % 2 === 0 ? "user" : "assistant", `turn ${i}`));
    const { kept, omittedCount } = selectRecentTurns(turns, 4, 10_000);
    expect(kept.map((m) => m.content)).toEqual(["turn 6", "turn 7", "turn 8", "turn 9"]);
    expect(omittedCount).toBe(6);
  });

  it("filters out system messages entirely, independent of the message-count budget", () => {
    const turns = [msg("system", "you are an interviewer"), msg("user", "hi"), msg("assistant", "hello")];
    const { kept } = selectRecentTurns(turns, 8, 10_000);
    expect(kept.every((m) => m.role !== "system")).toBe(true);
    expect(kept).toHaveLength(2);
  });

  it("trims from the oldest kept message forward once the character budget is exceeded", () => {
    const turns = [msg("user", "a".repeat(50)), msg("assistant", "b".repeat(50)), msg("user", "c".repeat(50))];
    const { kept, omittedCount } = selectRecentTurns(turns, 8, 80);
    // Each message is 50 chars; 80 chars only fits one of them, so only the most recent survives.
    expect(kept.map((m) => m.content[0])).toEqual(["c"]);
    expect(omittedCount).toBe(2);
  });

  it("keeps two messages when the character budget fits both but not a third", () => {
    const turns = [msg("user", "a".repeat(50)), msg("assistant", "b".repeat(50)), msg("user", "c".repeat(50))];
    const { kept, omittedCount } = selectRecentTurns(turns, 8, 120);
    expect(kept.map((m) => m.content[0])).toEqual(["b", "c"]);
    expect(omittedCount).toBe(1);
  });

  it("always keeps at least the single most recent message, even if it alone exceeds the character budget", () => {
    const turns = [msg("user", "short"), msg("assistant", "x".repeat(500))];
    const { kept, omittedCount } = selectRecentTurns(turns, 8, 10);
    expect(kept).toHaveLength(1);
    expect(kept[0].content).toBe("x".repeat(500));
    expect(omittedCount).toBe(1);
  });

  it("returns an empty result for an empty turn history", () => {
    expect(selectRecentTurns([], 8, 2000)).toEqual({ kept: [], omittedCount: 0 });
  });

  it("does not mutate the input array", () => {
    const turns = [msg("user", "a"), msg("assistant", "b"), msg("user", "c")];
    const copy = [...turns];
    selectRecentTurns(turns, 1, 10);
    expect(turns).toEqual(copy);
  });
});

describe("selectResumeFacts", () => {
  const facts: ResumeFact[] = [
    { topic: "caching", content: "Built a Redis caching layer." },
    { topic: "caching performance", content: "Reduced p99 latency by 40% via caching." },
    { topic: "networking", content: "Configured a VPC peering setup." },
  ];

  it("excludes every fact when no topic is given, reporting all as omitted", () => {
    expect(selectResumeFacts(facts, undefined, 10)).toEqual({ kept: [], omittedCount: facts.length });
  });

  it("keeps only facts related to the given topic", () => {
    const { kept, omittedCount } = selectResumeFacts(facts, "caching", 10);
    expect(kept.map((f) => f.content)).toEqual([facts[0].content, facts[1].content]);
    expect(omittedCount).toBe(1);
  });

  it("caps the number of matching facts included, counting the excess as omitted", () => {
    const { kept, omittedCount } = selectResumeFacts(facts, "caching", 1);
    expect(kept).toEqual([facts[0]]);
    expect(omittedCount).toBe(2); // 1 unrelated + 1 excess-related
  });

  it("returns nothing (and reports zero omitted) for an empty facts list", () => {
    expect(selectResumeFacts([], "caching", 3)).toEqual({ kept: [], omittedCount: 0 });
  });
});

describe("ContextBuilder.build()", () => {
  it("composes stable instructions, memory state, and recent turns with nothing else present", () => {
    const memory = new MemoryEngine();
    const builder = new ContextBuilder();
    const result = builder.build({
      stableInstructions: "You are interviewing a candidate for a backend role.",
      memory,
      recentTurns: [msg("user", "Tell me about yourself.")],
    });

    expect(result.systemPromptExtra).toBe(
      "You are interviewing a candidate for a backend role.\n\nInterview stage: OPENING. Current difficulty: 5/10."
    );
    expect(result.messages).toEqual([msg("user", "Tell me about yourself.")]);
    expect(result.omitted).toEqual({ olderTurns: 0, unrelatedResumeFacts: 0 });
  });

  it("omits the stable-instructions section entirely when none is given", () => {
    const builder = new ContextBuilder();
    const result = builder.build({ memory: new MemoryEngine(), recentTurns: [] });
    expect(result.systemPromptExtra).toBe("Interview stage: OPENING. Current difficulty: 5/10.");
  });

  it("includes only resume facts related to the current topic, and reports the rest as omitted", () => {
    const memory = new MemoryEngine();
    const builder = new ContextBuilder();
    const resumeFacts: ResumeFact[] = [
      { topic: "caching", content: "Built a Redis caching layer at Acme Corp." },
      { topic: "frontend", content: "Led a React design-system migration." },
    ];

    const result = builder.build({ memory, currentTopic: "caching", resumeFacts, recentTurns: [] });

    expect(result.systemPromptExtra).toContain("Relevant candidate background: Built a Redis caching layer at Acme Corp.");
    expect(result.systemPromptExtra).not.toContain("React design-system");
    expect(result.omitted.unrelatedResumeFacts).toBe(1);
  });

  it("excludes all resume facts for a topic-agnostic call, even when facts are supplied", () => {
    const builder = new ContextBuilder();
    const resumeFacts: ResumeFact[] = [{ topic: "caching", content: "Built a Redis caching layer." }];
    const result = builder.build({ memory: new MemoryEngine(), resumeFacts, recentTurns: [] });

    expect(result.systemPromptExtra).not.toContain("Relevant candidate background");
    expect(result.omitted.unrelatedResumeFacts).toBe(1);
  });

  it("scopes the memory summary to the current topic", () => {
    const memory = new MemoryEngine();
    memory.recordCoveredTopic("caching");
    memory.recordStrength({ description: "good caching intuition", topic: "caching" });
    memory.recordWeakness({ description: "shaky on networking", topic: "networking" });

    const builder = new ContextBuilder();
    const result = builder.build({ memory, currentTopic: "caching", recentTurns: [] });

    expect(result.systemPromptExtra).toContain('Topic "caching" has already been covered.');
    expect(result.systemPromptExtra).toContain("good caching intuition");
    expect(result.systemPromptExtra).not.toContain("networking");
  });

  it("caps recent turns per the configured window and reports how many were dropped", () => {
    const memory = new MemoryEngine();
    const builder = new ContextBuilder({ maxRecentMessages: 2, maxRecentChars: 10_000 });
    const recentTurns = [msg("user", "a"), msg("assistant", "b"), msg("user", "c"), msg("assistant", "d")];

    const result = builder.build({ memory, recentTurns });

    expect(result.messages.map((m) => m.content)).toEqual(["c", "d"]);
    expect(result.omitted.olderTurns).toBe(2);
  });

  it("computes a rough token estimate that grows with the amount of included context", () => {
    const builder = new ContextBuilder();
    const small = builder.build({ memory: new MemoryEngine(), recentTurns: [msg("user", "hi")] });
    const large = builder.build({ memory: new MemoryEngine(), recentTurns: [msg("user", "x".repeat(1000))] });
    expect(large.approxTokens).toBeGreaterThan(small.approxTokens);
  });

  it("never mutates the MemoryEngine or the recentTurns array passed in", () => {
    const memory = new MemoryEngine();
    memory.recordStrength({ description: "clear communicator" });
    const recentTurns = [msg("user", "hi")];
    const builder = new ContextBuilder();

    builder.build({ memory, currentTopic: "caching", recentTurns });

    expect(memory.getSnapshot().strengths).toHaveLength(1);
    expect(recentTurns).toEqual([msg("user", "hi")]);
  });

  it("is deterministic for the same input", () => {
    const memory = new MemoryEngine();
    memory.recordCoveredTopic("caching");
    const builder = new ContextBuilder();
    const input = { memory, currentTopic: "caching", recentTurns: [msg("user", "hi")] };

    expect(builder.build(input)).toEqual(builder.build(input));
  });
});
