import { describe, it, expect, beforeEach } from "vitest";
import { emptyGraph } from "./graph/model";
import { __setClock } from "./graph/ops";
import { rememberInterview, rememberResume } from "./remember";
import { recall } from "./recall";
import { improve } from "./improve";
import { forget } from "./forget";
import { realityGap, graphView, memoryReplay, communicationTrend, improvementTimeline } from "./derive";
import { recommendations } from "./recommendations";
import { learningMissions } from "./learning";
import { RememberAnswer } from "./types";

// Deterministic clock we can advance to exercise retention decay.
let virtualNow = Date.parse("2026-01-01T00:00:00.000Z");
function iso() {
  return new Date(virtualNow).toISOString();
}
function advanceDays(d: number) {
  virtualNow += d * 24 * 60 * 60 * 1000;
}

beforeEach(() => {
  virtualNow = Date.parse("2026-01-01T00:00:00.000Z");
  __setClock(iso);
});

function answer(o: Partial<RememberAnswer> & { targetSkill: string; score: number; questionId: number }): RememberAnswer {
  return {
    questionText: `Question about ${o.targetSkill}`,
    transcript: o.transcript ?? "I built a service and, um, basically I think it worked kind of well.",
    rubric: "",
    feedback: "",
    strengths: [],
    improvements: [],
    ...o,
  } as RememberAnswer;
}

describe("remember()", () => {
  it("turns a resume into structured candidate→resume→CLAIMS→skill nodes and concept sub-graph", () => {
    const g = emptyGraph("alice", "Alice", iso());
    rememberResume(g, {
      candidateId: "alice",
      name: "Alice",
      skills: [
        { name: "Kafka", claimedLevel: "advanced" },
        { name: "React", claimedLevel: "expert" },
      ],
      experience: [{ role: "Engineer", company: "Google", years: 3 }],
    });
    const kinds = Object.values(g.nodes).map((n) => n.kind);
    expect(kinds).toContain("candidate");
    expect(kinds).toContain("resume");
    expect(kinds).toContain("skill");
    expect(kinds).toContain("company");
    // Kafka exploded into its concept sub-graph.
    const conceptLabels = Object.values(g.nodes).filter((n) => n.kind === "concept").map((n) => n.label);
    expect(conceptLabels).toContain("Consumer Groups");
    // A claim does NOT grant confidence.
    const kafka = Object.values(g.nodes).find((n) => n.kind === "skill" && n.label === "Kafka")!;
    expect(kafka.confidence).toBe(0);
  });
});

describe("recall()", () => {
  it("is empty for a brand-new candidate and reports unverified claimed skills", () => {
    const g = emptyGraph("bob", "Bob", iso());
    rememberResume(g, { candidateId: "bob", skills: [{ name: "Docker", claimedLevel: "advanced" }] });
    const r = recall(g);
    expect(r.isNew).toBe(true);
    expect(r.unverifiedSkills).toContain("Docker");
    expect(r.focusDirectives.join(" ")).toMatch(/first interview/i);
  });

  it("flags weak concepts after a failed interview", () => {
    const g = emptyGraph("carol", "Carol", iso());
    rememberResume(g, { candidateId: "carol", skills: [{ name: "Kubernetes", claimedLevel: "advanced" }] });
    rememberInterview(g, {
      candidateId: "carol",
      answers: [answer({ questionId: 1, targetSkill: "Kubernetes", score: 30 })],
    });
    const r = recall(g);
    expect(r.isNew).toBe(false);
    const weak = r.weakConcepts.map((c) => c.name);
    expect(weak).toContain("Kubernetes");
    expect(r.focusDirectives.join(" ")).toMatch(/weak/i);
  });

  it("marks concepts forgotten as retention decays over time (spaced repetition)", () => {
    const g = emptyGraph("dave", "Dave", iso());
    rememberResume(g, { candidateId: "dave", skills: [{ name: "Kubernetes", claimedLevel: "advanced" }] });
    rememberInterview(g, {
      candidateId: "dave",
      answers: [answer({ questionId: 1, targetSkill: "Kubernetes", score: 85 })],
    });
    // Right away it is strong, not forgotten.
    expect(recall(g).forgottenConcepts.map((c) => c.name)).not.toContain("Kubernetes");
    // 90 days later, retention has decayed below threshold.
    advanceDays(90);
    const later = recall(g);
    expect(later.forgottenConcepts.map((c) => c.name)).toContain("Kubernetes");
  });
});

