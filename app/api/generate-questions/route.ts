import { NextRequest, NextResponse } from "next/server";
import { sarvamChat, extractJson } from "@/lib/sarvam";
import { QUESTION_GEN_SYSTEM, questionGenUser } from "@/lib/prompts";
import { FALLBACK_QUESTIONS } from "@/lib/fallbackData";
import { InterviewQuestion, ResumeSkill } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  let skills: ResumeSkill[] = [];
  try {
    const body = await req.json();
    skills = (body.skills ?? []) as ResumeSkill[];
    if (!skills.length) throw new Error("no skills");

    const raw = await sarvamChat(QUESTION_GEN_SYSTEM, questionGenUser(skills), {
      temperature: 0.4,
      maxTokens: 3000,
    });
    const out = extractJson<{ questions: InterviewQuestion[] }>(raw);
    // Normalize targetSkill back to an exact resume skill name — the reasoning model sometimes
    // echoes the full "Spark (Data, claimed advanced)" descriptor, which would break the
    // fraud-detector's skill matching downstream.
    const normalize = (raw: string): string => {
      const low = (raw || "").toLowerCase();
      const hit = skills.find((s) => low.includes(s.name.toLowerCase()));
      return hit ? hit.name : skills[0]?.name ?? raw;
    };
    const questions = (out.questions || [])
      .filter((q) => q.text && q.targetSkill)
      .map((q, i) => ({ ...q, id: i + 1, targetSkill: normalize(q.targetSkill) }));
    if (!questions.length) throw new Error("no questions");

    return NextResponse.json({ questions });
  } catch (e) {
    console.warn("[generate-questions] fallback:", (e as Error).message);
    // Fallback: filter the canned set to the actual claimed skills when possible.
    const names = new Set(skills.map((s) => s.name.toLowerCase()));
    let qs = FALLBACK_QUESTIONS.filter((q) => names.has(q.targetSkill.toLowerCase()));
    if (qs.length < 2) qs = FALLBACK_QUESTIONS;
    return NextResponse.json({ questions: qs.map((q, i) => ({ ...q, id: i + 1 })) });
  }
}
