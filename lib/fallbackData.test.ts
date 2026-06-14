import { describe, it, expect } from "vitest";
import { buildFallbackQuestions } from "./fallbackData";

const skill = (name: string, claimedLevel = "advanced", category = "General") => ({
  name,
  category,
  claimedLevel,
});

describe("buildFallbackQuestions", () => {
  it("derives one question per actual skill, in order", () => {
    const skills = [skill("Rust"), skill("GraphQL"), skill("Terraform")];
    const qs = buildFallbackQuestions(skills);
    expect(qs).toHaveLength(3);
    expect(qs.map((q) => q.targetSkill)).toEqual(["Rust", "GraphQL", "Terraform"]);
    expect(qs.map((q) => q.id)).toEqual([1, 2, 3]);
  });

  it("does NOT return the fixed fictional-profile questions for unrelated skills", () => {
    const qs = buildFallbackQuestions([skill("COBOL"), skill("Fortran")]);
    const joined = qs.map((q) => q.text).join(" ");
    // The old bug served canned questions about a trading service / data-heavy dashboard.
    expect(joined).not.toMatch(/trading service/i);
    expect(joined).not.toMatch(/data-heavy dashboard/i);
    // Instead the question must name the candidate's real skill.
    expect(qs[0].text).toMatch(/COBOL/);
  });

  it("uses a tailored template for known skills", () => {
    const [q] = buildFallbackQuestions([skill("React")]);
    expect(q.targetSkill).toBe("React");
    expect(q.text).toMatch(/React/);
  });

  it("caps the number of questions at 7", () => {
    const many = Array.from({ length: 12 }, (_, i) => skill(`Skill${i}`));
    expect(buildFallbackQuestions(many)).toHaveLength(7);
  });
});
