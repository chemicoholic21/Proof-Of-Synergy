import { describe, it, expect } from "vitest";
import { MemoryEngine } from "./MemoryEngine";

describe("MemoryEngine — construction and stage lifecycle", () => {
  it("defaults to OPENING stage and difficulty 5", () => {
    const memory = new MemoryEngine();
    expect(memory.stage).toBe("OPENING");
    expect(memory.getDifficulty()).toBe(5);
  });

  it("accepts a custom initial stage and difficulty, clamped to 1-10", () => {
    const memory = new MemoryEngine({ initialStage: "CORE", initialDifficulty: 999 });
    expect(memory.stage).toBe("CORE");
    expect(memory.getDifficulty()).toBe(10);
  });

  it("advances forward through OPENING -> CORE -> CLOSING", () => {
    const memory = new MemoryEngine();
    memory.advanceStage("CORE");
    expect(memory.stage).toBe("CORE");
    memory.advanceStage("CLOSING");
    expect(memory.stage).toBe("CLOSING");
  });

  it("allows staying on the same stage", () => {
    const memory = new MemoryEngine({ initialStage: "CORE" });
    expect(memory.canAdvanceTo("CORE")).toBe(true);
    expect(() => memory.advanceStage("CORE")).not.toThrow();
  });

  it("throws when advanceStage() would move the interview backward", () => {
    const memory = new MemoryEngine({ initialStage: "CLOSING" });
    expect(() => memory.advanceStage("OPENING")).toThrow(/cannot move/);
    expect(memory.stage).toBe("CLOSING");
  });

  it("tryAdvanceStage() returns false instead of throwing on a backward move", () => {
    const memory = new MemoryEngine({ initialStage: "CORE" });
    expect(memory.tryAdvanceStage("OPENING")).toBe(false);
    expect(memory.stage).toBe("CORE");
    expect(memory.tryAdvanceStage("CLOSING")).toBe(true);
    expect(memory.stage).toBe("CLOSING");
  });
});

describe("MemoryEngine — difficulty level", () => {
  it("setDifficulty() clamps to the 1-10 range", () => {
    const memory = new MemoryEngine();
    expect(memory.setDifficulty(-5)).toBe(1);
    expect(memory.setDifficulty(999)).toBe(10);
    expect(memory.setDifficulty(7)).toBe(7);
  });

  it("adjustDifficulty() applies a delta and clamps", () => {
    const memory = new MemoryEngine({ initialDifficulty: 5 });
    expect(memory.adjustDifficulty(2)).toBe(7);
    expect(memory.adjustDifficulty(-10)).toBe(1);
  });

  it("records a difficulty change history entry with stage and reason", () => {
    const memory = new MemoryEngine();
    memory.advanceStage("CORE");
    memory.adjustDifficulty(1, "answered a hard question well");
    const snapshot = memory.getSnapshot();
    expect(snapshot.difficultyHistory).toHaveLength(1);
    expect(snapshot.difficultyHistory[0]).toMatchObject({ level: 6, stage: "CORE", reason: "answered a hard question well" });
  });
});

describe("MemoryEngine — recording strengths, weaknesses, and skills", () => {
  it("records strengths and weaknesses with the current stage", () => {
    const memory = new MemoryEngine();
    memory.recordStrength({ description: "explains tradeoffs clearly", topic: "caching" });
    memory.advanceStage("CORE");
    memory.recordWeakness({ description: "vague on failure modes", topic: "caching", evidenceQuote: "it just works" });

    const snapshot = memory.getSnapshot();
    expect(snapshot.strengths).toEqual([
      { description: "explains tradeoffs clearly", topic: "caching", stage: "OPENING", timestamp: expect.any(Number) },
    ]);
    expect(snapshot.weaknesses).toEqual([
      {
        description: "vague on failure modes",
        topic: "caching",
        evidenceQuote: "it just works",
        stage: "CORE",
        timestamp: expect.any(Number),
      },
    ]);
  });

  it("distinguishes demonstrated skills (with evidence) from merely claimed ones", () => {
    const memory = new MemoryEngine();
    memory.recordDemonstratedSkill({ skill: "Redis", topic: "caching", evidenceQuote: "I used Redis for caching" });
    memory.recordClaimedSkill({ skill: "Kubernetes", topic: "deployment" });

    const snapshot = memory.getSnapshot();
    expect(snapshot.demonstratedSkills[0]).toMatchObject({ skill: "Redis", evidenceQuote: "I used Redis for caching" });
    expect(snapshot.claimedSkills[0]).toMatchObject({ skill: "Kubernetes" });
    expect(snapshot.claimedSkills[0].evidenceQuote).toBeUndefined();
  });
});

