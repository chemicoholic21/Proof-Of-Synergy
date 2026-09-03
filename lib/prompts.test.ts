import { describe, it, expect } from "vitest";
import { INTERVIEW_SYSTEM, buildInterviewContext, SUMMARY_SYSTEM, summaryUserPrompt } from "./prompts";

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

describe("SUMMARY_SYSTEM", () => {
  it("defines good feedback as specific, JD-targeted, actionable, and honest", () => {
    // Regression guard for the "feedback is generic and not targeted to the JD" fix.
    expect(SUMMARY_SYSTEM).toMatch(/specific/i);
    expect(SUMMARY_SYSTEM).toMatch(/job description/i);
    expect(SUMMARY_SYSTEM).toMatch(/honest/i);
  });
});

describe("summaryUserPrompt", () => {
  const baseMetrics = {
    fillerCount: 3,
    confidence: 70,
    wordCount: 500,
    scenarioTitle: "Technical interview",
    coachingEvents: [],
  };

  it("includes the actual transcript so feedback can cite real moments, not just aggregate stats", () => {
    const prompt = summaryUserPrompt({
      ...baseMetrics,
      transcript: [
        { role: "assistant", content: "Tell me about a distributed system you built." },
        { role: "user", content: "I built a payments queue on Kafka that handled 10k events/sec." },
      ],
    });
    expect(prompt).toContain("payments queue on Kafka");
    expect(prompt).toContain("distributed system you built");
  });

  it("says the transcript is unavailable rather than inventing one when none is given", () => {
    const prompt = summaryUserPrompt(baseMetrics);
    expect(prompt).toMatch(/transcript unavailable/i);
  });

  it("includes the role/JD context and instructs grading against it when this is a resume-based interview", () => {
    const interviewContext = "TARGET ROLE: Backend Engineer\nCANDIDATE RESUME:\n<<<RESUME>>>\n...";
    const prompt = summaryUserPrompt({ ...baseMetrics, interviewContext });
    expect(prompt).toContain("Backend Engineer");
    expect(prompt).toMatch(/role\/JD/i);
  });

  it("omits any role/JD framing for non-interview scenarios (no interviewContext)", () => {
    const prompt = summaryUserPrompt(baseMetrics);
    expect(prompt).not.toContain("ROLE_CONTEXT");
  });
});
