/**
 * Recommendation engine - never recommends random resources.
 *
 * A skill is worth recommending only when it scores high on importance × need:
 *   importance  = graph weight (how central/how often practiced) + practice-frequency boost
 *   need        = (100 - confidence) blended with (100 - retention)
 *   relevance   = boosted if it maps to an upcoming scenario's expected skills
 *
 * Every recommendation carries the evidence bundle that justifies it, so the UI can render
 * "Improve Active Listening because: … / … / …" rather than a bare instruction.
 */

import { CommunicationGraph, GNode, ID } from "./graph/model";
import { clock, edgesTo, nodesByKind } from "./graph/ops";
import { currentRetention } from "./recall";
import { skillDef } from "./skills";
import { EvidenceBundle, gatherEvidence } from "./evidence";

export interface Recommendation {
  skill: string;
  priority: number; // 0-100
  confidence: number;
  retention: number;
  reason: string;
  evidence: EvidenceBundle;
  resources: { title: string; kind: "docs" | "video" | "exercise" | "quiz"; url?: string }[];
}

export function recommendations(g: CommunicationGraph, opts: { scenarioId?: string | null; limit?: number } = {}): Recommendation[] {
  const now = clock();
  const learnerId = ID.learner(g.learnerId);
  const recs: Recommendation[] = [];

  for (const s of nodesByKind(g, "skill")) {
    const practiced = edgesTo(g, s.id, "DEMONSTRATED_IN").length > 0;
    if (!practiced) continue; // only recommend skills that have been attempted
    
    const retention = currentRetention(s, now);
    const need = Math.round((100 - s.confidence) * 0.65 + (100 - retention) * 0.35);
    if (need < 30) continue; // already solid & fresh

    const importance = Math.min(100, (s.weight * 6) + (edgesFrom(g, s.id, "DEMONSTRATED_IN").length * 3));
    let priority = Math.round(need * 0.7 + importance * 0.3);

    // Scenario relevance boost.
    if (opts.scenarioId) {
      const scenarioSkills = scenarioSkillsMap[opts.scenarioId] || [];
      if (scenarioSkills.includes(s.label)) {
        priority = Math.min(100, priority + 15);
      }
    }

    const ev = gatherEvidence(g, s, now);
    recs.push({
      skill: s.label,
      priority: Math.min(100, priority),
      confidence: s.confidence,
      retention,
      reason: buildReason(s, retention),
      evidence: ev,
      resources: (skillDef(s.label).resources ?? []).map((r) => ({ title: r.title, kind: r.kind, url: r.url })),
    });
  }

  void learnerId;
  return recs.sort((a, b) => b.priority - a.priority).slice(0, opts.limit ?? 8);
}

function buildReason(s: GNode, retention: number): string {
  if (s.confidence < 55) return `Confidence is only ${s.confidence}% - needs more practice.`;
  if (retention < 55) return `Retention has decayed to ${retention}% since last practiced.`;
  return `High-value skill worth reinforcing (importance ${Math.min(100, s.weight * 6)}).`;
}

// Map of scenarios to the skills they typically exercise
const scenarioSkillsMap: Record<string, string[]> = {
  "public-speaking": ["Clarity", "Confidence", "Storytelling", "Active Listening"],
  "technical-interview": ["Technical Depth", "Problem Solving", "Communication", "Confidence"],
  "startup-pitch": ["Persuasion", "Vision", "Clarity", "Confidence"],
  "design-review": ["Technical Depth", "Communication", "Feedback", "Collaboration"],
  "product-demo": ["Clarity", "Persuasion", "Technical Depth", "Engagement"],
  "leadership": ["Empathy", "Communication", "Decision Making", "Conflict Resolution"],
  "viva": ["Technical Depth", "Critical Thinking", "Communication", "Confidence"],
};