describe("MemoryEngine — covered topics", () => {
  it("records a new topic as covered with zero revisits", () => {
    const memory = new MemoryEngine();
    const record = memory.recordCoveredTopic("Distributed Systems");
    expect(record.timesRevisited).toBe(0);
    expect(record.firstCoveredAt).toBe(record.lastCoveredAt);
  });

  it("treats re-covering the same topic (case/whitespace-insensitive) as a revisit, not a duplicate", () => {
    const memory = new MemoryEngine();
    const first = memory.recordCoveredTopic("Distributed Systems");
    const second = memory.recordCoveredTopic("  distributed systems  ");

    expect(second.timesRevisited).toBe(1);
    expect(second.firstCoveredAt).toBe(first.firstCoveredAt);
    expect(memory.getSnapshot().coveredTopics).toHaveLength(1);
  });

  it("isTopicCovered() normalizes case and whitespace", () => {
    const memory = new MemoryEngine();
    memory.recordCoveredTopic("Caching");
    expect(memory.isTopicCovered("  caching ")).toBe(true);
    expect(memory.isTopicCovered("networking")).toBe(false);
  });
});

describe("MemoryEngine — unanswered questions and contradictions", () => {
  it("records and resolves an unanswered question by normalized text match", () => {
    const memory = new MemoryEngine();
    memory.recordUnansweredQuestion({ question: "How do you handle cache invalidation?", topic: "caching" });
    expect(memory.hasUnansweredQuestions()).toBe(true);
    expect(memory.hasUnansweredQuestions("caching")).toBe(true);
    expect(memory.hasUnansweredQuestions("networking")).toBe(false);

    expect(memory.resolveUnansweredQuestion("  HOW DO YOU HANDLE CACHE INVALIDATION?  ")).toBe(true);
    expect(memory.hasUnansweredQuestions()).toBe(false);
  });

  it("resolving a question that was never recorded returns false", () => {
    const memory = new MemoryEngine();
    expect(memory.resolveUnansweredQuestion("never asked")).toBe(false);
  });

  it("records a contradiction between an earlier claim and a later statement", () => {
    const memory = new MemoryEngine();
    memory.recordContradiction({
      earlierClaim: "I have never used Kubernetes",
      laterStatement: "I deployed our service on Kubernetes for two years",
      topic: "deployment",
    });
    expect(memory.getSnapshot().contradictions).toHaveLength(1);
  });
});

describe("MemoryEngine — getSnapshot()", () => {
  it("returns an isolated deep clone that mutation cannot corrupt", () => {
    const memory = new MemoryEngine();
    memory.recordStrength({ description: "clear communicator" });
    const snapshot = memory.getSnapshot();
    snapshot.strengths[0].description = "mutated";
    snapshot.difficultyHistory.push({ level: 99, stage: "CLOSING", timestamp: 0 });

    const second = memory.getSnapshot();
    expect(second.strengths[0].description).toBe("clear communicator");
    expect(second.difficultyHistory).toHaveLength(0);
  });
});

describe("MemoryEngine — getFactsForTopic()", () => {
  it("scopes every fact type to the matching topic and reports coverage", () => {
    const memory = new MemoryEngine();
    memory.recordCoveredTopic("caching");
    memory.recordStrength({ description: "good caching intuition", topic: "caching" });
    memory.recordWeakness({ description: "shaky on networking basics", topic: "networking" });
    memory.recordDemonstratedSkill({ skill: "Redis", topic: "caching", evidenceQuote: "used Redis" });
    memory.recordClaimedSkill({ skill: "TCP tuning", topic: "networking" });
    memory.recordUnansweredQuestion({ question: "cache eviction policy?", topic: "caching" });
    memory.recordContradiction({ earlierClaim: "a", laterStatement: "b", topic: "caching" });

    const facts = memory.getFactsForTopic("Caching"); // different case than stored
    expect(facts.covered).toBe(true);
    expect(facts.coveredInfo?.topic).toBe("caching");
    expect(facts.strengths).toHaveLength(1);
    expect(facts.weaknesses).toHaveLength(0);
    expect(facts.demonstratedSkills).toHaveLength(1);
    expect(facts.claimedSkills).toHaveLength(0);
    expect(facts.unansweredQuestions).toHaveLength(1);
    expect(facts.contradictions).toHaveLength(1);
  });

  it("reports covered: false for a topic never recorded", () => {
    const memory = new MemoryEngine();
    const facts = memory.getFactsForTopic("unknown topic");
    expect(facts.covered).toBe(false);
    expect(facts.coveredInfo).toBeUndefined();
  });
});

