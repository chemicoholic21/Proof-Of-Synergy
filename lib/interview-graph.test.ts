import { describe, it, expect } from "vitest";
import { rememberSession, buildDashboard, buildDemoSkillGraph, fromClient } from "./skill-graph";
import type { SessionResult } from "./types";
import { extractDNA } from "./communication-metrics";

function interviewSession(text: string): SessionResult {
  const metrics = extractDNA(text, 120);
  return {
    scenarioId: "technical-interview",
    durationSec: 120,
    messages: [
      { role: "assistant", content: "Walk me through your proudest project.", timestamp: 1 },
      { role: "user", content: text, timestamp: 2 },
      { role: "assistant", content: "What was the hardest part?", timestamp: 3 },
    ],
    coachingEvents: [],
    metrics,
    summary: "Solid answers; go deeper on trade-offs.",
  };
}

function findBad(obj: unknown, path = "$"): string[] {
  const bad: string[] = [];
  if (typeof obj === "number" && !Number.isFinite(obj)) bad.push(`${path} = ${obj}`);
  else if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) bad.push(...findBad(v, `${path}.${k}`));
  }
  return bad;
}

describe("interview session -> skill graph", () => {
  it("remembers an interview on top of the seeded demo graph without producing NaN/broken data", async () => {
    // Simulate the real client path: seeded graph in localStorage -> sent to server -> round-tripped.
    const learnerId = "repro-user";
    const seeded = buildDemoSkillGraph(learnerId, "Repro");
    const clientGraph = JSON.parse(JSON.stringify(seeded)); // localStorage round-trip

    const { graph } = await rememberSession({
      learnerId,
      session: interviewSession("I built a payments platform in Go. I designed the ledger and chose Postgres."),
      graph: fromClient(learnerId, clientGraph),
    });

    // Round-trip the returned graph the way saveGraphLocal/loadGraphLocal would.
    const persisted = JSON.parse(JSON.stringify(graph));
    const dashboard = buildDashboard(fromClient(learnerId, persisted)!);

    const bad = [...findBad(persisted, "graph"), ...findBad(dashboard, "dashboard")];
    expect(bad).toEqual([]);
    expect(Number.isFinite(dashboard.overallConfidence)).toBe(true);
    // interview session should be present and reference valid skills
    const iv = Object.values(graph.sessions).find((s) => s.scenarioId === "technical-interview");
    expect(iv).toBeTruthy();
    for (const sk of iv!.skills) expect(graph.skills[sk]).toBeTruthy();
    // every graph-view edge must point at a node that exists (no dangling edges -> broken render)
    const ids = new Set(dashboard.graph.nodes.map((n) => n.id));
    const dangling = dashboard.graph.edges.filter((e) => !ids.has(e.from) || !ids.has(e.to));
    // NOTE: category/topic edges are allowed to target category/topic nodes that DO exist;
    // report any that don't.
    expect(dangling.map((e) => `${e.from}->${e.to}`)).toEqual([]);
  });

  it("handles a first-ever interview with no prior graph", async () => {
    const { graph } = await rememberSession({
      learnerId: "fresh-user",
      session: interviewSession("Short answer."),
      graph: fromClient("fresh-user", null),
    });
    const dashboard = buildDashboard(graph);
    expect(findBad(dashboard)).toEqual([]);
    expect(dashboard.sessionCount).toBe(1);
  });
});
