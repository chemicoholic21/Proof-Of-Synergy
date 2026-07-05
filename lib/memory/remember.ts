/**
 * remember() — the ingestion half of the memory lifecycle.
 *
 * Turns a resume or a completed interview into STRUCTURED nodes + relationships in the Career
 * Knowledge Graph. Never stores flat JSON: a resume becomes candidate→resume→CLAIMS→skill;
 * an interview becomes interview→TESTS→concept, answer→ANSWERS→question, skill→DEMONSTRATED_IN→
 * interview, evidence→EVIDENCE_FOR→skill, and communication→UPDATES_COMMUNICATION→candidate.
 *
 * Deterministic and side-effect-free on I/O — it mutates the passed CareerGraph; the caller
 * (orchestrator) persists and mirrors into Cognee.
 */

import { CareerGraph, ID, SkillLevel } from "./graph/model";
import { clock, edgesFrom, link, nodesByKind, upsertNode } from "./graph/ops";
import { relatedConcepts } from "./concepts";
import { aggregateDNA, extractDNA, InterviewDNA } from "./interview-memory";
import { RememberAnswer, RememberInterviewInput, RememberResumeInput } from "./types";

const LEVEL_EXPECTATION: Record<SkillLevel, number> = {
  beginner: 40,
  intermediate: 60,
  advanced: 78,
  expert: 88,
};

/** Ingest a resume version. Returns the resume node id. */
export function rememberResume(g: CareerGraph, input: RememberResumeInput): string {
  if (input.name && !g.name) g.name = input.name;
  const candidateId = ID.candidate(g.candidateId);
  upsertNode(g, {
    id: candidateId,
    kind: "candidate",
    label: g.name || input.name || "Candidate",
    data: { candidateId: g.candidateId },
  });

  // Resume versions are first-class so we can show resume evolution (v1 → v2 → v3).
  const version = nodesByKind(g, "resume").length + 1;
  const resumeId = ID.resume(g.candidateId, version);
  upsertNode(g, {
    id: resumeId,
    kind: "resume",
    label: `Resume v${version}`,
    data: {
      version,
      skillNames: input.skills.map((s) => s.name),
      experience: input.experience ?? [],
      education: input.education ?? [],
    },
  });
  link(g, candidateId, "OWNS", resumeId);

  for (const s of input.skills) {
    const skillId = ID.skill(s.name);
    // A claim raises the node's *claimed* level but NOT its confidence — confidence is earned in
    // interviews. This separation is the whole basis of the Reality Gap.
    const expected = LEVEL_EXPECTATION[s.claimedLevel] ?? 60;
    upsertNode(g, {
      id: skillId,
      kind: "skill",
      label: s.name,
      data: { category: s.category ?? "General", claimedLevel: s.claimedLevel, claimedExpectation: expected },
    });
    link(g, candidateId, "HAS_SKILL", skillId);
    link(g, resumeId, "CLAIMS", skillId, { data: { claimedLevel: s.claimedLevel } });

    // Explode the skill into its concept sub-graph so weaknesses can be localized precisely.
    for (const c of relatedConcepts(s.name)) {
      const cid = ID.concept(c);
      upsertNode(g, { id: cid, kind: "concept", label: c, data: { parentSkill: s.name } });
      link(g, skillId, "RELATED_TO", cid);
    }
  }

  // Companies from work history become preparation contexts.
  for (const e of input.experience ?? []) {
    if (!e.company) continue;
    const cid = ID.company(e.company);
    upsertNode(g, { id: cid, kind: "company", label: e.company, data: { fromResume: true } });
    link(g, candidateId, "PREP_FOR", cid, { weight: 0 });
  }

  // Projects (if the parser surfaced any) become first-class, referenceable in future interviews.
  for (const p of input.projects ?? []) {
    const pid = ID.project(g.candidateId, p.name);
    upsertNode(g, { id: pid, kind: "project", label: p.name, data: { summary: p.summary ?? "", discussed: false } });
    link(g, candidateId, "OWNS", pid);
    for (const t of p.technologies ?? []) {
      const tid = ID.technology(t);
      upsertNode(g, { id: tid, kind: "technology", label: t });
      link(g, pid, "USES", tid);
    }
  }

  g.revision += 1;
  return resumeId;
}

/**
 * Ingest a completed interview: creates the interview node, per-question/answer nodes, concept
 * TESTS edges, evidence, and the Interview DNA communication snapshot. Updates each tested skill's
 * confidence toward the observed score (reinforcement-weighted) and marks it demonstrated.
 * Returns the interview node id.
 */
