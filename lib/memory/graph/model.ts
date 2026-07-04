/**
 * Canonical Career Knowledge Graph model.
 *
 * This is the stable contract for the whole memory layer. The *representation* (how it is stored,
 * whether it is mirrored into Cognee) may evolve, but these entity kinds and relationship types are
 * the vocabulary the rest of the app reasons in. Nodes are meaning, edges are the product — we
 * never flatten a relationship into a JSON blob.
 */

export type NodeKind =
  | "candidate"
  | "resume"
  | "skill"
  | "concept"
  | "project"
  | "technology"
  | "company"
  | "interview"
  | "question"
  | "answer"
  | "evidence"
  | "communication" // Interview DNA / communication metric snapshot
  | "resource" // learning resource / mission
  | "recommendation"
  | "milestone";

export type EdgeType =
  | "OWNS" // candidate -> resume / interview / project ...
  | "CLAIMS" // resume -> skill
  | "HAS_SKILL" // candidate -> skill
  | "USES" // project -> technology
  | "TESTS" // interview/question -> concept/skill
  | "ANSWERS" // answer -> question
  | "DEMONSTRATED_IN" // skill/concept -> interview
  | "EVIDENCE_FOR" // evidence -> skill/concept/claim
  | "WEAK_IN" // candidate -> concept
  | "STRONG_IN" // candidate -> concept
  | "RELATED_TO" // concept <-> concept
  | "PREREQ_OF" // concept -> concept
  | "IMPROVES" // resource -> skill/concept
  | "RECOMMENDS" // recommendation -> resource/concept
  | "DISCUSSED_IN" // project -> interview
  | "PREP_FOR" // interview/concept -> company
  | "UPDATES_COMMUNICATION" // communication -> candidate
  | "RETENTION_DECAY"; // bookkeeping edge candidate -> concept (spaced repetition)

export type SkillLevel = "beginner" | "intermediate" | "advanced" | "expert";

/**
 * A node in the career graph. `weight` is reinforcement (how many times this has been encountered /
 * how important it is). `confidence` is the system's current belief in the candidate's command of
 * the node (0-100). `retention` decays with time-since-last-seen for skills/concepts.
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

export interface CareerGraph {
  candidateId: string;
  name: string | null;
  nodes: Record<string, GNode>;
  edges: Record<string, GEdge>;
  createdAt: string;
  updatedAt: string;
  /** Monotonic counter of remember()/improve() cycles — a cheap "how much has this person grown". */
  revision: number;
  /** Bumped whenever the on-disk shape changes so old files can be migrated. */
  schemaVersion: number;
}

export const SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Deterministic, mergeable identifiers.
//
// Skills / concepts / technologies / companies collapse to a slug so the SAME real-world entity is
// ONE node no matter how many interviews mention it — that is what makes the graph accumulate
// meaning instead of piling up duplicates. Per-event entities (interviews, questions, answers)
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
  candidate: (candidateId: string) => `candidate:${candidateId}`,
  resume: (candidateId: string, version: number) => `resume:${candidateId}:v${version}`,
  skill: (name: string) => `skill:${slug(name)}`,
  concept: (name: string) => `concept:${slug(name)}`,
  technology: (name: string) => `tech:${slug(name)}`,
  company: (name: string) => `company:${slug(name)}`,
  project: (candidateId: string, name: string) => `project:${candidateId}:${slug(name)}`,
  interview: (candidateId: string, n: number) => `interview:${candidateId}:${n}`,
  question: (interviewId: string, qid: number | string) => `question:${interviewId}:${qid}`,
  answer: (interviewId: string, qid: number | string) => `answer:${interviewId}:${qid}`,
  communication: (interviewId: string) => `dna:${interviewId}`,
  resource: (concept: string) => `resource:${slug(concept)}`,
  evidence: (subjectId: string, kind: string, ref: string) => `evidence:${subjectId}:${slug(kind)}:${slug(ref)}`,
  recommendation: (concept: string) => `rec:${slug(concept)}`,
  edge: (from: string, type: EdgeType, to: string) => `${from}|${type}|${to}`,
};

export function emptyGraph(candidateId: string, name: string | null, now: string): CareerGraph {
  return {
    candidateId,
    name,
    nodes: {},
    edges: {},
    createdAt: now,
    updatedAt: now,
    revision: 0,
    schemaVersion: SCHEMA_VERSION,
  };
}
