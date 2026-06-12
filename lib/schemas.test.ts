import { describe, it, expect } from "vitest";
import {
  ParsedResumeLLMSchema,
  EvaluationLLMSchema,
  MintBody,
  GateCheckBody,
  EvaluateBody,
} from "./schemas";

describe("ParsedResumeLLMSchema", () => {
  it("accepts a valid resume and requires at least one skill", () => {
    const r = ParsedResumeLLMSchema.parse({
      name: "A",
      contact: null,
      skills: [{ name: "Go", category: "Programming", claimedLevel: "expert" }],
      experience: [],
      education: [],
    });
    expect(r.skills).toHaveLength(1);
  });

  it("rejects a resume with no skills", () => {
    expect(() =>
      ParsedResumeLLMSchema.parse({ name: "A", contact: null, skills: [], experience: [], education: [] })
    ).toThrow();
  });

  it("coerces an unknown claimedLevel to a safe default", () => {
    const r = ParsedResumeLLMSchema.parse({
      name: null,
      contact: null,
      skills: [{ name: "Go", category: "x", claimedLevel: "wizard" }],
      experience: [],
      education: [],
    });
    expect(r.skills[0].claimedLevel).toBe("intermediate");
  });
});

describe("EvaluationLLMSchema", () => {
  it("coerces a string score to a number", () => {
    const e = EvaluationLLMSchema.parse({ score: "73" });
    expect(e.score).toBe(73);
    expect(e.strengths).toEqual([]);
  });

  it("rejects when score is missing", () => {
    expect(() => EvaluationLLMSchema.parse({ feedback: "x" })).toThrow();
  });
});

describe("MintBody", () => {
  it("rejects an empty verdicts array", () => {
    expect(() => MintBody.parse({ verdicts: [] })).toThrow();
  });

  it("accepts a valid verdict and defaults name", () => {
    const b = MintBody.parse({
      verdicts: [{ skill: "Go", claimedLevel: "expert", observedConfidence: 90, status: "strong" }],
    });
    expect(b.name).toBe("Anonymous");
  });

  it("defaults consent to false when omitted (opt-in, never assumed)", () => {
    const b = MintBody.parse({
      verdicts: [{ skill: "Go", claimedLevel: "expert", observedConfidence: 90, status: "strong" }],
    });
    expect(b.consent).toBe(false);
  });

  it("accepts explicit consent", () => {
    const b = MintBody.parse({
      verdicts: [{ skill: "Go", claimedLevel: "expert", observedConfidence: 90, status: "strong" }],
      consent: true,
    });
    expect(b.consent).toBe(true);
  });
});

describe("GateCheckBody", () => {
  it("rejects a non-address subject", () => {
    expect(() => GateCheckBody.parse({ subject: "nope", skill: "Go", minConfidence: 80 })).toThrow();
  });
});

describe("EvaluateBody", () => {
  it("rejects an empty items array", () => {
    expect(() => EvaluateBody.parse({ items: [] })).toThrow();
  });
});
