import { QuestionEvaluation, ResumeSkill, SkillVerdict, SkillStatus } from "./types";

// The LLM->chain bridge + fraud detector.
// 1) Average per-question evaluation scores by targetSkill -> observed confidence (0-100).
// 2) Compare the resume's claimed level vs observed confidence -> status + flag.

const LEVEL_EXPECTATION: Record<string, number> = {
  beginner: 40,
  intermediate: 60,
  advanced: 75,
  expert: 85,
};

export function aggregateConfidence(
  evaluations: QuestionEvaluation[]
): Record<string, number> {
  const buckets: Record<string, number[]> = {};
  for (const e of evaluations) {
    (buckets[e.targetSkill] ||= []).push(e.score);
  }
  const out: Record<string, number> = {};
  for (const [skill, scores] of Object.entries(buckets)) {
    out[skill] = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
  }
  return out;
}

export function buildVerdicts(
  skills: ResumeSkill[],
  confidenceBySkill: Record<string, number>
): SkillVerdict[] {
  return skills.map((s) => {
    const observed = confidenceBySkill[s.name];
    // Skills never tested in the interview are reported as unverified-but-claimed.
    if (observed === undefined) {
      return {
        skill: s.name,
        claimedLevel: s.claimedLevel,
        observedConfidence: 0,
        status: "exaggerated" as SkillStatus,
        flag: "Not demonstrated in interview",
      };
    }
    const expected = LEVEL_EXPECTATION[s.claimedLevel] ?? 70;
    let status: SkillStatus;
    let flag: string | null = null;
    if (observed < 70 || observed < expected - 25) {
      status = "exaggerated";
      flag = `⚠️ Claimed ${s.claimedLevel}, observed ${observed}%: potentially exaggerated`;
    } else if (observed >= 85) {
      status = "strong";
    } else {
      status = "verified";
    }
    return { skill: s.name, claimedLevel: s.claimedLevel, observedConfidence: observed, status, flag };
  });
}

export function overallScore(confidenceBySkill: Record<string, number>): number {
  const vals = Object.values(confidenceBySkill);
  if (!vals.length) return 0;
  return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
}
