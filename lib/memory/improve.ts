/**
  * improve() - the enrichment half of the lifecycle. Runs automatically after every interview.
  *
  * Does NOT merely save data; it makes the graph smarter:
  *   1. Connects concepts structurally (RELATED_TO + PREREQ_OF) so weaknesses form a sub-graph.
  *   2. Materializes retention decay onto skill/concept nodes (spaced-repetition state).
  *   3. Raises node weights for everything touched (reinforcement / importance).
  *   4. Emits evidence-backed recommendation + learning-resource nodes into the graph.
  *   5. Records improvement milestones when a concept's confidence rose vs its previous interview.
  *
  * Returns a diff summary so the UI can animate "the graph just grew" during the demo.
  */

import { CareerGraph, ID } from "./graph/model";
import { clock, edgesFrom, link, nodesByKind, upsertNode } from "./graph/ops";
import { conceptDef } from "./concepts";
import { currentRetention } from "./recall";
import { recommendations } from "./recommendations";

export interface ImproveSummary {
  newEdges: number;
  newRecommendations: number;
  milestones: string[];
  weakConceptsHighlighted: string[];
  revision: number;
}

export function improve(g: CareerGraph, opts: { company?: string | null } = {}): ImproveSummary {
  const now = clock();
  let newEdges = 0;
  const milestones: string[] = [];

  // 1 + 3: structural concept relationships + weight reinforcement.
  for (const c of nodesByKind(g, "concept")) {
    const def = conceptDef(c.label);
    for (const rel of def.related) {
      const rid = ID.concept(rel);
      if (!g.nodes[rid]) upsertNode(g, { id: rid, kind: "concept", label: rel, data: { derived: true }, weight: 0 });
      if (link(g, c.id, "RELATED_TO", rid)) newEdges++;
    }
    for (const pre of def.prereqs ?? []) {
      const pid = ID.concept(pre);
      if (!g.nodes[pid]) upsertNode(g, { id: pid, kind: "concept", label: pre, data: { derived: true }, weight: 0 });
      if (link(g, pid, "PREREQ_OF", c.id)) newEdges++;
    }
  }

  // 2: materialize retention decay so the stored graph reflects lifelong forgetting.
  for (const kind of ["skill", "concept"] as const) {
    for (const n of nodesByKind(g, kind)) {
      n.retention = currentRetention(n, now);
    }
  }

  // 5: improvement milestones - compare each skill's last two interview evidence scores.
  for (const s of nodesByKind(g, "skill")) {
    const scores = edgesFrom(g, s.id, "DEMONSTRATED_IN")
      .map((e) => (e.data?.score as number) ?? 0)
      .filter((x) => x > 0);
    if (scores.length >= 2) {
      const delta = scores[scores.length - 1] - scores[scores.length - 2];
      if (delta >= 12) {
        const mid = `milestone:${s.id}:${scores.length}`;
        upsertNode(g, {
          id: mid,
          kind: "milestone",
          label: `${s.label} improved +${delta}%`,
          data: { skill: s.label, delta, date: now },
        });
        link(g, ID.candidate(g.candidateId), "OWNS", mid);
        link(g, mid, "IMPROVES", s.id);
        milestones.push(`${s.label} +${delta}%`);
      }
    }
  }

  // 4: evidence-backed recommendation + resource nodes.
  const recs = recommendations(g, { company: opts.company, limit: 6 });
  let newRecommendations = 0;
  const weakConceptsHighlighted: string[] = [];
  for (const r of recs) {
    const recId = ID.recommendation(r.concept);
    upsertNode(g, {
      id: recId,
      kind: "recommendation",
      label: `Improve ${r.concept}`,
      confidence: r.priority,
      data: { concept: r.concept, priority: r.priority, reason: r.reason, evidence: r.evidence.items },
    });
    link(g, ID.candidate(g.candidateId), "OWNS", recId);
    const cid = ID.concept(r.concept);
    if (g.nodes[cid]) {
      link(g, recId, "RECOMMENDS", cid);
      if (r.confidence < 55) weakConceptsHighlighted.push(r.concept);
    }
    for (const res of r.resources) {
      const resId = ID.resource(`${r.concept}-${res.title}`);
      upsertNode(g, { id: resId, kind: "resource", label: res.title, data: { kind: res.kind, concept: r.concept } });
      if (link(g, recId, "RECOMMENDS", resId)) newRecommendations++;
      if (g.nodes[cid]) link(g, resId, "IMPROVES", cid);
    }
  }

  g.revision += 1;
  return { newEdges, newRecommendations, milestones, weakConceptsHighlighted, revision: g.revision };
}
