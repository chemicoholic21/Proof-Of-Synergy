/**
 * Evidence engine - every score and every recommendation must be traceable.
 *
 * Given a skill node, gather the concrete evidence backing its confidence: session
 * messages, practice outcomes. The UI never shows a bare "87%"; it shows the bullet list this
 * produces, so a coach can always ask "why?" and get an answer grounded in the graph.
 */

import { CommunicationGraph, GNode, ID } from "./graph/model";
import { clock, daysBetween, edgesFrom, edgesTo } from "./graph/ops";
import { stalenessLabel } from "./skills";

export interface EvidenceItem {
  kind: "session" | "message" | "practice" | "retention";
  text: string;
  positive: boolean;
  score?: number;
}

export interface EvidenceBundle {
  subject: string;
  confidence: number;
  level: string | null;
  items: EvidenceItem[];
}

/** Collect evidence for a skill node (by label). */
export function evidenceForSkill(g: CommunicationGraph, skillLabel: string, now = clock()): EvidenceBundle {
  const skillId = ID.skill(skillLabel);
  const node = g.nodes[skillId];
  if (!node) return { subject: skillLabel, confidence: 0, level: null, items: [] };
  return gatherEvidence(g, node, now);
}

export function gatherEvidence(g: CommunicationGraph, node: GNode, now = clock()): EvidenceBundle {
  const items: EvidenceItem[] = [];
  const level = (node.data.level as string) ?? null;

  // Session evidence (each completed session is evidence)
  const sessionEvidence = edgesFrom(g, node.id, "DEMONSTRATED_IN")
    .map((e) => g.nodes[e.to])
    .filter((n): n is GNode => Boolean(n) && n.kind === "session");
  const recentSessions = sessionEvidence.filter((s) => {
    const endedAt = s.data.endedAt || s.data.startedAt;
    return daysBetween(now, endedAt) < 30;
  });
  if (recentSessions.length) {
    items.push({ kind: "session", text: `Practiced in ${recentSessions.length} session${recentSessions.length > 1 ? "s" : ""} in the last month.`, positive: true });
  } else if (sessionEvidence.length) {
    items.push({ kind: "session", text: `Has ${sessionEvidence.length} session${sessionEvidence.length > 1 ? "s" : ""} in history.`, positive: true });
  } else {
    items.push({ kind: "session", text: "No practice sessions recorded for this skill yet.", positive: false });
  }

  // Message evidence (specific examples of good/needs-improvement communication)
  const messageEvidence = edgesTo(g, node.id, "DEMONSTRATES")
    .map((e) => g.nodes[e.from])
    .filter((n): n is GNode => Boolean(n) && n.kind === "message");
  const clearMessages = messageEvidence.filter((m) => {
    const text = m.data.text.toLowerCase();
    const fillerCount = (text.match(/\b(um|uh|erm|hmm|like|basically|actually|kind of|sort of|you know|i mean|so yeah|literally)\b/gi) || []).length;
    return fillerCount < 3; // Arbitrary threshold for "clear"
  });
  if (clearMessages.length) {
    items.push({ kind: "message", text: `Demonstrated clear communication in ${clearMessages.length} message${clearMessages.length > 1 ? "s" : ""}.`, positive: true });
  }
  const fillerMessages = messageEvidence.filter((m) => {
    const text = m.data.text.toLowerCase();
    const fillerCount = (text.match(/\b(um|uh|erm|hmm|like|basically|actually|kind of|sort of|you know|i mean|so yeah|literally)\b/gi) || []).length;
    return fillerCount >= 5;
  });
  if (fillerMessages.length) {
    items.push({ kind: "message", text: `Showed heavy filler word use in ${fillerMessages.length} message${fillerMessages.length > 1 ? "s" : ""}.`, positive: false });
  }

  // Practice frequency / recency
  const daysSinceLastPractice = sessionEvidence.length > 0
    ? Math.min(...sessionEvidence.map(s => daysBetween(now, s.data.endedAt || s.data.startedAt)))
    : 999;
  if (daysSinceLastPractice > 30) {
    items.push({ kind: "retention", text: `Last practiced ${stalenessLabel(daysSinceLastPractice)}; skill may be decaying.`, positive: false });
  } else if (sessionEvidence.length > 0) {
    items.push({ kind: "retention", text: `Recently practiced (${stalenessLabel(daysSinceLastPractice)}).`, positive: true });
  }

  return { subject: node.label, confidence: node.confidence, level, items };
}