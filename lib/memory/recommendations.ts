/**
 * Recommendation engine — never recommends random resources.
 *
 * A concept is worth recommending only when it scores high on importance × need:
 *   importance  = graph weight (how central/how often encountered) + resume-claim boost
 *   need        = (100 - confidence) blended with (100 - retention)
 *   relevance   = boosted if it maps to an upcoming company's expected topics
 *
 * Every recommendation carries the evidence bundle that justifies it, so the UI can render
 * "Improve Docker because: … / … / …" rather than a bare instruction.
 */

import { CareerGraph, GNode, ID } from "./graph/model";
import { clock, edgesTo, nodesByKind } from "./graph/ops";
import { currentRetention } from "./recall";
import { conceptDef } from "./concepts";
import { EvidenceBundle, gatherEvidence } from "./evidence";

export interface Recommendation {
  concept: string;
  priority: number; // 0-100
  confidence: number;
  retention: number;
  reason: string;
  evidence: EvidenceBundle;
  resources: { title: string; kind: string }[];
}

export function recommendations(g: CareerGraph, opts: { company?: string | null; limit?: number } = {}): Recommendation[] {
  const now = clock();
  const candidateId = ID.candidate(g.candidateId);
  const recs: Recommendation[] = [];

  for (const c of nodesByKind(g, "concept")) {
    const tested = edgesTo(g, c.id, "TESTS").length > 0;
    if (!tested) continue;
    const retention = currentRetention(c, now);
    const need = Math.round((100 - c.confidence) * 0.65 + (100 - retention) * 0.35);
    if (need < 30) continue; // already solid & fresh

    const importance = Math.min(100, c.weight * 8 + (c.data.claimedExpectation ? 20 : 0));
    let priority = Math.round(need * 0.7 + importance * 0.3);

    // Company relevance boost.
    if (opts.company && conceptMatchesCompany(c.label, opts.company)) priority = Math.min(100, priority + 15);

    const ev = gatherEvidence(g, c, now);
    recs.push({
      concept: c.label,
      priority: Math.min(100, priority),
      confidence: c.confidence,
      retention,
      reason: buildReason(c, retention),
      evidence: ev,
      resources: (conceptDef(c.label).resources ?? []).map((r) => ({ title: r.title, kind: r.kind })),
    });
  }

  void candidateId;
  return recs.sort((a, b) => b.priority - a.priority).slice(0, opts.limit ?? 8);
}

function buildReason(c: GNode, retention: number): string {
  if (c.confidence < 55) return `Confidence is only ${c.confidence}% — repeated weakness.`;
  if (retention < 55) return `Retention has decayed to ${retention}% since last practised.`;
  return `High-value concept worth reinforcing (importance ${Math.min(100, c.weight * 8)}).`;
}

const COMPANY_TOPICS: Record<string, string[]> = {
  google: ["system design", "distributed systems", "algorithms", "scalability", "behavioral"],
  amazon: ["system design", "leadership", "behavioral", "scalability", "ownership"],
  meta: ["system design", "react", "scalability", "behavioral"],
  stripe: ["system design", "api design", "idempotency", "distributed systems", "reliability"],
  microsoft: ["system design", "algorithms", "behavioral"],
  netflix: ["distributed systems", "microservices", "scalability", "resilience"],
  uber: ["system design", "distributed systems", "geospatial", "scalability"],
  nvidia: ["concurrency", "gpu", "systems", "performance"],
};

function conceptMatchesCompany(concept: string, company: string): boolean {
  const topics = COMPANY_TOPICS[company.toLowerCase().trim()] ?? [];
  const c = concept.toLowerCase();
  return topics.some((t) => c.includes(t) || t.includes(c));
}

export { COMPANY_TOPICS };
