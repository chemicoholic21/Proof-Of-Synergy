import { describe, it, expect } from "vitest";
import { DifficultyController } from "./DifficultyController";
import { MemoryEngine } from "./MemoryEngine";
import type { EvidenceEvaluation } from "./EvidenceEvaluator";

function evaluation(overrides: Partial<EvidenceEvaluation> = {}): EvidenceEvaluation {
  return {
    technical_correctness: 7,
    technical_depth: 7,
    communication: 7,
    evidence: [],
    follow_up_opportunity: "n/a",
    ...overrides,
  };
}

describe("DifficultyController.decide() — priority order", () => {
  it("clarifies a contradiction even when the current answer itself is strong", () => {
    const memory = new MemoryEngine();
    memory.recordContradiction({ earlierClaim: "never used Kubernetes", laterStatement: "deployed on Kubernetes for years", topic: "deployment" });
    const controller = new DifficultyController();

    const decision = controller.decide({ evaluation: evaluation({ technical_correctness: 10, technical_depth: 10 }), topic: "deployment", memory });

    expect(decision.directive).toBe("CLARIFY_CONTRADICTION");
    expect(decision.difficultyDelta).toBe(0);
    expect(decision.stayOnTopic).toBe(true);
    expect(decision.reason).toContain("never used Kubernetes");
    expect(decision.reason).toContain("deployed on Kubernetes for years");
  });

  it("only considers a contradiction recorded on the current topic", () => {
    const memory = new MemoryEngine();
    memory.recordContradiction({ earlierClaim: "a", laterStatement: "b", topic: "deployment" });
    const controller = new DifficultyController();

    const decision = controller.decide({ evaluation: evaluation({ technical_correctness: 9, technical_depth: 9 }), topic: "caching", memory });
    expect(decision.directive).not.toBe("CLARIFY_CONTRADICTION");
  });

  it("simplifies for weak fundamentals even if depth looks fine", () => {
    const controller = new DifficultyController();
    const decision = controller.decide({
      evaluation: evaluation({ technical_correctness: 3, technical_depth: 9 }),
      topic: "caching",
      memory: new MemoryEngine(),
    });

    expect(decision.directive).toBe("SIMPLIFY");
    expect(decision.difficultyDelta).toBe(-1);
    expect(decision.stayOnTopic).toBe(true);
    expect(decision.reason).toContain("3/10");
  });

  it("increases difficulty for a first-time strong answer on a topic", () => {
    const controller = new DifficultyController();
    const decision = controller.decide({
      evaluation: evaluation({ technical_correctness: 9, technical_depth: 8 }),
      topic: "caching",
      memory: new MemoryEngine(),
    });

    expect(decision.directive).toBe("INCREASE_DIFFICULTY");
    expect(decision.difficultyDelta).toBe(1);
    expect(decision.stayOnTopic).toBe(true);
  });

  it("deepens the topic instead when a second strong answer lands on the same topic", () => {
    const memory = new MemoryEngine();
    memory.recordStrength({ description: "first strong answer", topic: "caching" });
    const controller = new DifficultyController(); // default repeatedStrengthCount: 2

    const decision = controller.decide({ evaluation: evaluation({ technical_correctness: 9, technical_depth: 8 }), topic: "caching", memory });

    expect(decision.directive).toBe("DEEPEN_TOPIC");
    expect(decision.difficultyDelta).toBe(1);
    expect(decision.reason).toContain("2nd strong answer");
  });

  it("does not count a strength recorded on a different topic toward repeated strength", () => {
    const memory = new MemoryEngine();
    memory.recordStrength({ description: "strong on networking", topic: "networking" });
    const controller = new DifficultyController();

    const decision = controller.decide({ evaluation: evaluation({ technical_correctness: 9, technical_depth: 8 }), topic: "caching", memory });
    expect(decision.directive).toBe("INCREASE_DIFFICULTY");
  });

  it("probes depth for a correct-but-shallow (partial) answer", () => {
    const controller = new DifficultyController();
    const decision = controller.decide({
      evaluation: evaluation({ technical_correctness: 6, technical_depth: 3 }),
      topic: "caching",
      memory: new MemoryEngine(),
    });

    expect(decision.directive).toBe("PROBE_DEPTH");
    expect(decision.difficultyDelta).toBe(0);
    expect(decision.stayOnTopic).toBe(true);
  });

  it("moves to another topic for a solid, unremarkable answer that triggers no other rule", () => {
    const controller = new DifficultyController();
    const decision = controller.decide({
      evaluation: evaluation({ technical_correctness: 7, technical_depth: 7 }),
      topic: "caching",
      memory: new MemoryEngine(),
    });

    expect(decision.directive).toBe("CHANGE_TOPIC");
    expect(decision.difficultyDelta).toBe(0);
    expect(decision.stayOnTopic).toBe(false);
  });
});

