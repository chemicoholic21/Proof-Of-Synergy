/**
 * Derived read-models for the Communication Skill Dashboard. Everything here is computed from the
 * graph - no view has its own store - so the dashboard is always a faithful projection of memory.
 */

import { CommunicationGraph, GNode, ID, NodeKind } from "./graph/model";
import { clock, daysBetween, edgesFrom, edgesTo, nodesByKind } from "./graph/ops";
import { currentRetention } from "./recall";
import { evidenceForSkill, EvidenceItem } from "./evidence";
import { communicationTrend } from "./communication-metrics";
import { stalenessLabel } from "./skills";

// ---- Growth Insights (positive framing, always) ----
export type GrowthTier = "strong" | "developing" | "needs-practice";

export interface GrowthInsightItem {
  skill: string;
  level: number;
  confidence: number;
  retention: number;
  tier: GrowthTier;
  evidence: EvidenceItem[];
  suggestedAction: string;
}

export function growthInsights(g: CommunicationGraph): GrowthInsightItem[] {
  const now = clock();
  return nodesByKind(g, "skill").map((s) => {
    const bundle = evidenceForSkill(g, s.label, now);
    const demonstrated = edgesFrom(g, s.id, "DEMONSTRATED_IN").length > 0;
    const retention = currentRetention(s, now);
    let tier: GrowthTier;
    let action: string;
    if (demonstrated && s.confidence >= 78) {
      tier = "strong";
      action = retention < 60 ? `Keep ${s.label} fresh - a quick practice session will re-verify it.` : `${s.label} is well demonstrated. Ready to showcase.`;
    } else if (demonstrated && s.confidence >= 55) {
      tier = "developing";
      action = `Practice ${s.label} once more to move it into strong.`;
    } else {
      tier = "needs-practice";
      action = demonstrated
        ? `Reinforce ${s.label} with a focused practice session, then practice again.`
        : `Practice ${s.label} to turn potential into demonstrated skill.`;
    }
    return { skill: s.label, level: s.level, confidence: s.confidence, retention, tier, evidence: bundle.items, suggestedAction: action };
  }
}

// ---- Skill progress cards (Feature 1: Persistent Skill Verification) ----
export interface SkillProgress {
  skill: string;
  level: number;
  confidence: number;
  retention: number;
  timesPracticed: number;
  supportingScenarios: string[];
  lastSeen: string;
  trend: number[]; // confidence per session it appeared in
}

export function skillProgress(g: CommunicationGraph): SkillProgress[] {
  const now = clock();
  return nodesByKind(g, "skill").map((s) => {
    const scenarios = edgesTo(g, s.id, "DEMONSTRATED_IN")
      .map((e) => g.nodes[e.from]?.data.scenarioId)
      .filter((sc): sc is string => Boolean(sc));
    const trend = edgesFrom(g, s.id, "DEMONSTRATED_IN")
      .map((e) => (e.data?.confidence as number) ?? 0)
      .filter((x) => x > 0);
    return {
      skill: s.label,
      level: s.level,
      confidence: s.confidence,
      retention: currentRetention(s, now),
      timesPracticed: scenarios.length,
      supportingScenarios: [...new Set(scenarios)],
      lastSeen: stalenessLabel(daysBetween(now, s.lastSeenAt)),
      trend,
    };
  }
}

// ---- Communication trend (Voice Memory) ----
export interface CommunicationPoint extends ReturnType<typeof extractCommunicationDNA> {
  sessionIndex: number;
  timestamp: string;
}
export function communicationTrend(g: CommunicationGraph): CommunicationPoint[] {
  return nodesByKind(g, "communication")
    .map((n) => ({ ...(n.data as unknown as ReturnType<typeof extractCommunicationDNA>), sessionIndex: (n.data.sessionIndex as number) ?? 0, timestamp: (n.data.timestamp as string) ?? n.createdAt }))
    .sort((a, b) => (a.timestamp ?? "").localeCompare(b.timestamp ?? ""));
}

// ---- Practice timeline (Feature 2) ----
export interface TimelineEvent {
  date: string;
  kind: "session" | "milestone";
  title: string;
  detail: string;
}
export function practiceTimeline(g: CommunicationGraph): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  for (const s of nodesByKind(g, "session"))
    events.push({ date: (s.data.startedAt as string) ?? s.createdAt, kind: "session", title: s.label, detail: `Scenario: ${s.data.scenarioId ?? "unknown"} · ${s.data.messageCount ?? 0} messages` });
  for (const m of nodesByKind(g, "milestone"))
    events.push({ date: (m.data.date as string) ?? m.createdAt, kind: "milestone", title: m.label, detail: "Improvement recorded" });
  return events.sort((a, b) => a.date.localeCompare(b.date));
}

// ---- Improvement timeline per skill (Digital Skill DNA) ----
export interface ImprovementSeries {
  skill: string;
  points: number[];
}
export function improvementTimeline(g: CommunicationGraph): ImprovementSeries[] {
  return nodesByKind(g, "skill")
    .map((s) => ({ skill: s.label, points: edgesFrom(g, s.id, "DEMONSTRATED_IN").map((e) => (e.data?.confidence as number) ?? 0).filter((x) => x > 0) }))
    .filter((s) => s.points.length >= 1);
}

// ---- Memory Replay: every message to a skill across all sessions ----
export interface ReplayEntry {
  sessionIndex: number;
  messageId: string;
  content: string;
  confidence: number;
}
export function memoryReplay(g: CommunicationGraph, skillOrScenario: string): ReplayEntry[] {
  const target = skillOrScenario.toLowerCase();
  const entries: ReplayEntry[] = [];
  for (const msg of nodesByKind(g, "message")) {
    const ts = (msg.data.role as string) ?? "";
    if (ts.toLowerCase() !== target) continue;
    // find the session index + the message
    const sessionEdge = edgesTo(g, msg.id, "BELONGS_TO").map((e) => g.nodes[e.from]).find((n) => n?.kind === "session");
    entries.push({
      sessionIndex: (sessionEdge?.data.index as number) ?? 0,
      messageId: msg.data.messageId as string,
      content: (msg.data.text as string) ?? msg.label,
      confidence: (msg.data.confidence as number) ?? 0,
    });
  }
  return entries.sort((a, b) => a.sessionIndex - b.sessionIndex);
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
export function graphView(g: CommunicationGraph): GraphView {
  const keepKinds: NodeKind[] = ["learner", "skill", "session", "scenario", "recommendation", "resource"];
  const now = clock();
  const nodes = Object.values(g.nodes)
    .filter((n) => keepKinds.includes(n.kind))
    // trim derived-but-untouched skills to keep the picture legible
    .filter((n) => !(n.kind === "skill" && n.weight === 0 && edgesTo(g, n.id, "DEMONSTRATED_IN").length === 0))
    .map<VizNode>((n) => ({
      id: n.id,
      kind: n.kind,
      label: n.label,
      confidence: n.kind === "skill" || n.kind === "session" ? n.confidence : n.confidence,
      retention: n.kind === "skill" ? currentRetention(n, now) : n.retention,
      weight: n.weight,
      weak: (n.kind === "skill" || n.kind === "session") && edgesTo(g, n.id, "DEMONSTRATED_IN").length > 0 && n.confidence < 55,
      strong: (n.kind === "skill" || n.kind === "session") && n.confidence >= 78,
    }));
  const keep = new Set(nodes.map((n) => n.id));
  const edges = Object.values(g.edges)
    .filter((e) => keep.has(e.from) && keep.has(e.to))
    .map<VizEdge>((e) => ({ from: e.from, to: e.to, type: e.type }));
  return { nodes, edges };
}

// ---- Top-level dashboard bundle ----
export interface Dashboard {
  learnerId: string;
  name: string | null;
  revision: number;
  sessionCount: number;
  overallConfidence: number;
  growthInsights: GrowthInsightItem[];
  skillProgress: SkillProgress[];
  communication: CommunicationPoint[];
  timeline: TimelineEvent[];
  improvement: ImprovementSeries[];
  graph: GraphView;
}
export function buildDashboard(g: CommunicationGraph): Dashboard {
  const skills = nodesByKind(g, "skill");
  const practiced = skills.filter((s) => edgesFrom(g, s.id, "DEMONSTRATED_IN").length > 0);
  const overallConfidence = practiced.length
    ? Math.round(practiced.reduce((a, s) => a + s.confidence, 0) / practiced.length)
    : 0;
  return {
    learnerId: g.learnerId,
    name: g.name,
    revision: g.revision,
    sessionCount: nodesByKind(g, "session").length,
    overallConfidence,
    growthInsights: growthInsights(g),
    skillProgress: skillProgress(g),
    communication: communicationTrend(g),
    timeline: practiceTimeline(g),
    improvement: improvementTimeline(g),
    graph: graphView(g),
  };
}

void ID;