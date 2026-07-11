/**
  * Public surface of the memory service layer. The rest of the app imports ONLY from here (never
  * from Cognee directly, never from the individual graph internals) so Cognee stays the application's
  * brain behind one clean abstraction.
  */

export { ingestSession, ingestSessionEvent, reason, dashboard, forgetMemory } from "./orchestrator";
export { recall } from "./recall";
export { buildDashboard, graphView, memoryReplay, growthInsights, skillProgress } from "./derive";
export { recommendations } from "./recommendations";
export { practiceMissions } from "./learning";
export { evidenceForSkill } from "./evidence";
export { cogneeConfigured } from "./cognee/client";

export type { RecallResult, RememberSessionInput, RememberAnswer } from "./types";
export type { Dashboard, GrowthInsight, SkillProgress, GraphView, VizNode, VizEdge, ReplayEntry } from "./derive";
export type { Recommendation } from "./recommendations";
export type { PracticeMission } from "./learning";
export type { ForgetTarget } from "./forget";
export type { CommGraph } from "./graph/model";

/** Generate a stable, URL-safe learner id from an email or name (client stores it in localStorage). */
export function learnerIdFrom(seed: string): string {
  const base = seed.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return (base || "learner").slice(0, 60);
}
