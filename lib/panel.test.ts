import { describe, it, expect } from "vitest";
import { aggregatePanel, JudgePanelParts } from "./panel";

const parts = (over: Partial<{
  tech: number;
  techJust: string;
  comm: number;
  commFlags: string[];
  commJust: string;
  deduction: number;
  reasons: string[];
}> = {}): JudgePanelParts => ({
  technical: { score: over.tech ?? 80, justification: over.techJust ?? "Solid reasoning." },
  communication: {
    score: over.comm ?? 80,
    authenticityFlags: over.commFlags ?? [],
    justification: over.commJust ?? "Clear answer.",
  },
  skeptic: { deduction: over.deduction ?? 0, reasons: over.reasons ?? [] },
});

describe("aggregatePanel", () => {
  it("weights technical 0.6 / communication 0.4 and subtracts the skeptic deduction", () => {
    const r = aggregatePanel(parts({ tech: 90, comm: 80, deduction: 10 }), { confidenceMin: 50 });
    // 0.6*90 + 0.4*80 = 86; minus 10 = 76
    expect(r.score).toBe(76);
    expect(r.subScores).toEqual({ technical: 90, communication: 80, deduction: 10 });
  });

  it("clamps out-of-range judge outputs (score 0-100, deduction 0-40)", () => {
    const r = aggregatePanel(parts({ tech: 200, comm: -50, deduction: 999 }), { confidenceMin: 50 });
    expect(r.subScores.technical).toBe(100);
    expect(r.subScores.communication).toBe(0);
    expect(r.subScores.deduction).toBe(40); // capped at 40
    // base = 0.6*100 + 0.4*0 = 60; minus 40 = 20
    expect(r.score).toBe(20);
  });

  it("never returns a score outside 0-100", () => {
    const r = aggregatePanel(parts({ tech: 5, comm: 5, deduction: 40 }), { confidenceMin: 50 });
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(100);
  });

  it("flags low confidence when the two scorers strongly disagree", () => {
    const r = aggregatePanel(parts({ tech: 20, comm: 90, deduction: 0 }), { confidenceMin: 50 });
    // disagreement = 70 -> confidence = 30 -> below threshold
    expect(r.confidence).toBe(30);
    expect(r.lowConfidence).toBe(true);
    expect(r.feedback).toMatch(/human review/i);
  });

  it("reports high confidence and surfaces strengths when judges agree on a strong answer", () => {
    const r = aggregatePanel(parts({ tech: 88, comm: 85, deduction: 0 }), { confidenceMin: 50 });
    expect(r.confidence).toBe(97); // 100 - 3 - 0
    expect(r.lowConfidence).toBe(false);
    expect(r.strengths.length).toBeGreaterThan(0);
  });

  it("turns skeptic reasons and authenticity flags into improvements", () => {
    const r = aggregatePanel(
      parts({
        tech: 60,
        comm: 60,
        deduction: 20,
        reasons: ["No mention of error handling", "Vague on tradeoffs"],
        commFlags: ["Buzzword-heavy"],
      }),
      { confidenceMin: 50 }
    );
    expect(r.improvements).toContain("No mention of error handling");
    expect(r.improvements).toContain("Buzzword-heavy");
  });

  it("flags zero confidence and adds warning when both judges return 0 (suspicious default)", () => {
    const r = aggregatePanel(parts({ tech: 0, comm: 0, deduction: 0 }), { confidenceMin: 50 });
    expect(r.confidence).toBe(0);
    expect(r.lowConfidence).toBe(true);
    expect(r.feedback).toMatch(/model defaulted/i);
  });
});