describe("DifficultyController.decide() — threshold boundaries", () => {
  it("treats correctness exactly at the weak threshold as not weak", () => {
    const controller = new DifficultyController(); // weakCorrectnessThreshold: 5
    const decision = controller.decide({
      evaluation: evaluation({ technical_correctness: 5, technical_depth: 7 }),
      topic: "caching",
      memory: new MemoryEngine(),
    });
    expect(decision.directive).not.toBe("SIMPLIFY");
  });

  it("treats depth exactly at the partial threshold as not partial", () => {
    const controller = new DifficultyController(); // partialDepthThreshold: 6
    const decision = controller.decide({
      evaluation: evaluation({ technical_correctness: 6, technical_depth: 6 }),
      topic: "caching",
      memory: new MemoryEngine(),
    });
    expect(decision.directive).not.toBe("PROBE_DEPTH");
    expect(decision.directive).toBe("CHANGE_TOPIC");
  });

  it("treats scores exactly at the strong thresholds as strong", () => {
    const controller = new DifficultyController(); // strongCorrectnessThreshold: 8, strongDepthThreshold: 7
    const decision = controller.decide({
      evaluation: evaluation({ technical_correctness: 8, technical_depth: 7 }),
      topic: "caching",
      memory: new MemoryEngine(),
    });
    expect(decision.directive).toBe("INCREASE_DIFFICULTY");
  });
});

describe("DifficultyController — configurable thresholds", () => {
  it("honors a custom weakCorrectnessThreshold", () => {
    const controller = new DifficultyController({ weakCorrectnessThreshold: 7 });
    const decision = controller.decide({
      evaluation: evaluation({ technical_correctness: 6, technical_depth: 9 }),
      topic: "caching",
      memory: new MemoryEngine(),
    });
    expect(decision.directive).toBe("SIMPLIFY"); // 6 < custom threshold of 7
  });

  it("honors a custom difficultyStep magnitude", () => {
    const controller = new DifficultyController({ difficultyStep: 3 });
    const strong = controller.decide({
      evaluation: evaluation({ technical_correctness: 9, technical_depth: 9 }),
      topic: "caching",
      memory: new MemoryEngine(),
    });
    expect(strong.difficultyDelta).toBe(3);

    const weak = controller.decide({
      evaluation: evaluation({ technical_correctness: 1, technical_depth: 1 }),
      topic: "caching",
      memory: new MemoryEngine(),
    });
    expect(weak.difficultyDelta).toBe(-3);
  });

  it("honors a custom repeatedStrengthCount", () => {
    const memory = new MemoryEngine();
    memory.recordStrength({ description: "first", topic: "caching" });
    const controller = new DifficultyController({ repeatedStrengthCount: 3 });

    // Only 1 prior strength recorded; repeatedStrengthCount=3 needs 2 priors before deepening.
    const decision = controller.decide({ evaluation: evaluation({ technical_correctness: 9, technical_depth: 9 }), topic: "caching", memory });
    expect(decision.directive).toBe("INCREASE_DIFFICULTY");

    memory.recordStrength({ description: "second", topic: "caching" });
    const decision2 = controller.decide({ evaluation: evaluation({ technical_correctness: 9, technical_depth: 9 }), topic: "caching", memory });
    expect(decision2.directive).toBe("DEEPEN_TOPIC");
  });

  it("formats the ordinal correctly for higher repeat counts (11th, not 11st)", () => {
    const memory = new MemoryEngine();
    for (let i = 0; i < 10; i++) memory.recordStrength({ description: `strength ${i}`, topic: "caching" });
    const controller = new DifficultyController();

    const decision = controller.decide({ evaluation: evaluation({ technical_correctness: 9, technical_depth: 9 }), topic: "caching", memory });
    expect(decision.directive).toBe("DEEPEN_TOPIC");
    expect(decision.reason).toContain("11th strong answer");
  });
});

describe("DifficultyController — purity and determinism", () => {
  it("never mutates the MemoryEngine passed in", () => {
    const memory = new MemoryEngine();
    memory.recordStrength({ description: "existing", topic: "caching" });
    const before = memory.getSnapshot();
    const controller = new DifficultyController();

    controller.decide({ evaluation: evaluation({ technical_correctness: 9, technical_depth: 9 }), topic: "caching", memory });

    expect(memory.getSnapshot()).toEqual(before);
  });

  it("returns the same decision for the same input", () => {
    const memory = new MemoryEngine();
    const controller = new DifficultyController();
    const input = { evaluation: evaluation(), topic: "caching", memory };

    expect(controller.decide(input)).toEqual(controller.decide(input));
  });
});
