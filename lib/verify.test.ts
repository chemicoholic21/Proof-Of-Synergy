import { describe, it, expect } from "vitest";
import { aggregateConfidence, buildVerdicts, overallScore } from "./verify";
import { QuestionEvaluation, ResumeSkill } from "./types";

const ev = (targetSkill: string, score: number): QuestionEvaluation => ({
  questionId: 1,
  targetSkill,
  score,
  feedback: "",
  strengths: [],
  improvements: [],
});

describe("aggregateConfidence", () => {
  it("averages scores per skill", () => {
    const out = aggregateConfidence([ev("Python", 80), ev("Python", 100), ev("AWS", 50)]);
    expect(out).toEqual({ Python: 90, AWS: 50 });
  });

  it("returns empty for no evaluations", () => {
    expect(aggregateConfidence([])).toEqual({});
  });
});

describe("buildVerdicts", () => {
  const skills: ResumeSkill[] = [
    { name: "Python", category: "Programming", claimedLevel: "expert" },
    { name: "Kubernetes", category: "DevOps", claimedLevel: "advanced" },
    { name: "Rust", category: "Programming", claimedLevel: "intermediate" },
  ];

  it("flags a claimed-expert skill with a low observed score as needing more evidence (coaching tone)", () => {
    const v = buildVerdicts(skills, { Python: 34 });
    const python = v.find((x) => x.skill === "Python")!;
    expect(python.status).toBe("exaggerated");
    // Supportive, never shaming: mentions the claim + a next step, no "exaggerated/fraud/lie" wording.
    expect(python.flag).toMatch(/practice|strengthen|evidence/i);
    expect(python.flag).not.toMatch(/exaggerat|fraud|lie/i);
  });

  it("marks a high observed score as strong", () => {
    const v = buildVerdicts(skills, { Python: 92 });
    expect(v.find((x) => x.skill === "Python")!.status).toBe("strong");
  });

  it("marks untested skills as exaggerated/not-demonstrated", () => {
    const v = buildVerdicts(skills, { Python: 90 });
    const k8s = v.find((x) => x.skill === "Kubernetes")!;
    expect(k8s.observedConfidence).toBe(0);
    expect(k8s.flag).toMatch(/verify it in an interview/i);
  });

  it("marks a mid-range score that meets expectation as verified", () => {
    const v = buildVerdicts(skills, { Rust: 78 });
    expect(v.find((x) => x.skill === "Rust")!.status).toBe("verified");
  });
});

describe("overallScore", () => {
  it("averages all skill confidences", () => {
    expect(overallScore({ a: 80, b: 100 })).toBe(90);
  });
  it("is 0 when empty", () => {
    expect(overallScore({})).toBe(0);
  });
});
