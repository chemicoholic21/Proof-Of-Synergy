/**
 * improve() - the enrichment half of the lifecycle. Runs automatically after every session.
 *
 * Does NOT merely save data; it makes the graph smarter:
 *   1. Connects skills structurally (RELATED_TO + PREREQ_OF) so weaknesses form a sub-graph.
 *   2. Materializes retention decay onto skill nodes (spaced-repetition state).
 *   3. Raises node weights for everything touched (reinforcement / importance).
 *   4. Emits evidence-backed recommendation + learning-resource nodes into the graph.
 *   5. Records improvement milestones when a skill's confidence rose vs its previous session.
 *
 * Returns a diff summary so the UI can animate "the graph just grew" during the demo.
 */

import { CommunicationGraph, ID } from "./graph/model";
import { clock, edgesFrom, link, nodesByKind, upsertNode } from "./graph/ops";
import { skillDef } from "./skills";
import { currentRetention } from "./recall";
import { recommendations } from "./recommendations";

export interface ImproveSummary {
  newEdges: number;
  newRecommendations: number;
  milestones: string[];
  skillsHighlighted: string[];
  revision: number;
}

export function improve(g: CommunicationGraph, opts: { scenarioId?: string | null } = {}): ImproveSummary {
  const now = clock();
  let newEdges = 0;
  const milestones: string[] = [];

  // 1 + 3: skill relationships + weight reinforcement.
  for (const s of nodesByKind(g, "skill")) {
    const def = skillDef(s.label);
    for (const rel of def.related) {
      const rid = ID.skill(rel);
      if (!g.nodes[rid]) upsertNode(g, { id: rid, kind: "skill", label: rel, data: { derived: true }, weight: 0 });
      if (link(g, s.id, "RELATED_TO", rid)) newEdges++;
    }
    for (const pre of def.prereqs ?? []) {
      const pid = ID.skill(pre);
      if (!g.nodes[pid]) upsertNode(g, { id: pid, kind: "skill", label: pre, data: { derived: true }, weight: 0 });
      if (link(g, pid, "PREREQ_OF", s.id)) newEdges++;
    }
  }

  // 2: materialize retention decay so the stored graph reflects lifelong forgetting.
  for (const kind of ["skill"] as const) {
    for (const n of nodesByKind(g, kind)) {
      n.retention = currentRetention(n, now);
    }
  }

  // 5: improvement milestones - compare each skill's last two session evidence scores.
  for (const s of nodesByKind(g, "skill")) {
    const scores = edgesFrom(g, s.id, "DEMONSTRATED_IN")
      .map((e) => {
        const sessionNode = g.nodes[e.to];
        return sessionNode ? (sessionNode.data.confidence as number) : 0;
      })
      .filter((x) => x > 0);
    if (scores.length >= 2) {
      const delta = scores[scores.length - 1] - scores[scores.length - 2];
      if (delta >= 10) {
        const mid = `milestone:${s.id}:${scores.length}`;
        upsertNode(g, {
          id: mid,
          kind: "milestone",
          label: `${s.label} improved +${delta}%`,
          data: { skill: s.label, delta, date: now },
        });
        link(g, ID.learner(g.learnerId), "HAS_MILESTONE", mid);
        link(g, mid, "IMPROVES", s.id);
        milestones.push(`${s.label} +${delta}%`);
      }
    }
  }

  // 4: evidence-backed recommendation + resource nodes.
  const recs = recommendations(g, { scenarioId: opts.scenarioId, limit: 6 });
  let newRecommendations = 0;
  const skillsHighlighted: string[] = [];
  for (const r of recs) {
    const recId = ID.recommendation(r.skill);
    upsertNode(g, {
      id: recId,
      kind: "recommendation",
      label: `Improve ${r.skill}`,
      confidence: r.priority,
      data: { skill: r.skill, priority: r.priority, reason: r.reason, evidence: r.evidence.items },
    });
    link(g, ID.learner(g.learnerId), "HAS_RECOMMENDATION", recId);
    const sid = ID.skill(r.skill);
    if (g.nodes[sid]) {
      link(g, recId, "RECOMMENDS", sid);
      if (r.confidence < 55) skillsHighlighted.push(r.skill);
    }
    for (const res of r.resources) {
      const resId = ID.resource(`${r.skill}-${res.title}`);
      upsertNode(g, { id: resId, kind: "resource", label: res.title, data: { kind: res.kind, skill: r.skill } });
      if (link(g, recId, "RECOMMENDS", resId)) newRecommendations++;
      if (g.nodes[sid]) link(g, resId, "IMPROVES", sid);
    }
  }

  g.revision += 1;
  return { newEdges, newRecommendations, milestones, skillsHighlighted, revision: g.revision };
}