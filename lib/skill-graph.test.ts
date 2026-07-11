import { describe, expect, it } from "vitest";
import {
  buildDashboard,
  buildDemoSkillGraph,
  emptySkillGraph,
  forgetSkill,
  fromClient,
  graphView,
  practiceReplay,
  recallSkills,
  rememberSession,
  serializeSessionForCognee,
} from "./skill-graph";
import type { SessionResult } from "./types";

function sampleSession(confidence = 60, scenarioId = "startup-pitch"): SessionResult {
  return {
    scenarioId,
    durationSec: 120,
    messages: [
      { role: "assistant", content: "Pitch me your startup.", timestamp: 1 },
      { role: "user", content: "We build a communication gym powered by AI coaching.", timestamp: 2 },
    ],
    coachingEvents: [{ type: "filler", text: 'Filler word: "like"', timestamp: 3 }],
    metrics: {
      wordCount: 120,
      fillerCount: 4,
      fillerRate: 3.3,
      hedgeCount: 1,
      vocabularyRichness: 60,
      avgSentenceLength: 14,
      confidenceMarkers: 2,
      confidence,
      technicalDepth: 30,
      speechRateWpm: 130,
      topFillers: [{ word: "like", count: 4 }],
    },
    summary: "Strong hook; reduce fillers.",
  };
}

describe("skill graph lifecycle", () => {
  it("remember() folds a session into skills derived from the scenario", async () => {
    const { graph, skillIds } = await rememberSession({ learnerId: "t-remember", session: sampleSession() });
    expect(graph.revision).toBe(1);
    expect(Object.keys(graph.sessions)).toHaveLength(1);
    // startup-pitch tags: persuasion, storytelling + the scenario title itself
    expect(skillIds).toContain("skill:persuasion");
    expect(skillIds).toContain("skill:storytelling");
    expect(graph.skills["skill:persuasion"].exposure).toBe(1);
  });

  it("repeated practice moves rolling confidence toward the session score", async () => {
    const first = await rememberSession({ learnerId: "t-roll", session: sampleSession(40) });
    const c1 = first.graph.skills["skill:persuasion"].confidence;
    const second = await rememberSession({ learnerId: "t-roll", session: sampleSession(90), graph: first.graph });
    const c2 = second.graph.skills["skill:persuasion"].confidence;
    expect(c2).toBeGreaterThan(c1);
    expect(second.graph.skills["skill:persuasion"].sessions).toBe(2);
  });

  it("recall() classifies strong and weak skills and suggests the weakest next", async () => {
    const first = await rememberSession({ learnerId: "t-recall", session: sampleSession(90) });
    const second = await rememberSession({ learnerId: "t-recall", session: sampleSession(90), graph: first.graph });
    const withWeak = await rememberSession({ learnerId: "t-recall", session: sampleSession(20, "leadership"), graph: second.graph });
    const recall = recallSkills(withWeak.graph);
    expect(recall.strong.length).toBeGreaterThan(0);
    expect(recall.weak.length).toBeGreaterThan(0);
    expect(recall.suggestedNext).not.toBeNull();
    expect(recall.suggestedNext!.confidence).toBe(Math.min(...recall.skills.map((s) => s.confidence)));
  });

  it("replay() returns a skill's chronological growth", async () => {
    const a = await rememberSession({ learnerId: "t-replay", session: sampleSession(40) });
    const b = await rememberSession({ learnerId: "t-replay", session: sampleSession(80), graph: a.graph });
    const replay = practiceReplay(b.graph, "persuasion");
    expect(replay.entries).toHaveLength(2);
    expect(replay.entries[0].confidence).toBe(40);
    expect(replay.entries[1].confidence).toBe(80);
  });

  it("forget() removes a skill everywhere and forget-all empties the graph", async () => {
    const { graph } = await rememberSession({ learnerId: "t-forget", session: sampleSession() });
    const afterSkill = await forgetSkill("t-forget", graph, { type: "skill", name: "persuasion" });
    expect(afterSkill.graph.skills["skill:persuasion"]).toBeUndefined();
    for (const s of Object.values(afterSkill.graph.sessions)) {
      expect(s.skills).not.toContain("skill:persuasion");
    }
    const afterAll = await forgetSkill("t-forget", afterSkill.graph, { type: "all" });
    expect(Object.keys(afterAll.graph.skills)).toHaveLength(0);
    expect(Object.keys(afterAll.graph.sessions)).toHaveLength(0);
  });

  it("fromClient() adopts a valid client graph and rejects malformed input", () => {
    const g = buildDemoSkillGraph("t-client");
    const adopted = fromClient("t-client", JSON.parse(JSON.stringify(g)));
    expect(adopted?.revision).toBe(g.revision);
    expect(fromClient("t-client", { nonsense: true })).toBeNull();
    expect(fromClient("t-client", "not an object")).toBeNull();
  });
});

describe("dashboard + visualization projections", () => {
  it("graphView links learner -> skills and sessions -> skills", () => {
    const g = buildDemoSkillGraph("t-viz");
    const view = graphView(g);
    const kinds = new Set(view.nodes.map((n) => n.kind));
    expect(kinds).toContain("learner");
    expect(kinds).toContain("skill");
    expect(kinds).toContain("session");
    const ids = new Set(view.nodes.map((n) => n.id));
    for (const e of view.edges) {
      expect(ids.has(e.from)).toBe(true);
      expect(ids.has(e.to)).toBe(true);
    }
  });

  it("buildDashboard orders sessions chronologically and computes overall confidence", () => {
    const d = buildDashboard(buildDemoSkillGraph("t-dash"));
    expect(d.sessionCount).toBe(3);
    expect(d.overallConfidence).toBeGreaterThan(0);
    const dates = d.sessions.map((s) => s.completedAt);
    expect([...dates].sort()).toEqual(dates);
    expect(d.trend.map((t) => t.confidence)).toEqual([52, 64, 71]); // the demo growth arc
  });

  it("an empty graph produces an empty dashboard", () => {
    const d = buildDashboard(emptySkillGraph("t-empty", null, new Date().toISOString()));
    expect(d.sessionCount).toBe(0);
    expect(d.skillCount).toBe(0);
    expect(d.overallConfidence).toBe(0);
  });
});

describe("cognee serialization", () => {
  it("serializes normalized skill statements, never raw transcripts", async () => {
    const { graph } = await rememberSession({ learnerId: "t-cognee", name: "Asha", session: sampleSession() });
    const session = Object.values(graph.sessions)[0];
    const text = serializeSessionForCognee("t-cognee", session, graph);
    expect(text).toContain("Learner Asha");
    expect(text).toContain('practiced the communication skill "persuasion"');
    expect(text).toContain("weakness in filler words");
    // Privacy: what the learner literally said must never leave the device.
    expect(text).not.toContain("communication gym powered by AI coaching");
  });
});
