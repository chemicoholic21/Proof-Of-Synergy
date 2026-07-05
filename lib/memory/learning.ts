/**
 * Learning engine - closes the feedback loop. A weakness is not an endpoint; it becomes a mission:
 *   concept → read → practice → quiz → re-interview → improvement recorded.
 *
 * Missions are derived from the top recommendations and carry a spaced-repetition due date so the
 * NEXT interview can automatically check whether the mission moved the needle.
 */

import { CareerGraph } from "./graph/model";
import { Recommendation, recommendations } from "./recommendations";
import { conceptDef } from "./concepts";

export interface LearningStep {
  kind: "read" | "practice" | "quiz" | "interview";
  title: string;
  done: boolean;
}

export interface LearningMission {
  concept: string;
  title: string;
  estimatedMinutes: number;
  reason: string;
  priority: number;
  steps: LearningStep[];
  /** ISO date the concept should be re-tested (spaced repetition) */
  reviewDueInDays: number;
}

export function learningMissions(g: CareerGraph, opts: { company?: string | null; limit?: number } = {}): LearningMission[] {
  const recs = recommendations(g, { company: opts.company, limit: opts.limit ?? 5 });
  return recs.map((r) => missionFromRecommendation(r));
}

function missionFromRecommendation(r: Recommendation): LearningMission {
  const def = conceptDef(r.concept);
  const resources = def.resources ?? [
    { title: `Read the ${r.concept} fundamentals`, kind: "docs" as const },
    { title: `Build a small ${r.concept} exercise`, kind: "exercise" as const },
  ];
  const steps: LearningStep[] = [];
  for (const res of resources) {
    const kind: LearningStep["kind"] = res.kind === "quiz" ? "quiz" : res.kind === "exercise" ? "practice" : "read";
    steps.push({ kind, title: res.title, done: false });
  }
  steps.push({ kind: "interview", title: `Re-interview on ${r.concept} to confirm improvement`, done: false });

  // Half-life informs how soon to review - faster-decaying concepts come back sooner.
  const halfLife = def.halfLifeDays ?? 60;
  const reviewDueInDays = Math.max(3, Math.round(halfLife / 4));

  return {
    concept: r.concept,
    title: `Master ${r.concept}`,
    estimatedMinutes: 30 + steps.length * 10,
    reason: r.reason,
    priority: r.priority,
    steps,
    reviewDueInDays,
  };
}
