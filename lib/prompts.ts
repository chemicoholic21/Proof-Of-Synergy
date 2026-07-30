import { sarvamChat } from "./sarvam";
import { geminiChat } from "./gemini";
import { env, sarvamConfigured, geminiConfigured } from "./env";
import { logger } from "./logger";

const log = logger.child({ module: "prompts" });

/** True when at least one chat provider (Sarvam or Gemini) is configured. */
export function anyChatConfigured(): boolean {
  return sarvamConfigured() || geminiConfigured();
}

/**
 * Generate a conversational reply using Sarvam as the primary model (the app is Sarvam-native),
 * falling back to Gemini only if Sarvam isn't configured or errors. This keeps the practice/
 * interview loop working without a Gemini key.
 */
export async function generatePartnerReply(
  system: string,
  user: string,
  opts?: { temperature?: number; maxTokens?: number }
): Promise<string> {
  if (sarvamConfigured()) {
    try {
      return await generateWithSarvam(system, user, opts);
    } catch (e) {
      log.warn("sarvam reply failed", { error: (e as Error).message });
      if (!geminiConfigured()) throw e;
    }
  }
  if (geminiConfigured()) {
    return await geminiChat(system, user, opts);
  }
  throw new Error("No chat model configured (set SARVAM_API_KEY or GEMINI_API_KEY).");
}

export const SCENARIO_SYSTEM =
  "You are a warm, realistic conversation partner in a high-stakes practice scenario. Follow the scenario instructions naturally. Ask follow-up questions, show genuine interest, and adapt your tone to the situation. Keep responses concise (2-4 sentences) so the learner gets plenty of speaking time. Never break character or mention that you are an AI.";

export function scenarioUserPrompt(messages: { role: string; content: string }[], scenarioContext: string): string {
  const history = messages
    .map((m) => `${m.role === "user" ? "Learner" : "You"}: ${m.content}`)
    .join("\n");
  return `${scenarioContext}

Conversation so far:
${history}

Respond naturally as the conversation partner. Keep it to 2-4 sentences.`;
}

// ---------------------------------------------------------------------------
// Technical interview mode: the interviewer persona + a candidate-specific
// context assembled from the uploaded resume and (optional) job description.
// ---------------------------------------------------------------------------

export const INTERVIEW_SYSTEM =
  "You are a seasoned technical interviewer conducting a live, spoken interview. Ask exactly ONE question at a time, then wait for the candidate's answer. Ground every question in the candidate's actual resume — their real projects, work experience, and listed skills — and in the target role / job description when provided. Start broad on a project or role, then drill into specifics: their exact contribution, technical decisions, trade-offs, failures, and measurable results. Mix technical depth with behavioural questions. Keep each of your turns to 1-3 sentences so the candidate does most of the talking, and ask natural follow-ups that reference what they just said. Do not give feedback, hints, or model answers — stay in character as the interviewer. Only ask about technologies, projects, companies, and experience that actually appear in the resume/job description or that the candidate has already mentioned — never invent or assume tools, employers, or facts they haven't referenced, and if something is unclear ask them to clarify rather than guessing. Never mention that you are an AI.";

function clampChars(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : t.slice(0, max) + "\n…[truncated]";
}

/**
 * Build the per-turn scenario context for an interview. This is passed as the
 * `systemPrompt` override to /api/gemini so every question stays anchored to
 * this specific candidate.
 */
export function buildInterviewContext(input: {
  resumeText: string;
  jobDescription?: string | null;
  role?: string | null;
}): string {
  const resume = clampChars(input.resumeText, 6000);
  const jd = input.jobDescription ? clampChars(input.jobDescription, 2500) : "";
  const role = input.role?.trim();
  const parts = [
    INTERVIEW_SYSTEM,
    "",
    role ? `TARGET ROLE: ${role}` : "",
    "CANDIDATE RESUME:",
    "<<<RESUME>>>",
    resume,
    "<<<END RESUME>>>",
    jd ? "JOB DESCRIPTION:" : "",
    jd ? "<<<JOB DESCRIPTION>>>" : "",
    jd,
    jd ? "<<<END JOB DESCRIPTION>>>" : "",
    "Ask questions that are specifically relevant to this candidate's experience, projects, and the role above.",
  ].filter((p) => p !== "");
  return parts.join("\n");
}

/** Prompt to generate the interviewer's opening line + first question. */
export function interviewOpeningUserPrompt(context: string): string {
  return `${context}

This is the very start of the interview. In one short sentence, greet the candidate, then ask your first question — an opening question about the project or experience on their resume that is most relevant to the role. Ask only ONE question and keep it under 3 sentences.`;
}

/** Deterministic opening used when no model is configured or the model call fails. */
export function fallbackInterviewOpening(role?: string | null): string {
  const roleBit = role && role.trim() ? ` for the ${role.trim()} role` : "";
  return `Thanks for sharing your resume — let's get started${roleBit}. To begin, walk me through the project you're most proud of: what was your specific role, and what was the hardest technical problem you had to solve?`;
}

export const SUMMARY_SYSTEM =
  "You are a communication coach summarizing a practice session. Be warm, specific, and growth-oriented. Highlight 2-3 strengths and 2-3 actionable improvements. Keep it under 200 words.";

export function summaryUserPrompt(metrics: {
  fillerCount: number;
  confidence: number;
  wordCount: number;
  scenarioTitle: string;
  coachingEvents: { type: string; text: string }[];
}): string {
  return `Summarize this communication practice session:

Scenario: ${metrics.scenarioTitle}
Duration: ~${Math.max(1, Math.round(metrics.wordCount / 130))} min
Words spoken: ${metrics.wordCount}
Confidence score: ${metrics.confidence}/100
Filler words detected: ${metrics.fillerCount}

Coaching moments:
${metrics.coachingEvents.slice(0, 8).map((e) => `- ${e.type}: "${e.text}"`).join("\n") || "None"}

Write a warm, specific summary with 2-3 strengths and 2-3 improvements.`;
}

export async function generateWithSarvam(system: string, user: string, opts?: { temperature?: number; maxTokens?: number }): Promise<string> {
  return sarvamChat(system, user, {
    temperature: opts?.temperature ?? 0.4,
    maxTokens: opts?.maxTokens ?? env.SARVAM_MAX_TOKENS,
  });
}

export async function generateWithGemini(system: string, user: string, opts?: { temperature?: number; maxTokens?: number }): Promise<string> {
  try {
    return await geminiChat(system, user, opts);
  } catch (e) {
    log.warn("gemini fallback to sarvam", { error: (e as Error).message });
    return generateWithSarvam(system, user, opts);
  }
}
