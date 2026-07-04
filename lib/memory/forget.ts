/**
 * forget() — prune memories while preserving graph consistency.
 *
 * The candidate owns their data: they can delete an interview, a resume version, a company prep
 * context, a project, or everything. Deletion is not just a node removal — dependent nodes
 * (questions/answers/DNA/evidence for a deleted interview) are cascaded, orphans are garbage
 * collected, and every skill/concept confidence is RECOMPUTED from the evidence that remains, so
 * the graph never keeps a score it can no longer justify.
 */

import { CareerGraph, GNode, ID } from "./graph/model";
import { edgesFrom, edgesTouching, nodesByKind, removeNodes } from "./graph/ops";

export type ForgetTarget =
  | { type: "interview"; index: number }
  | { type: "resume"; version: number }
  | { type: "company"; name: string }
  | { type: "project"; name: string }
  | { type: "all" };

export interface ForgetResult {
  ok: boolean;
  removedNodes: number;
  removedEdges: number;
  message: string;
}

export function forget(g: CareerGraph, target: ForgetTarget): ForgetResult {
  switch (target.type) {
    case "all": {
      const n = Object.keys(g.nodes).length;
      const e = Object.keys(g.edges).length;
      g.nodes = {};
      g.edges = {};
      g.revision += 1;
      return { ok: true, removedNodes: n, removedEdges: e, message: "All memories cleared." };
    }
    case "interview": {
      const iv = nodesByKind(g, "interview").find((x) => (x.data.index as number) === target.index);
      if (!iv) return notFound("interview");
      const doomed = collectInterviewSubgraph(g, iv);
      const res = removeNodes(g, doomed);
      recomputeConfidence(g);
      g.revision += 1;
      return done(res, `Interview #${target.index} forgotten.`);
    }
    case "resume": {
      const r = nodesByKind(g, "resume").find((x) => (x.data.version as number) === target.version);
      if (!r) return notFound("resume");
      // Only the resume node + its CLAIMS edges go; skills persist if still demonstrated/claimed elsewhere.
      const res = removeNodes(g, [r.id]);
      pruneUnsupportedSkills(g);
      g.revision += 1;
      return done(res, `Resume v${target.version} forgotten.`);
    }
    case "company": {
      const c = nodesByKind(g, "company").find((x) => x.id === ID.company(target.name));
      if (!c) return notFound("company");
      const res = removeNodes(g, [c.id]);
      g.revision += 1;
      return done(res, `${target.name} preparation forgotten.`);
    }
    case "project": {
      const p = nodesByKind(g, "project").find((x) => x.label.toLowerCase() === target.name.toLowerCase());
      if (!p) return notFound("project");
      const res = removeNodes(g, [p.id]);
      g.revision += 1;
      return done(res, `Project "${target.name}" forgotten.`);
    }
  }
}

/** An interview plus everything that only exists because of it. */
function collectInterviewSubgraph(g: CareerGraph, interview: GNode): string[] {
  const ids = new Set<string>([interview.id]);
  // questions/answers/DNA hang off the interview via OWNS/TESTS.
  for (const e of edgesTouching(g, interview.id)) {
    const other = e.from === interview.id ? e.to : e.from;
    const node = g.nodes[other];
    if (node && ["question", "answer", "communication"].includes(node.kind)) {
      ids.add(node.id);
      // answers/evidence tied to those questions
      for (const e2 of edgesTouching(g, node.id)) {
        const n2 = g.nodes[e2.from === node.id ? e2.to : e2.from];
        if (n2 && ["answer", "evidence"].includes(n2.kind)) ids.add(n2.id);
      }
    }
  }
  // evidence nodes referencing this interview
  for (const ev of nodesByKind(g, "evidence")) {
    if (ev.data.interviewId === interview.id) ids.add(ev.id);
  }
  return [...ids];
}

/** After removing interviews, recompute each skill/concept confidence from surviving evidence. */
function recomputeConfidence(g: CareerGraph): void {
  for (const kind of ["skill", "concept"] as const) {
    for (const n of nodesByKind(g, kind)) {
      const evScores = edgesTouching(g, n.id)
        .filter((e) => e.type === "EVIDENCE_FOR" && e.to === n.id)
        .map((e) => g.nodes[e.from])
        .filter((x): x is GNode => Boolean(x) && x.kind === "evidence")
        .map((x) => (x.data.score as number) ?? 0);
      const demoScores = edgesFrom(g, n.id, "DEMONSTRATED_IN").map((e) => (e.data?.score as number) ?? 0);
      const scores = [...evScores, ...demoScores].filter((s) => s > 0);
      if (scores.length) {
        n.confidence = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
      } else if (n.kind === "skill" && edgesTouching(g, n.id).some((e) => e.type === "CLAIMS")) {
        n.confidence = 0; // claimed but no evidence anymore
      }
    }
  }
}

/** Drop skills that are neither claimed by any resume nor demonstrated in any interview. */
function pruneUnsupportedSkills(g: CareerGraph): void {
  const doomed = nodesByKind(g, "skill")
    .filter((s) => {
      const claimed = edgesTouching(g, s.id).some((e) => e.type === "CLAIMS");
      const demonstrated = edgesFrom(g, s.id, "DEMONSTRATED_IN").length > 0;
      return !claimed && !demonstrated;
    })
    .map((s) => s.id);
  if (doomed.length) removeNodes(g, doomed);
}

function notFound(kind: string): ForgetResult {
  return { ok: false, removedNodes: 0, removedEdges: 0, message: `No ${kind} found to forget.` };
}
function done(res: { removedNodes: number; removedEdges: number }, message: string): ForgetResult {
  return { ok: true, ...res, message };
}