describe("MemoryEngine — getFactsForStage()", () => {
  it("scopes every fact type (including covered topics) to the stage they were recorded in", () => {
    const memory = new MemoryEngine(); // OPENING
    memory.recordCoveredTopic("intro");
    memory.recordStrength({ description: "confident opener" });

    memory.advanceStage("CORE");
    memory.recordCoveredTopic("caching");
    memory.recordWeakness({ description: "vague on tradeoffs" });
    memory.recordDemonstratedSkill({ skill: "Redis" });
    memory.recordClaimedSkill({ skill: "Kubernetes" });
    memory.recordUnansweredQuestion({ question: "why Redis over Memcached?" });
    memory.recordContradiction({ earlierClaim: "a", laterStatement: "b" });

    const core = memory.getFactsForStage("CORE");
    expect(core.coveredTopics.map((t) => t.topic)).toEqual(["caching"]);
    expect(core.strengths).toHaveLength(0);
    expect(core.weaknesses).toHaveLength(1);
    expect(core.demonstratedSkills).toHaveLength(1);
    expect(core.claimedSkills).toHaveLength(1);
    expect(core.unansweredQuestions).toHaveLength(1);
    expect(core.contradictions).toHaveLength(1);

    const opening = memory.getFactsForStage("OPENING");
    expect(opening.coveredTopics.map((t) => t.topic)).toEqual(["intro"]);
    expect(opening.strengths).toHaveLength(1);
    expect(opening.weaknesses).toHaveLength(0);
  });
});

describe("MemoryEngine — buildContextSummary()", () => {
  it("always includes stage and difficulty, with no other sections when nothing is recorded", () => {
    const memory = new MemoryEngine();
    expect(memory.buildContextSummary()).toBe("Interview stage: OPENING. Current difficulty: 5/10.");
  });

  it("includes every populated section and omits empty ones, unscoped", () => {
    const memory = new MemoryEngine();
    memory.recordCoveredTopic("caching");
    memory.recordDemonstratedSkill({ skill: "Redis" });
    memory.recordStrength({ description: "clear tradeoff explanation" });
    memory.recordUnansweredQuestion({ question: "cache invalidation strategy?" });
    memory.recordContradiction({ earlierClaim: "never used Kubernetes", laterStatement: "deployed on Kubernetes for years" });

    const summary = memory.buildContextSummary();
    expect(summary).toContain("Topics already covered: caching.");
    expect(summary).toContain("Demonstrated skills (with evidence): Redis.");
    expect(summary).toContain("Known strengths: clear tradeoff explanation.");
    expect(summary).toContain("Open follow-ups: cache invalidation strategy?.");
    expect(summary).toContain('earlier said "never used Kubernetes", later said "deployed on Kubernetes for years"');
    expect(summary).not.toContain("Claimed but not yet demonstrated"); // nothing recorded -> omitted
    expect(summary).not.toContain("Known weaknesses");
  });

  it("scopes the summary to a specific topic and states its coverage explicitly", () => {
    const memory = new MemoryEngine();
    memory.recordCoveredTopic("caching");
    memory.recordStrength({ description: "good caching intuition", topic: "caching" });
    memory.recordWeakness({ description: "shaky networking basics", topic: "networking" });

    const summary = memory.buildContextSummary({ topic: "caching" });
    expect(summary).toContain('Topic "caching" has already been covered.');
    expect(summary).toContain("Known strengths: good caching intuition.");
    expect(summary).not.toContain("networking basics"); // scoped away
  });

  it("states clearly when the scoped topic has not been covered yet", () => {
    const memory = new MemoryEngine();
    const summary = memory.buildContextSummary({ topic: "security" });
    expect(summary).toContain('Topic "security" has not already been covered.');
  });

  it("scopes the summary to a specific stage", () => {
    const memory = new MemoryEngine();
    memory.recordStrength({ description: "opening strength" });
    memory.advanceStage("CORE");
    memory.recordStrength({ description: "core strength" });

    const summary = memory.buildContextSummary({ stage: "OPENING" });
    expect(summary).toContain("opening strength");
    expect(summary).not.toContain("core strength");
  });
});