export function rememberInterview(g: CareerGraph, input: RememberInterviewInput): string {
  const candidateId = ID.candidate(g.candidateId);
  upsertNode(g, { id: candidateId, kind: "candidate", label: g.name || input.name || "Candidate", data: {} });

  const n = nodesByKind(g, "interview").length + 1;
  const interviewId = ID.interview(g.candidateId, n);
  const avgScore = input.answers.length
    ? Math.round(input.answers.reduce((a, x) => a + x.score, 0) / input.answers.length)
    : 0;
  upsertNode(g, {
    id: interviewId,
    kind: "interview",
    label: `Interview #${n}`,
    confidence: avgScore,
    data: {
      index: n,
      company: input.company ?? null,
      questionCount: input.answers.length,
      avgScore,
      date: clock(),
    },
  });
  link(g, candidateId, "OWNS", interviewId);

  if (input.company) {
    const cid = ID.company(input.company);
    upsertNode(g, { id: cid, kind: "company", label: input.company, data: {} });
    link(g, interviewId, "PREP_FOR", cid);
    link(g, candidateId, "PREP_FOR", cid);
  }

  const dnaParts: InterviewDNA[] = [];
  for (const a of input.answers) {
    ingestAnswer(g, interviewId, a);
    dnaParts.push(extractDNA(a.transcript, a.durationSec));
  }

  // Interview DNA: one communication snapshot per interview → trend over time.
  const dna = aggregateDNA(dnaParts);
  const dnaId = ID.communication(interviewId);
  upsertNode(g, {
    id: dnaId,
    kind: "communication",
    label: `Communication · Interview #${n}`,
    confidence: dna.confidence,
    data: { ...dna, interviewIndex: n, date: clock() },
  });
  link(g, dnaId, "UPDATES_COMMUNICATION", candidateId);
  link(g, interviewId, "OWNS", dnaId);

  g.revision += 1;
  return interviewId;
}

/** One answered question → question/answer/concept/evidence nodes + skill confidence update. */
function ingestAnswer(g: CareerGraph, interviewId: string, a: RememberAnswer): void {
  const questionId = ID.question(interviewId, a.questionId);
  const answerId = ID.answer(interviewId, a.questionId);
  const skillId = ID.skill(a.targetSkill);

  upsertNode(g, {
    id: questionId,
    kind: "question",
    label: a.questionText.slice(0, 120),
    data: { text: a.questionText, targetSkill: a.targetSkill, rubric: a.rubric ?? "", score: a.score },
  });
  upsertNode(g, {
    id: answerId,
    kind: "answer",
    label: `Answer · ${a.targetSkill}`,
    confidence: a.score,
    data: {
      transcript: a.transcript,
      language: a.language ?? "unknown",
      score: a.score,
      feedback: a.feedback ?? "",
      strengths: a.strengths ?? [],
      improvements: a.improvements ?? [],
    },
  });
  link(g, answerId, "ANSWERS", questionId);
  link(g, interviewId, "TESTS", questionId);

  // Ensure the tested skill exists even if it wasn't on the resume (interview-only skill).
  const skill = upsertNode(g, { id: skillId, kind: "skill", label: a.targetSkill, data: {} });
  link(g, questionId, "TESTS", skillId);

  // Reinforcement-weighted confidence update: new belief blends prior with the fresh observation,
  // weighted by how many times we've seen this skill (later evidence moves it less — stability).
  const timesSeen = (skill.data.timesTested as number) ?? 0;
  const prior = timesSeen === 0 ? a.score : skill.confidence;
  const alpha = 1 / (timesSeen + 2); // 1st obs weight .5, then .33, .25...
  const blended = Math.round(prior * (1 - alpha) + a.score * alpha);
  upsertNode(g, {
    id: skillId,
    kind: "skill",
    label: a.targetSkill,
    confidence: blended,
    retention: 100, // freshly reinforced
    data: { timesTested: timesSeen + 1, lastScore: a.score },
  });
  link(g, skillId, "DEMONSTRATED_IN", interviewId, { weight: 1, data: { score: a.score } });

  // Evidence node: every score is traceable back to a concrete interview answer.
  const evId = ID.evidence(skillId, "interview", `${interviewId}-${a.questionId}`);
  upsertNode(g, {
    id: evId,
    kind: "evidence",
    label: `Interview answer (${a.score}%)`,
    confidence: a.score,
    data: { source: "interview", interviewId, score: a.score, snippet: a.transcript.slice(0, 160) },
  });
  link(g, evId, "EVIDENCE_FOR", skillId, { data: { score: a.score } });

  // Concept-level tracking: each related concept inherits the observation, so a weak Kafka answer
  // marks Consumer Groups / Partitions / etc. weak too (the Weakness Graph).
  const concepts = [a.targetSkill, ...relatedConcepts(a.targetSkill)];
  for (const c of concepts) {
    const cid = ID.concept(c);
    const cNode = upsertNode(g, {
      id: cid,
      kind: "concept",
      label: c,
      confidence: a.score,
      retention: 100,
      data: { parentSkill: a.targetSkill, lastScore: a.score },
    });
    link(g, questionId, "TESTS", cid, { weight: c === a.targetSkill ? 2 : 1 });
    const candidateId = ID.candidate(g.candidateId);
    if (a.score < 55) link(g, candidateId, "WEAK_IN", cid, { data: { score: a.score } });
    else if (a.score >= 78) link(g, candidateId, "STRONG_IN", cid, { data: { score: a.score } });
    void cNode;
  }

  // Mark any resume project that uses this skill as "discussed".
  for (const e of edgesFrom(g, ID.candidate(g.candidateId), "OWNS")) {
    const pnode = g.nodes[e.to];
    if (pnode?.kind === "project") {
      const usesSkill = edgesFrom(g, pnode.id, "USES").some((u) => g.nodes[u.to]?.label.toLowerCase() === a.targetSkill.toLowerCase());
      if (usesSkill) {
        pnode.data.discussed = true;
        link(g, pnode.id, "DISCUSSED_IN", interviewId);
      }
    }
  }
}
