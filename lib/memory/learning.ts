/**
 * Learning engine - closes the feedback loop. A weakness is not an endpoint; it becomes a mission:
 *   skill → learn → practice → refine → mastery achieved.
 *
 * Missions are derived from the top recommendations and carry a spaced-repetition due date so the
 * NEXT practice session can automatically check whether the mission moved the needle.
 */

import { CommunicationGraph } from "./graph/model";
import { Recommendation, recommendations } from "./recommendations";
import { skillDef } from "./skills";

export interface LearningStep {
  kind: "learn" | "practice" | "refine" | "apply";
  title: string;
  description: string;
  done: boolean;
  estimatedMinutes: number;
}

export interface LearningMission {
  skill: string;
  title: string;
  estimatedMinutes: number;
  reason: string;
  priority: number;
  steps: LearningStep[];
  /** ISO date the skill should be re-practiced (spaced repetition) */
  reviewDueInDays: number;
}

export function learningMissions(g: CommunicationGraph, opts: { scenarioId?: string | null; limit?: number } = {}): LearningMission[] {
  const recs = recommendations(g, { scenarioId: opts.scenarioId, limit: opts.limit ?? 5 });
  return recs.map((r) => missionFromRecommendation(r));
}

function missionFromRecommendation(r: Recommendation): LearningMission {
  const def = skillDef(r.skill);
  const resources = def.resources ?? [
    { title: `Learn the fundamentals of ${r.skill}`, kind: "docs" as const },
    { title: `Practice ${r.skill} in low-stakes situations`, kind: "practice" as const },
  ];
  const steps: LearningStep[] = [];
  for (const res of resources) {
    const kind: LearningStep["kind"] = res.kind === "quiz" ? "refine" : res.kind === "exercise" ? "practice" : "learn";
    steps.push({ 
      kind, 
      title: res.title, 
      description: getDescriptionForResource(res),
      done: false,
      estimatedMinutes: estimateTimeForResource(res)
    });
  }
  steps.push({ 
    kind: "apply", 
    title: `Apply ${r.skill} in a real practice session`, 
    description: `Use what you've learned in your next practice opportunity`,
    done: false,
    estimatedMinutes: 20
  });

  // Half-life informs how soon to review - faster-decaying skills come back sooner.
  const halfLife = def.halfLifeDays ?? 30;
  const reviewDueInDays = Math.max(2, Math.round(halfLife / 3));

  return {
    skill: r.skill,
    title: `Develop ${r.skill}`,
    estimatedMinutes: 30 + steps.length * 10,
    reason: r.reason,
    priority: r.priority,
    steps,
    reviewDueInDays,
  };
}

function getDescriptionForResource(res: { title: string; kind: string; url?: string }): string {
  switch (res.kind) {
    case "docs": return "Read articles, guides, or documentation";
    case "video": return "Watch instructional videos or demonstrations";
    case "exercise": return "Complete hands-on exercises or drills";
    default: return "Engage with learning material";
  }
}

function estimateTimeForResource(res: { title: string; kind: string; url?: string }): number {
  switch (res.kind) {
    case "docs": return 15;
    case "video": return 10;
    case "exercise": return 20;
    default: return 10;
  }
}

export { LEARNING_STEPS };