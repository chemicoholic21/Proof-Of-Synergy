/**
 * Evidence engine — every score and every recommendation must be traceable.
 *
 * Given a skill/concept node, gather the concrete evidence backing its confidence: interview
 * answers, resume claims, projects that use it, GitHub signals (when present). The UI never shows a
 * bare "87%"; it shows the bullet list this produces, so a judge can always ask "why?" and get an
 * answer grounded in the graph.
 */

import { CareerGraph, GNode, ID } from "./graph/model";
import { clock, daysBetween, edgesFrom, edgesTo } from "./graph/ops";
import { stalenessLabel } from "./concepts";

export interface EvidenceItem {
  kind: "interview" | "resume" | "project" | "github" | "communication" | "retention";
  text: string;
  positive: boolean;
  score?: number;
}

export interface EvidenceBundle {
  subject: string;
  confidence: number;
  claimedLevel: string | null;
  items: EvidenceItem[];
}

/** Collect evidence for a skill node (by label). */
export function evidenceForSkill(g: CareerGraph, skillLabel: string, now = clock()): EvidenceBundle {
  const skillId = ID.skill(skillLabel);
  const node = g.nodes[skillId];
  if (!node) return { subject: skillLabel, confidence: 0, claimedLevel: null, items: [] };
  return gatherEvidence(g, node, now);
}

export function gatherEvidence(g: CareerGraph, node: GNode, now = clock()): EvidenceBundle {
  const items: EvidenceItem[] = [];
  const claimedLevel = (node.data.claimedLevel as string) ?? null;

  // Resume claim
  const claims = edgesTo(g, node.id, "CLAIMS");
  if (claims.length) {
    items.push({
      kind: "resume",
      text: `Resume claims ${claimedLevel ?? "this skill"}.`,
      positive: false,
    });
  }

  // Interview evidence (each answer is evidence)
  const evidenceNodes = edgesTo(g, node.id, "EVIDENCE_FOR")
    .map((e) => g.nodes[e.from])
    .filter((n): n is GNode => Boolean(n) && n.kind === "evidence");
  const interviewEv = evidenceNodes.filter((n) => n.data.source === "interview");
  const passed = interviewEv.filter((n) => (n.data.score as number) >= 65).length;
  const failed = interviewEv.filter((n) => (n.data.score as number) < 55).length;
  if (interviewEv.length) {
    if (passed)
      items.push({ kind: "interview", text: `Answered ${passed} interview question${passed > 1 ? "s" : ""} well.`, positive: true });
    if (failed)
      items.push({ kind: "interview", text: `Struggled on ${failed} interview question${failed > 1 ? "s" : ""}.`, positive: false });
  } else {
    items.push({ kind: "interview", text: "Never verified in an interview yet.", positive: false });
  }

  // Project evidence
  const projects = edgesTo(g, node.id, "USES").map((e) => g.nodes[e.from]).filter(Boolean);
  if (projects.length) {
    items.push({ kind: "project", text: `Used in ${projects.length} project${projects.length > 1 ? "s" : ""}.`, positive: true });
  }

  // GitHub evidence (present only if github memory was ingested)
  const github = evidenceNodes.filter((n) => n.data.source === "github");
  if (github.length) {
    items.push({ kind: "github", text: `${github.length} matching GitHub signal${github.length > 1 ? "s" : ""}.`, positive: true });
  }

  // Retention / recency
  const days = daysBetween(now, node.lastSeenAt);
  if (days > 30) {
    items.push({ kind: "retention", text: `Last reinforced ${stalenessLabel(days)}; retention decaying.`, positive: false });
  } else if (interviewEv.length) {
    items.push({ kind: "retention", text: `Recently reinforced (${stalenessLabel(days)}).`, positive: true });
  }

  return { subject: node.label, confidence: node.confidence, claimedLevel, items };
}
