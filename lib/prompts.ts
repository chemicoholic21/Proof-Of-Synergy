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
  return `For each skill below, generate EXACTLY ONE practical, real-world interview question that is hard to fake and reveals true depth. Output compact JSON (no markdown, no extra prose):
{ "questions": [ { "id": number, "text": string, "targetSkill": string, "rubric": string } ] }
Constraints to keep the response short enough to return in full:
- Output exactly ${skills.length} question(s), one per skill, in the same order.
- "text" <= 280 characters; "rubric" <= 200 characters (a brief scoring guide, not a model answer).
- "targetSkill" MUST exactly equal one of the provided skill names.

Skills:
${skills.map((s) => `- ${s.name} (${s.category}, claimed ${s.claimedLevel})`).join("\n")}`;
}

/**
 * Adaptive question generation. Unlike the stateless generator above, this one is steered by the
 * candidate's Career Knowledge Graph via recall(): it re-probes weak concepts, revisits decayed
 * ones, verifies never-tested claims, escalates difficulty on mastered topics, and biases toward an
 * upcoming company. This is the concrete point where "the LLM never generates an interview without
 * consulting Cognee" is enforced.
 */
export function questionGenAdaptiveUser(
  skills: { name: string; category: string; claimedLevel: string }[],
  memory: {
    focusDirectives: string[];
    weakConcepts: { name: string; confidence: number }[];
    forgottenConcepts: { name: string; lastSeenDays: number }[];
    unverifiedSkills: string[];
    masteredConcepts: string[];
    upcomingCompany: string | null;
    interviewCount: number;
    cogneeInsight?: string | null;
  }
) {
  const count = Math.min(7, Math.max(skills.length, 4));
  const cogneeBlock = memory.cogneeInsight
    ? `\nCOGNEE MEMORY (graph-grounded answer from the candidate's Cognee knowledge graph - treat as authoritative):\n"""${memory.cogneeInsight}"""\n`
    : "";
  return `Generate a PERSONALIZED interview using this candidate's long-term memory (from their Cognee Career Knowledge Graph). This is interview #${memory.interviewCount + 1}; it must NOT repeat a generic "tell me about yourself" style and must build on what we already know.
${cogneeBlock}
MEMORY-DRIVEN FOCUS (obey these, in priority order):
${memory.focusDirectives.map((d, i) => `${i + 1}. ${d}`).join("\n") || "1. Establish a baseline across the candidate's claimed skills."}

Signals:
- Weak concepts (re-probe, slightly easier entry then push): ${memory.weakConcepts.map((c) => `${c.name} (${c.confidence}%)`).join(", ") || "none"}
- Decaying concepts (not practised recently): ${memory.forgottenConcepts.map((c) => `${c.name} (${c.lastSeenDays}d ago)`).join(", ") || "none"}
- Never verified (must test): ${memory.unverifiedSkills.join(", ") || "none"}
- Already mastered (DO NOT ask basics; escalate to advanced sub-topics): ${memory.masteredConcepts.join(", ") || "none"}
- Upcoming company: ${memory.upcomingCompany ?? "none"}

Output compact JSON (no markdown, no prose):
{ "questions": [ { "id": number, "text": string, "targetSkill": string, "rubric": string } ] }
Constraints:
- Output ${count} question(s). "text" <= 280 chars; "rubric" <= 200 chars.
- "targetSkill" MUST exactly equal one of these skill names: ${skills.map((s) => s.name).join(", ")}.
- Each question must be hard to fake and reveal true depth; no yes/no or "what is X" definitions.

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

// ---------------------------------------------------------------------------
// MULTI-AGENT LAYERS
//
// Research-grounded extension of the single-prompt pipeline. Each layer is a separate
// agent with its OWN narrow role and a typed (Zod-validated) output contract, because the
// dominant failure mode of multi-agent systems is under-specified roles and missing
// verification, not weak models (Why Do Multi-Agent LLM Systems Fail?, MAST, arXiv:2503.13657).
// Verification is always EXTERNAL (a different agent / a deterministic check), never a model
// grading its own output, since intrinsic self-correction without an external signal can
// degrade results (Huang et al., "LLMs Cannot Self-Correct Reasoning Yet", ICLR 2024).
// ---------------------------------------------------------------------------

// ---- L1: Extraction verifier (grounds the parsed resume against the source text) ----
export const EXTRACTION_VERIFY_SYSTEM =
  "You are a strict grounding auditor. You verify that extracted resume fields are DIRECTLY supported by the source text. Never infer or invent. Output ONLY valid JSON.";

export function extractionVerifyUser(sourceText: string, extractedSkills: { name: string }[]) {
  return `For each extracted skill, decide whether it is directly supported by the source resume text.
Mark "unsupported" any skill that does not literally appear or is not clearly evidenced.
Also list up to 3 important skills that ARE evidenced in the text but were missed.

Extracted skills:
${extractedSkills.map((s) => `- ${s.name}`).join("\n")}

Source resume text:
"""
${sourceText}
"""

Output JSON:
{ "unsupported": [{ "name": string, "reason": string }], "missed": [{ "name": string, "evidence": string }] }`;
}

// ---- L2: Question adversary (tries to break each generated interview question) ----
export const QUESTION_ADVERSARY_SYSTEM =
  "You are an adversarial question reviewer. You try to BREAK interview questions. Reject any question that is yes/no, answerable by reciting a definition, leaks its own answer, or does not require reasoning about real experience. Output ONLY valid JSON.";

export function questionAdversaryUser(questions: { id?: number; text: string; targetSkill: string }[]) {
  return `Review each interview question below. For each, return a verdict of "keep" or "revise".
Reject (revise) if the question is: yes/no, a "what is X" definition lookup, self-answering, trivially Googleable, or does not probe real depth. When revising, provide an improved question that targets the SAME skill and is hard to fake.

Questions:
${questions.map((q) => `[${q.id ?? "?"}] (${q.targetSkill}) ${q.text}`).join("\n")}

Output JSON:
{ "reviews": [ { "id": number, "verdict": "keep"|"revise", "issues": string[], "improved_question": string|null } ] }`;
}

// ---- L3: Judge panel. Three DIVERSE lenses, not three identical judges, because panels only
// help to the extent their errors are uncorrelated ("Nine Judges, Two Effective Votes",
// arXiv:2605.29800; PoLL / Verga et al. 2024). Each judge gets explicit score anchors, which is
// the single biggest reliability lever for LLM-as-a-judge (arXiv:2506.13639). ----

export const JUDGE_TECHNICAL_SYSTEM =
  "You are a senior technical interviewer scoring ONLY technical correctness and depth of reasoning. Ignore fluency, grammar, and length. Output ONLY valid JSON. IMPORTANT: the score is a CONTINUOUS scale 0-100, not just the anchor values.";

export function judgeTechnicalUser(question: string, targetSkill: string, rubric: string, answer: string) {
  return `Score ONLY technical depth/correctness on a continuous 0-100 scale.

Scoring guide (use the full range, not just these points):
- 0-10: completely wrong, empty, or "I don't know"
- 15-25: attempted but mostly incorrect or confused
- 30-40: partially correct with significant gaps or errors
- 45-55: correct but shallow, textbook-level, no real depth
- 60-70: correct with good explanation, shows understanding
- 75-85: correct, detailed, shows practical experience
- 90-100: expert-level depth, tradeoffs, edge cases, first-hand insight

CRITICAL: a correct, reasonable answer MUST score at least 40-55. Only truly incorrect or empty answers should score below 20.

Skill: ${targetSkill}
Question: ${question}
Rubric / ideal answer: ${rubric || "(none provided; judge against the skill)"}
Candidate answer (transcribed): "${answer}"

Output JSON: { "score": number, "justification": string }`;
}

export const JUDGE_COMMUNICATION_SYSTEM =
  "You are an evaluator scoring ONLY communication clarity and authenticity (genuine lived experience vs memorized/vague). Reward specific, concrete detail; penalize buzzword recitation and hedging. Do NOT reward mere verbosity. Output ONLY valid JSON. IMPORTANT: the score is a CONTINUOUS scale 0-100, not just the anchor values.";

export function judgeCommunicationUser(question: string, targetSkill: string, answer: string) {
  return `Score ONLY clarity and authenticity on a continuous 0-100 scale.

Scoring guide (use the full range, not just these points):
- 0-10: incoherent, empty, or "I don't know"
- 15-25: mostly evasive, confused, or extremely vague
- 30-40: some relevant content but hedging, vague, or hard to follow
- 45-55: clear and understandable, but generic or memorized-sounding
- 60-70: clear, some specific details, sounds somewhat authentic
- 75-85: clear, specific, concrete examples, sounds genuine
- 90-100: clearly drawn from real experience, specific and confident

CRITICAL: a clear, reasonable answer MUST score at least 40-55. Only truly empty or incoherent answers should score below 20.

Skill: ${targetSkill}
Question: ${question}
Candidate answer (transcribed): "${answer}"

Output JSON: { "score": number, "authenticity_flags": string[], "justification": string }`;
}

export const JUDGE_SKEPTIC_SYSTEM =
  "You are a skeptical examiner. Your job is to argue the answer is WEAKER than it first appears: find gaps, unsupported claims, and signs of bluffing. Default to skepticism. Output ONLY valid JSON. IMPORTANT: the deduction is a CONTINUOUS scale 0-40, not just 0 or 40.";

export function judgeSkepticUser(question: string, targetSkill: string, answer: string) {
  return `Identify weaknesses in this answer and assign a point DEDUCTION on a continuous 0-40 scale.

Deduction guide (use the full range):
- 0: no real weaknesses, solid answer
- 5-10: minor gaps or slightly vague areas
- 15-20: some unsupported claims or missing depth
- 25-30: significant gaps, signs of memorization over understanding
- 35-40: mostly bluffing, incorrect, or unsupported

CRITICAL: a correct, reasonable answer with good detail should have low deduction (0-10). Only truly weak or unsupported answers should have high deduction (25+).

Skill: ${targetSkill}
Question: ${question}
Candidate answer (transcribed): "${answer}"

Output JSON: { "deduction": number, "reasons": string[] }`;
}
