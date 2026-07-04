/**
 * recall() — the retrieval half of the lifecycle, a.k.a. the Career Reasoner.
 *
 * Answers the questions an adaptive interview / dashboard must ask BEFORE generating anything:
 *   - Which concepts have low confidence? (weak)
 *   - Which concepts have decayed since last practised? (forgotten → spaced repetition)
 *   - Which claimed skills were never verified?
 *   - Which resume claims have thin evidence? (reality gap)
 *   - Which concepts were recently mastered? (stop asking beginner questions)
 *   - Which projects were never discussed?
 *   - Which company interview is upcoming?
 *
 * Retention decay is computed lazily at read time from lastSeenAt + the concept's half-life, so a
 * skill genuinely "fades" the longer it goes unpractised — the mechanism behind lifelong learning.
 */

import { CareerGraph, GNode, ID } from "./graph/model";
import { clock, daysBetween, edgesFrom, edgesTo, nodesByKind } from "./graph/ops";
import { conceptDef, retentionAfter, stalenessLabel } from "./concepts";
import { RecallResult, RecalledConcept } from "./types";

export interface RecallOptions {
  company?: string | null;
  now?: string;
}

/** Current (decayed) retention for a skill/concept node, given time since last reinforcement. */
export function currentRetention(node: GNode, now: string): number {
  const days = daysBetween(now, node.lastSeenAt);
  const halfLife = conceptDef(node.label).halfLifeDays ?? 60;
  return retentionAfter(days, halfLife);
}

export function recall(g: CareerGraph, opts: RecallOptions = {}): RecallResult {
  const now = opts.now ?? clock();
  const candidateId = ID.candidate(g.candidateId);
  const interviews = nodesByKind(g, "interview");
  const isNew = interviews.length === 0;

  const skills = nodesByKind(g, "skill");
  const concepts = nodesByKind(g, "concept");

  // A concept counts as "tested" if any question TESTS it.
  const tested = (id: string) => edgesTo(g, id, "TESTS").length > 0;

  const weakConcepts: RecalledConcept[] = [];
  const forgottenConcepts: RecalledConcept[] = [];
  const strongConcepts: RecalledConcept[] = [];

  for (const c of concepts) {
    if (!tested(c.id)) continue; // only reason about concepts we have evidence on
    const retention = currentRetention(c, now);
    const days = daysBetween(now, c.lastSeenAt);
    const rc: RecalledConcept = {
      name: c.label,
      confidence: c.confidence,
      retention,
      lastSeenDays: Math.round(days),
      reason: "",
    };
    if (c.confidence < 55) {
      weakConcepts.push({ ...rc, reason: `Scored ${c.confidence}% when last tested — needs practice.` });
    } else if (retention < 55 && days > 14) {
      forgottenConcepts.push({
        ...rc,
        reason: `Last discussed ${stalenessLabel(days)}; retention estimated ${retention}% — likely decaying.`,
      });
    } else if (c.confidence >= 78) {
      strongConcepts.push({ ...rc, reason: `Consistently strong (${c.confidence}%).` });
    }
  }

  // Skills claimed on a resume but never tested in any interview.
  const unverifiedSkills = skills
    .filter((s) => edgesTo(g, s.id, "CLAIMS").length > 0 && !edgesFrom(g, s.id, "DEMONSTRATED_IN").length)
    .map((s) => s.label);

  // Claimed-high-but-thin-evidence (the reality gap seed): claimed expectation >> observed confidence.
  const weakEvidenceClaims = skills
    .filter((s) => {
      const claimed = (s.data.claimedExpectation as number) ?? 0;
      const demonstrated = edgesFrom(g, s.id, "DEMONSTRATED_IN").length > 0;
      return claimed >= 75 && demonstrated && s.confidence < claimed - 20;
    })
    .map((s) => s.label);

  // Concepts mastered → escalate difficulty, don't re-ask basics.
  const masteredConcepts = concepts
    .filter((c) => tested(c.id) && c.confidence >= 82 && currentRetention(c, now) >= 70)
    .map((c) => c.label);

  // Resume projects never referenced in an interview.
  const undiscussedProjects = nodesByKind(g, "project")
    .filter((p) => !p.data.discussed)
    .map((p) => p.label);

  // Upcoming company: explicit option wins; else the most-recently-touched company prep context.
  let upcomingCompany = opts.company ?? null;
  if (!upcomingCompany) {
    const companies = nodesByKind(g, "company").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    upcomingCompany = companies[0]?.label ?? null;
  }

  const focusDirectives = buildDirectives({
    weakConcepts,
    forgottenConcepts,
    unverifiedSkills,
    masteredConcepts,
    undiscussedProjects,
    upcomingCompany,
    isNew,
  });

  void candidateId;
  return {
    candidateId: g.candidateId,
    isNew,
    weakConcepts: weakConcepts.sort((a, b) => a.confidence - b.confidence).slice(0, 8),
    forgottenConcepts: forgottenConcepts.sort((a, b) => a.retention - b.retention).slice(0, 8),
    unverifiedSkills,
    weakEvidenceClaims,
    strongConcepts: strongConcepts.slice(0, 8),
    undiscussedProjects,
    masteredConcepts,
    upcomingCompany,
    interviewCount: interviews.length,
    focusDirectives,
  };
}

function buildDirectives(x: {
  weakConcepts: RecalledConcept[];
  forgottenConcepts: RecalledConcept[];
  unverifiedSkills: string[];
  masteredConcepts: string[];
  undiscussedProjects: string[];
  upcomingCompany: string | null;
  isNew: boolean;
}): string[] {
  const d: string[] = [];
  if (x.isNew) {
    d.push("This is the candidate's first interview — establish a baseline across their claimed skills.");
    return d;
  }
  if (x.weakConcepts.length)
    d.push(`Probe these weak concepts again (they scored low before): ${x.weakConcepts.slice(0, 4).map((c) => c.name).join(", ")}.`);
  if (x.forgottenConcepts.length)
    d.push(`Revisit these decaying concepts (not discussed recently): ${x.forgottenConcepts.slice(0, 4).map((c) => c.name).join(", ")}.`);
  if (x.unverifiedSkills.length)
    d.push(`Verify these claimed-but-never-tested skills: ${x.unverifiedSkills.slice(0, 4).join(", ")}.`);
  if (x.masteredConcepts.length)
    d.push(`Do NOT ask basics on already-mastered topics (${x.masteredConcepts.slice(0, 4).join(", ")}); escalate difficulty instead.`);
  if (x.undiscussedProjects.length)
    d.push(`Draw on a project never discussed yet: ${x.undiscussedProjects.slice(0, 2).join(", ")}.`);
  if (x.upcomingCompany) d.push(`Bias toward topics relevant to an upcoming ${x.upcomingCompany} interview.`);
  return d;
}