describe("improve()", () => {
  it("builds concept relationships, recommendations and improvement milestones", () => {
    const g = emptyGraph("erin", "Erin", iso());
    rememberResume(g, { candidateId: "erin", skills: [{ name: "Kafka", claimedLevel: "advanced" }] });
    // First interview: weak.
    rememberInterview(g, { candidateId: "erin", answers: [answer({ questionId: 1, targetSkill: "Kafka", score: 40, transcript: "I am not sure, um, maybe partitions?" })] });
    improve(g);
    // Second interview: much better -> milestone.
    advanceDays(20);
    rememberInterview(g, { candidateId: "erin", answers: [answer({ questionId: 1, targetSkill: "Kafka", score: 82, transcript: "I designed a partitioned consumer group with offset checkpointing in production." })] });
    const summary = improve(g);
    expect(summary.milestones.join(" ")).toMatch(/Kafka/);
    // RELATED_TO edges exist among concepts.
    const relatedEdges = Object.values(g.edges).filter((e) => e.type === "RELATED_TO");
    expect(relatedEdges.length).toBeGreaterThan(0);
    // Recommendation + resource nodes were created.
    expect(Object.values(g.nodes).some((n) => n.kind === "recommendation")).toBe(true);
    expect(Object.values(g.nodes).some((n) => n.kind === "resource")).toBe(true);
  });
});

describe("derive views", () => {
  it("reality gap uses positive tiers and communication trend tracks DNA over interviews", () => {
    const g = emptyGraph("frank", "Frank", iso());
    rememberResume(g, { candidateId: "frank", skills: [{ name: "React", claimedLevel: "expert" }, { name: "Kubernetes", claimedLevel: "advanced" }] });
    rememberInterview(g, {
      candidateId: "frank",
      answers: [
        answer({ questionId: 1, targetSkill: "React", score: 88, transcript: "I profiled the render, memoized rows and virtualized the list in production." }),
        answer({ questionId: 2, targetSkill: "Kubernetes", score: 32, transcript: "um, I think it is the same, basically." }),
      ],
    });
    improve(g);
    const rg = realityGap(g);
    const react = rg.find((x) => x.skill === "React")!;
    const k8s = rg.find((x) => x.skill === "Kubernetes")!;
    expect(react.tier).toBe("highly-demonstrated");
    expect(k8s.tier).toBe("needs-evidence");
    // Never negative wording.
    expect(JSON.stringify(rg).toLowerCase()).not.toMatch(/liar|lying|fraud|fake/);

    const trend = communicationTrend(g);
    expect(trend.length).toBe(1);
    expect(trend[0].fillerCount).toBeGreaterThan(0);

    expect(recommendations(g).some((r) => r.concept.toLowerCase().includes("kubernetes"))).toBe(true);
    expect(learningMissions(g).length).toBeGreaterThan(0);
    expect(graphView(g).nodes.length).toBeGreaterThan(0);
  });

  it("memory replay returns every answer to a skill across interviews", () => {
    const g = emptyGraph("grace", "Grace", iso());
    rememberResume(g, { candidateId: "grace", skills: [{ name: "Docker", claimedLevel: "advanced" }] });
    rememberInterview(g, { candidateId: "grace", answers: [answer({ questionId: 1, targetSkill: "Docker", score: 40 })] });
    advanceDays(30);
    rememberInterview(g, { candidateId: "grace", answers: [answer({ questionId: 1, targetSkill: "Docker", score: 80 })] });
    const replay = memoryReplay(g, "Docker");
    expect(replay.length).toBe(2);
    expect(replay[0].score).toBe(40);
    expect(replay[1].score).toBe(80);
    expect(improvementTimeline(g).find((s) => s.skill === "Docker")!.points).toEqual([40, 80]);
  });
});

describe("forget()", () => {
  it("removes an interview, cascades its questions/answers, and recomputes confidence", () => {
    const g = emptyGraph("heidi", "Heidi", iso());
    rememberResume(g, { candidateId: "heidi", skills: [{ name: "Docker", claimedLevel: "advanced" }] });
    rememberInterview(g, { candidateId: "heidi", answers: [answer({ questionId: 1, targetSkill: "Docker", score: 40 })] });
    advanceDays(10);
    rememberInterview(g, { candidateId: "heidi", answers: [answer({ questionId: 1, targetSkill: "Docker", score: 90 })] });
    improve(g);
    const before = Object.keys(g.nodes).length;
    const res = forget(g, { type: "interview", index: 2 });
    expect(res.ok).toBe(true);
    expect(Object.keys(g.nodes).length).toBeLessThan(before);
    // Only interview #1 (score 40) remains → Docker confidence reflects only that evidence.
    const docker = Object.values(g.nodes).find((n) => n.kind === "skill" && n.label === "Docker")!;
    expect(docker.confidence).toBe(40);
    // No dangling edges.
    for (const e of Object.values(g.edges)) {
      expect(g.nodes[e.from]).toBeDefined();
      expect(g.nodes[e.to]).toBeDefined();
    }
  });

  it("wipes everything on { type: all }", () => {
    const g = emptyGraph("ivan", "Ivan", iso());
    rememberResume(g, { candidateId: "ivan", skills: [{ name: "Go", claimedLevel: "expert" }] });
    forget(g, { type: "all" });
    expect(Object.keys(g.nodes).length).toBe(0);
    expect(Object.keys(g.edges).length).toBe(0);
  });
});
