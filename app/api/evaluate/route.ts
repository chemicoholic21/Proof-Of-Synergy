import { NextRequest, NextResponse } from "next/server";
import { sarvamChat, extractJson } from "@/lib/sarvam";
import { EVAL_SYSTEM, evalUser } from "@/lib/prompts";
import { FALLBACK_EVALUATIONS } from "@/lib/fallbackData";
import { InterviewQuestion, QuestionEvaluation } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

interface EvalItem {
  question: InterviewQuestion;
  answer: string;
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const items: EvalItem[] = body.items ?? [];

  const evaluations: QuestionEvaluation[] = await Promise.all(
    items.map(async ({ question, answer }) => {
      try {
        const raw = await sarvamChat(
          EVAL_SYSTEM,
          evalUser(question.text, question.targetSkill, question.rubric, answer),
          { temperature: 0.3 }
        );
        const out = extractJson<Omit<QuestionEvaluation, "questionId" | "targetSkill">>(raw);
        const score = Math.max(0, Math.min(100, Math.round(Number(out.score))));
        return {
          questionId: question.id,
          targetSkill: question.targetSkill,
          score,
          feedback: out.feedback ?? "",
          strengths: out.strengths ?? [],
          improvements: out.improvements ?? [],
        };
      } catch (e) {
        console.warn("[evaluate] fallback for q", question.id, (e as Error).message);
        const fb = FALLBACK_EVALUATIONS[question.id] || {
          questionId: question.id,
          targetSkill: question.targetSkill,
          score: 75,
          feedback: "Reasonable answer.",
          strengths: [],
          improvements: [],
        };
        return { ...fb, questionId: question.id, targetSkill: question.targetSkill };
      }
    })
  );

  return NextResponse.json({ evaluations });
}
