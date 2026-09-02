import { describe, it, expect } from "vitest";
import { INTERVIEW_SYSTEM, buildInterviewContext } from "./prompts";

describe("INTERVIEW_SYSTEM", () => {
  it("instructs the interviewer to catch off-topic/non-answers and redirect back to the question", () => {
    // Regression guard for the "enforce conversation boundaries" fix: the persona must not just
    // passively continue when the candidate doesn't actually answer what was asked.
    expect(INTERVIEW_SYSTEM).toMatch(/off-topic/i);
    expect(INTERVIEW_SYSTEM).toMatch(/call out/i);
    expect(INTERVIEW_SYSTEM).toMatch(/redirect/i);
  });
});

describe("buildInterviewContext", () => {
  it("returns only candidate/resume/JD context, not the interviewer persona rules", () => {
    // INTERVIEW_SYSTEM must be sent as the actual `system` message by callers (app/api/gemini and
    // app/api/interview/prepare) so it actually governs the model's behavior — not buried as extra
    // user-turn text alongside the resume, which is how the boundary-enforcement rules previously
    // went unenforced in the main interview flow.
    const context = buildInterviewContext({ resumeText: "Built things with React.", role: "Frontend Engineer" });
    expect(context).not.toContain(INTERVIEW_SYSTEM);
    expect(context).toContain("Built things with React.");
    expect(context).toContain("Frontend Engineer");
  });
});
