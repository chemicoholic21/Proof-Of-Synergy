/**
 * Public surface of the memory service layer. The rest of the app imports ONLY from here (never
 * from Cognee directly, never from the individual graph internals) so Cognee stays the application's
 * brain behind one clean abstraction.
 */

export { ingestResume, ingestInterview, reason, dashboard, forgetMemory } from "./orchestrator";
export { recall } from "./recall";
export { buildDashboard, graphView, memoryReplay, realityGap } from "./derive";
export { recommendations } from "./recommendations";
export { learningMissions } from "./learning";
export { evidenceForSkill } from "./evidence";
export { cogneeConfigured } from "./cognee/client";

export type { RecallResult, RememberInterviewInput, RememberResumeInput, RememberAnswer } from "./types";
export type { Dashboard, RealityGapItem, SkillCard, GraphView, VizNode, VizEdge, ReplayEntry } from "./derive";
export type { Recommendation } from "./recommendations";
export type { LearningMission } from "./learning";
export type { ForgetTarget } from "./forget";
export type { CareerGraph } from "./graph/model";

/** Generate a stable, URL-safe candidate id from an email or name (client stores it in localStorage). */
export function candidateIdFrom(seed: string): string {
  const base = seed.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return (base || "candidate").slice(0, 60);
}
