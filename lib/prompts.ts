// The ProofOfSynergy Sarvam-M prompt pipeline.
// 3 active prompts for the live build (Resume Parsing -> Assessment Generation -> Evaluation).
// Model-Answer-Generation is intentionally cut for latency/reliability (kept here for reference).

export const RESUME_PARSE_SYSTEM =
  "You are an information-extraction engine. Output ONLY valid JSON. Extract only information clearly present; use null/empty for missing fields.";

export function resumeParseUser(resumeText: string) {
  return `Parse the following resume into JSON with this exact shape:
{
  "name": string|null,
  "contact": string|null,
  "skills": [{"name": string, "category": string, "claimedLevel": "beginner"|"intermediate"|"advanced"|"expert"}],
  "experience": [{"role": string, "company": string, "years": number}],
  "education": [{"degree": string, "institution": string, "year": number|null}]
}
Estimate claimedLevel from wording (e.g. "expert", "5+ years", "advanced"). Return 4-7 of the most important skills.

Resume Text:
"""
${resumeText}
"""`;
}

export const QUESTION_GEN_SYSTEM =
  "You are an expert technical interviewer. Generate questions that test THINKING and COMMUNICATION, not facts. Reference the candidate's actual skills. Avoid yes/no and 'what is X' questions. Output ONLY valid JSON.";

export function questionGenUser(skills: { name: string; category: string; claimedLevel: string }[]) {
  return `For each skill below, generate ONE practical, real-world interview question that is hard to fake and reveals true depth. Output JSON:
{ "questions": [ { "id": number, "text": string, "targetSkill": string, "rubric": string } ] }
The "targetSkill" MUST exactly equal one of the provided skill names.

Skills:
${skills.map((s) => `- ${s.name} (${s.category}, claimed ${s.claimedLevel})`).join("\n")}`;
}

export const EVAL_SYSTEM =
  "You are an expert, fair evaluator scoring a spoken interview answer. Judge technical depth, communication clarity, confidence, and authenticity (genuine experience vs memorized/vague). Output ONLY valid JSON.";

export function evalUser(question: string, targetSkill: string, rubric: string, answer: string) {
  return `Score this candidate answer 0-100 (0=no knowledge, 100=clear expert). A vague, hesitant, or incorrect answer must score low even if the resume claims expertise.

Skill: ${targetSkill}
Question: ${question}
Rubric: ${rubric}
Candidate's spoken answer (transcribed): "${answer}"

Output JSON:
{ "score": number, "feedback": string, "strengths": string[], "improvements": string[] }`;
}
