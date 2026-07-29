import { describe, it, expect } from "vitest";
import { fromClient, buildDemoSkillGraph } from "./skill-graph";

function skill(name: string) {
  return {
    id: `skill:${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    name,
    category: "x",
    level: "beginner" as const,
    confidence: 50,
    exposure: 1,
    sessions: 1,
    lastPracticedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("skill graph sanitization", () => {
  it("strips meta tags and scenario titles from a legacy graph, keeping real skills", () => {
    const s = (n: string) => skill(n);
    const graph = {
      learnerId: "x",
      name: null,
      skills: {
        [s("technical").id]: s("technical"),
        [s("resume").id]: s("resume"),
        [s("interview").id]: s("interview"),
        [s("Technical Interview").id]: s("Technical Interview"),
        [s("Technical Deep Dive").id]: s("Technical Deep Dive"),
        [s("React").id]: s("React"),
        [s("PostgreSQL").id]: s("PostgreSQL"),
        [s("clarity").id]: s("clarity"),
      },
      sessions: {
        s1: {
          id: "s1",
          scenarioId: "technical-interview",
          scenarioTitle: "Technical Interview",
          completedAt: "2026-01-01T00:00:00.000Z",
          durationSec: 60,
          wordCount: 10,
          confidence: 60,
          fillerCount: 0,
          coachingEvents: 0,
          skills: [s("technical").id, s("Technical Interview").id, s("React").id, s("PostgreSQL").id],
          topics: [],
          summary: "",
        },
      },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      revision: 1,
      schemaVersion: 1,
    };

    const clean = fromClient("x", graph)!;
    const names = Object.values(clean.skills).map((k) => k.name).sort();
    expect(names).toEqual(["PostgreSQL", "React", "clarity"]);
    // session skill refs pruned to surviving skills only
    expect(clean.sessions.s1.skills.sort()).toEqual([s("PostgreSQL").id, s("React").id].sort());
  });

  it("demo seed contains no scenario-title or meta-tag skills", () => {
    const g = buildDemoSkillGraph("demo", "Demo");
    const bad = Object.values(g.skills)
      .map((k) => k.name)
      .filter((n) => ["technical", "interview", "resume"].includes(n.toLowerCase()) ||
        ["Technical Deep Dive", "Technical Interview", "Startup Pitch", "Product Demo", "Public Speaking", "Leadership Conversation", "Engineering Design Review", "College Viva / Thesis Defense"].includes(n));
    expect(bad).toEqual([]);
  });
});
