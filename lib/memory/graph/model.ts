/**
 * Canonical Communication Skill Graph model.
 *
 * This is the stable contract for the whole memory layer. The *representation* (how it is stored,
 * whether it is mirrored into Cognee) may evolve, but these entity kinds and relationship types are
 * the vocabulary the rest of the app reasons in. Nodes are meaning, edges are the product - we
 * never flatten a relationship into a JSON blob.
 */

export type NodeKind =
  | "learner"
  | "skill"
  | "concept"
  | "session"
  | "scenario"
  | "answer"
  | "evidence"
  | "communication"
  | "resource"
  | "recommendation"
  | "milestone";

export type EdgeType =
  | "PRACTICES"
  | "DEMONSTRATED_IN"
  | "EVIDENCE_FOR"
  | "WEAK_IN"
  | "STRONG_IN"
  | "RELATED_TO"
  | "PREREQ_OF"
  | "IMPROVES"
  | "RECOMMENDS"
  | "UPDATES_COMMUNICATION"
  | "TESTS"
  | "ANSWERS"
  | "RETENTION_DECAY";

export type SkillLevel = "beginner" | "intermediate" | "advanced" | "expert";

/**
 * A node in the communication skill graph. `weight` is reinforcement (how many times this has been
 * encountered / how important it is). `confidence` is the system's current belief in the learner's
 * command of the node (0-100). `retention` decays with time-since-last-seen for skills/concepts.
 */
export interface GNode {
  id: string;
  kind: NodeKind;
  label: string;
  weight: number;
  confidence: number; // 0-100
  retention: number; // 0-100 (100 = freshly reinforced)
  data: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string; // drives retention decay
}

export interface GEdge {
  id: string;
  from: string;
  to: string;
  type: EdgeType;
  weight: number;
  data?: Record<string, unknown>;
  createdAt: string;
}

export interface CommGraph {
  learnerId: string;
  name: string | null;
  nodes: Record<string, GNode>;
  edges: Record<string, GEdge>;
  createdAt: string;
  updatedAt: string;
  /** Monotonic counter of remember()/improve() cycles - a cheap "how much has this person grown". */
  revision: number;
  /** Bumped whenever the on-disk shape changes so old files can be migrated. */
  schemaVersion: number;
}

export const SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Deterministic, mergeable identifiers.
//
// Skills / concepts collapse to a slug so the SAME real-world entity is ONE node no
// matter how many sessions mention it - that is what makes the graph accumulate meaning
// instead of piling up duplicates. Per-event entities (sessions, scenarios, answers)
// carry their own scope so history is preserved.
// ---------------------------------------------------------------------------

export function slug(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "unknown";
}

export const ID = {
  learner: (learnerId: string) => `learner:${learnerId}`,
  skill: (name: string) => `skill:${slug(name)}`,
  concept: (name: string) => `concept:${slug(name)}`,
  session: (learnerId: string, n: number) => `session:${learnerId}:${n}`,
  scenario: (sessionId: string, sid: number | string) => `scenario:${sessionId}:${sid}`,
  answer: (sessionId: string, sid: number | string) => `answer:${sessionId}:${sid}`,
  communication: (sessionId: string) => `comm:${sessionId}`,
  resource: (concept: string) => `resource:${slug(concept)}`,
  evidence: (subjectId: string, kind: string, ref: string) => `evidence:${subjectId}:${slug(kind)}:${slug(ref)}`,
  recommendation: (concept: string) => `rec:${slug(concept)}`,
  milestone: (learnerId: string, skill: string, idx: number) => `milestone:${learnerId}:${slug(skill)}:${idx}`,
  edge: (from: string, type: EdgeType, to: string) => `${from}|${type}|${to}`,
};

export function emptyGraph(learnerId: string, name: string | null, now: string): CommGraph {
  return {
    learnerId,
    name,
    nodes: {},
    edges: {},
    createdAt: now,
    updatedAt: now,
    revision: 0,
    schemaVersion: SCHEMA_VERSION,
  };
}
