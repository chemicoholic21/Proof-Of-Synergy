// L3 + L4 of the multi-agent pipeline: a diverse LLM-as-a-judge PANEL plus deterministic
// aggregation.
//
// Why a panel and not one judge: a panel only beats a single judge to the extent its members'
// errors are uncorrelated, so we use three DISTINCT lenses rather than three clones
// (PoLL / Verga et al. 2024; "Nine Judges, Two Effective Votes", arXiv:2605.29800):
//   - technical:      correctness and depth of reasoning only
//   - communication:  clarity and authenticity only
//   - skeptic:        adversarial — argues the answer is weaker than it looks (counters leniency)
//
// Why aggregation is plain code, not another LLM: the dominant multi-agent failure mode is
// inter-agent misalignment and missing verification, not weak models (MAST, arXiv:2503.13657).
// A deterministic combiner is auditable and cannot hallucinate a score. It also emits a
// confidence signal from inter-judge agreement so low-confidence results can be held back from
// the irreversible on-chain attestation.

import { sarvamChat, extractValidatedJson } from "./sarvam";
import {
  JUDGE_TECHNICAL_SYSTEM,
  judgeTechnicalUser,
  JUDGE_COMMUNICATION_SYSTEM,
  judgeCommunicationUser,
  JUDGE_SKEPTIC_SYSTEM,
  judgeSkepticUser,
} from "./prompts";
import {
  JudgeTechnicalLLMSchema,
  JudgeCommunicationLLMSchema,
  JudgeSkepticLLMSchema,
} from "./schemas";
import { InterviewQuestion } from "./types";
import { env } from "./env";

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));
const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

// The technical lens carries the most weight; communication is real but secondary for a skills
// passport. The skeptic's deduction (0-40 points) is subtracted from the weighted base.
const TECH_WEIGHT = 0.6;
const COMM_WEIGHT = 0.4;

export interface JudgePanelParts {
  technical: { score: number; justification: string };
  communication: { score: number; authenticityFlags: string[]; justification: string };
  skeptic: { deduction: number; reasons: string[] };
}

export interface AggregatedEvaluation {
  score: number; // 0-100
  confidence: number; // 0-100, from inter-judge agreement
  lowConfidence: boolean;
  feedback: string;
  strengths: string[];
  improvements: string[];
  subScores: { technical: number; communication: number; deduction: number };
}

/**
 * Combine the three judges' outputs into one defensible score with a confidence signal.
 * Pure and deterministic so it is unit-testable without any network calls.
 */
export function aggregatePanel(
  parts: JudgePanelParts,
  opts: { confidenceMin?: number } = {}
): AggregatedEvaluation {
  const technical = clamp(Math.round(parts.technical.score), 0, 100);
  const communication = clamp(Math.round(parts.communication.score), 0, 100);
  const deduction = clamp(Math.round(parts.skeptic.deduction), 0, 40);

  const base = TECH_WEIGHT * technical + COMM_WEIGHT * communication;
  const score = clamp(Math.round(base - deduction), 0, 100);

  // Confidence falls as the two scorers disagree and as the skeptic finds more to deduct while
  // the scorers stayed high (a high score the skeptic distrusts is itself a low-confidence signal).
  const disagreement = Math.abs(technical - communication); // 0-100
  const confidence = clamp(Math.round(100 - disagreement - deduction * 0.5), 0, 100);
  const confidenceMin = opts.confidenceMin ?? env.EVAL_CONFIDENCE_MIN;
  const lowConfidence = confidence < confidenceMin;

  const strengths: string[] = [];
  if (technical >= 70) strengths.push("Solid technical depth and correct reasoning.");
  if (communication >= 70) strengths.push("Clear, specific, and authentic-sounding communication.");
  if (parts.technical.justification) strengths.push(parts.technical.justification);

  // Improvements are the concrete weaknesses the skeptic and communication judges surfaced.
  const improvements = [...parts.skeptic.reasons, ...parts.communication.authenticityFlags]
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 8);

  const feedbackParts = [parts.technical.justification, parts.communication.justification]
    .map((s) => s.trim())
    .filter(Boolean);
  if (lowConfidence) {
    feedbackParts.push(
      "Judges disagreed on this answer (low confidence); flag for human review before relying on the score."
    );
  }
  const feedback = feedbackParts.join(" ") || "No detailed feedback was produced.";

  return {
    score,
    confidence,
    lowConfidence,
    feedback,
    strengths: strengths.slice(0, 6),
    improvements,
    subScores: { technical, communication, deduction },
  };
}

/** Run one judge `samples` times and average its numeric score; keep the first run's text. */
async function judgeScore<T extends { score?: number; deduction?: number }>(
  system: string,
  user: string,
  schema: { parse: (v: unknown) => T },
  pick: (t: T) => number,
  samples: number
): Promise<{ value: number; first: T }> {
  // Temperature > 0 because sampling+averaging tracks human judgement better than greedy decoding
  // (arXiv:2506.13639). Generous token budget: these are reasoning calls and must not truncate.
  const runs = await Promise.all(
    Array.from({ length: samples }, () =>
      sarvamChat(system, user, { temperature: 0.4, maxTokens: 2500 }).then((raw) =>
        extractValidatedJson(raw, schema)
      )
    )
  );
  return { value: mean(runs.map(pick)), first: runs[0] };
}

/**
 * L3: fan the three judges out concurrently (latency ~= one judge, not three), then L4 aggregate.
 * Any judge failure propagates — in production a missing judgement must never be silently
 * substituted, because the score it feeds becomes an on-chain attestation.
 */
export async function evaluateAnswerWithPanel(
  question: InterviewQuestion,
  answer: string,
  opts: { samples?: number; confidenceMin?: number } = {}
): Promise<AggregatedEvaluation> {
  const samples = opts.samples ?? env.EVAL_PANEL_SAMPLES;
  const [technical, communication, skeptic] = await Promise.all([
    judgeScore(
      JUDGE_TECHNICAL_SYSTEM,
      judgeTechnicalUser(question.text, question.targetSkill, question.rubric, answer),
      JudgeTechnicalLLMSchema,
      (t) => t.score,
      samples
    ),
    judgeScore(
      JUDGE_COMMUNICATION_SYSTEM,
      judgeCommunicationUser(question.text, question.targetSkill, answer),
      JudgeCommunicationLLMSchema,
      (t) => t.score,
      samples
    ),
    judgeScore(
      JUDGE_SKEPTIC_SYSTEM,
      judgeSkepticUser(question.text, question.targetSkill, answer),
      JudgeSkepticLLMSchema,
      (t) => t.deduction,
      samples
    ),
  ]);

  return aggregatePanel(
    {
      technical: { score: technical.value, justification: technical.first.justification },
      communication: {
        score: communication.value,
        authenticityFlags: communication.first.authenticity_flags,
        justification: communication.first.justification,
      },
      skeptic: { deduction: skeptic.value, reasons: skeptic.first.reasons },
    },
    { confidenceMin: opts.confidenceMin }
  );
}
