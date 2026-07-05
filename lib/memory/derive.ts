/**
 * Derived read-models for the Career Intelligence Dashboard. Everything here is computed from the
 * graph - no view has its own store - so the dashboard is always a faithful projection of memory.
 */

import { CareerGraph, GNode, ID, NodeKind } from "./graph/model";
import { clock, daysBetween, edgesFrom, edgesTo, nodesByKind } from "./graph/ops";
import { currentRetention } from "./recall";
import { evidenceForSkill, EvidenceItem } from "./evidence";
import { InterviewDNA } from "./interview-memory";
import { stalenessLabel } from "./concepts";

// ---- Reality Gap (positive framing, always) ----
export type VerifiedTier = "highly-demonstrated" | "developing" | "needs-evidence";

export interface RealityGapItem {
  skill: string;
  claimedLevel: string | null;
  confidence: number;
  retention: number;
  tier: VerifiedTier;
  evidence: EvidenceItem[];
  recommendedAction: string;
}

export function realityGap(g: CareerGraph): RealityGapItem[] {
  const now = clock();
  return nodesByKind(g, "skill").map((s) => {
    const bundle = evidenceForSkill(g, s.label, now);
    const demonstrated = edgesFrom(g, s.id, "DEMONSTRATED_IN").length > 0;
    const retention = currentRetention(s, now);
    let tier: VerifiedTier;
    let action: string;
    if (demonstrated && s.confidence >= 75) {
      tier = "highly-demonstrated";
      action = retention < 60 ? `Keep ${s.label} fresh - a quick review interview will re-verify it.` : `${s.label} is well evidenced. Ready to showcase.`;
    } else if (demonstrated && s.confidence >= 50) {
      tier = "developing";
      action = `Practice ${s.label} once more to move it into highly-demonstrated.`;
    } else {
      tier = "needs-evidence";
      action = demonstrated
        ? `Reinforce ${s.label} with a focused practice session, then re-interview.`
        : `Verify ${s.label} in an interview to turn the claim into evidence.`;
    }
    return { skill: s.label, claimedLevel: bundle.claimedLevel, confidence: s.confidence, retention, tier, evidence: bundle.items, recommendedAction: action };
  });
}

// ---- Skill evidence cards (Feature 1: Persistent Skill Verification) ----
export interface SkillCard {
  skill: string;
  claimedLevel: string | null;
  confidence: number;
  retention: number;
  timesTested: number;
  supportingProjects: string[];
  githubEvidence: number;
  lastSeen: string;
  trend: number[]; // confidence per interview it appeared in
}

export function skillCards(g: CareerGraph): SkillCard[] {
  const now = clock();
  return nodesByKind(g, "skill").map((s) => {
    const projects = edgesTo(g, s.id, "USES").map((e) => g.nodes[e.from]?.label).filter(Boolean) as string[];
    const github = edgesTo(g, s.id, "EVIDENCE_FOR")
      .map((e) => g.nodes[e.from])
      .filter((n): n is GNode => Boolean(n) && n.data?.source === "github").length;
    const trend = edgesFrom(g, s.id, "DEMONSTRATED_IN")
      .map((e) => (e.data?.score as number) ?? 0)
      .filter((x) => x > 0);
    return {
      skill: s.label,
      claimedLevel: (s.data.claimedLevel as string) ?? null,
      confidence: s.confidence,
      retention: currentRetention(s, now),
      timesTested: (s.data.timesTested as number) ?? 0,
      supportingProjects: projects,
      githubEvidence: github,
      lastSeen: stalenessLabel(daysBetween(now, s.lastSeenAt)),
      trend,
    };
  });
}

// ---- Communication trend (Voice Memory) ----
export interface CommunicationPoint extends InterviewDNA {
  interviewIndex: number;
  date: string;
}
export function communicationTrend(g: CareerGraph): CommunicationPoint[] {
  return nodesByKind(g, "communication")
    .map((n) => ({ ...(n.data as unknown as InterviewDNA), interviewIndex: (n.data.interviewIndex as number) ?? 0, date: (n.data.date as string) ?? n.createdAt }))
    .sort((a, b) => a.interviewIndex - b.interviewIndex);
}

// ---- Career timeline (Feature 2) ----
export interface TimelineEvent {
  date: string;
  kind: "resume" | "interview" | "milestone";
  title: string;
  detail: string;
}
export function careerTimeline(g: CareerGraph): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  for (const r of nodesByKind(g, "resume"))
    events.push({ date: r.createdAt, kind: "resume", title: r.label, detail: `${(r.data.skillNames as string[] | undefined)?.length ?? 0} skills claimed` });
  for (const iv of nodesByKind(g, "interview"))
    events.push({ date: (iv.data.date as string) ?? iv.createdAt, kind: "interview", title: iv.label, detail: `Avg ${iv.data.avgScore ?? 0}% · ${iv.data.questionCount ?? 0} questions${iv.data.company ? ` · ${iv.data.company}` : ""}` });
  for (const m of nodesByKind(g, "milestone"))
    events.push({ date: (m.data.date as string) ?? m.createdAt, kind: "milestone", title: m.label, detail: "Improvement recorded" });
  return events.sort((a, b) => a.date.localeCompare(b.date));
}

// ---- Improvement timeline per skill (Digital Career DNA) ----
export interface ImprovementSeries {
  skill: string;
  points: number[];
}
export function improvementTimeline(g: CareerGraph): ImprovementSeries[] {
  return nodesByKind(g, "skill")
    .map((s) => ({ skill: s.label, points: edgesFrom(g, s.id, "DEMONSTRATED_IN").map((e) => (e.data?.score as number) ?? 0).filter((x) => x > 0) }))
    .filter((s) => s.points.length >= 1);
}

// ---- Memory Replay: every answer to a concept across all interviews ----
export interface ReplayEntry {
  interviewIndex: number;
  question: string;
  answer: string;
  score: number;
  feedback: string;
}
export function memoryReplay(g: CareerGraph, conceptOrSkill: string): ReplayEntry[] {
  const target = conceptOrSkill.toLowerCase();
  const entries: ReplayEntry[] = [];
  for (const q of nodesByKind(g, "question")) {
    const ts = (q.data.targetSkill as string) ?? "";
    if (ts.toLowerCase() !== target) continue;
    // find the interview index + the answer
    const interviewEdge = edgesTo(g, q.id, "TESTS").map((e) => g.nodes[e.from]).find((n) => n?.kind === "interview");
    const answer = edgesTo(g, q.id, "ANSWERS").map((e) => g.nodes[e.from]).find((n) => n?.kind === "answer");
    entries.push({
      interviewIndex: (interviewEdge?.data.index as number) ?? 0,
      question: (q.data.text as string) ?? q.label,
      answer: (answer?.data.transcript as string) ?? "",
      score: (q.data.score as number) ?? answer?.confidence ?? 0,
      feedback: (answer?.data.feedback as string) ?? "",
    });
  }
  return entries.sort((a, b) => a.interviewIndex - b.interviewIndex);
}

// ---- Graph visualization payload (user-facing, not a developer graph) ----
export interface VizNode {
  id: string;
  kind: NodeKind;
  label: string;
  confidence: number;
  retention: number;
  weight: number;
  weak: boolean;
  strong: boolean;
}
export interface VizEdge {
  from: string;
  to: string;
  type: string;
}
export interface GraphView {
  nodes: VizNode[];
  edges: VizEdge[];
}

/** A readable subset of the graph for visualization: the candidate, skills, top concepts, projects,
 *  companies, interviews and the recommendations - not every low-level answer/evidence node. */
export function graphView(g: CareerGraph): GraphView {
  const keepKinds: NodeKind[] = ["candidate", "skill", "concept", "project", "company", "interview", "recommendation", "resource"];
  const now = clock();
  const nodes = Object.values(g.nodes)
    .filter((n) => keepKinds.includes(n.kind))
    // trim derived-but-untouched concepts to keep the picture legible
    .filter((n) => !(n.kind === "concept" && n.weight === 0 && edgesTo(g, n.id, "TESTS").length === 0))
    .map<VizNode>((n) => ({
      id: n.id,
      kind: n.kind,
      label: n.label,
      confidence: n.confidence,
      retention: n.kind === "skill" || n.kind === "concept" ? currentRetention(n, now) : n.retention,
      weight: n.weight,
      weak: (n.kind === "skill" || n.kind === "concept") && edgesTo(g, n.id, "TESTS").length > 0 && n.confidence < 55,
      strong: (n.kind === "skill" || n.kind === "concept") && n.confidence >= 78,
    }));
  const keep = new Set(nodes.map((n) => n.id));
  const edges = Object.values(g.edges)
    .filter((e) => keep.has(e.from) && keep.has(e.to))
    .map<VizEdge>((e) => ({ from: e.from, to: e.to, type: e.type }));
  return { nodes, edges };
}

// ---- Top-level dashboard bundle ----
export interface Dashboard {
  candidateId: string;
  name: string | null;
  revision: number;
  interviewCount: number;
  overallConfidence: number;
  realityGap: RealityGapItem[];
  skills: SkillCard[];
  communication: CommunicationPoint[];
  timeline: TimelineEvent[];
  improvement: ImprovementSeries[];
  graph: GraphView;
}

export function buildDashboard(g: CareerGraph): Dashboard {
  const skills = nodesByKind(g, "skill");
  const demonstrated = skills.filter((s) => edgesFrom(g, s.id, "DEMONSTRATED_IN").length > 0);
  const overallConfidence = demonstrated.length
    ? Math.round(demonstrated.reduce((a, s) => a + s.confidence, 0) / demonstrated.length)
    : 0;
  return {
    candidateId: g.candidateId,
    name: g.name,
    revision: g.revision,
    interviewCount: nodesByKind(g, "interview").length,
    overallConfidence,
    realityGap: realityGap(g),
    skills: skillCards(g),
    communication: communicationTrend(g),
    timeline: careerTimeline(g),
    improvement: improvementTimeline(g),
    graph: graphView(g),
  };
}

void ID;
