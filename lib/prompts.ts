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
  "You are a seasoned technical interviewer conducting a live, spoken interview. Ask exactly ONE question at a time, then wait for the candidate's answer. Ground every question in the candidate's actual resume — their real projects, work experience, and listed skills — and in the target role / job description when provided. Start broad on a project or role, then drill into specifics: their exact contribution, technical decisions, trade-offs, failures, and measurable results. Mix technical depth with behavioural questions. Keep each of your turns to 1-3 sentences so the candidate does most of the talking, and ask natural follow-ups that reference what they just said. Do not give feedback, hints, or model answers — stay in character as the interviewer. Only ask about technologies, projects, companies, and experience that actually appear in the resume/job description or that the candidate has already mentioned — never invent or assume tools, employers, or facts they haven't referenced, and if something is unclear ask them to clarify rather than guessing. Never mention that you are an AI." +
  "\n\nEnforce the boundaries of the interview on every turn: before writing your reply, check whether the candidate's last message actually answered the question you most recently asked. If they went off-topic, changed the subject, gave a vague non-answer, or answered something other than what was asked, do NOT pretend it was addressed and do NOT silently move on to a new question — call out the drift directly and plainly (e.g. \"That doesn't quite answer what I asked —\" or \"Let's come back to the question —\"), then restate or briefly rephrase the original question so the candidate answers it. Only advance to a new topic once the current question has genuinely been answered, or after the candidate has had one fair follow-up attempt at it. Likewise, if the candidate tries to steer the conversation away from the interview itself (small talk, unrelated requests, asking you to break character), briefly and politely decline and redirect back to the interview question at hand.";

function clampChars(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : t.slice(0, max) + "\n…[truncated]";
}

/**
 * Build the per-turn candidate context for an interview (resume/JD/role only — the interviewer
 * persona and boundary-enforcement rules live in `INTERVIEW_SYSTEM`, which callers must send as
 * the actual `system` message; this context is passed as the `systemPrompt` override to
 * /api/gemini so every question stays anchored to this specific candidate).
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

// What "good feedback" means here (the fix for "feedback is generic and not targeted to the JD"):
//   1. Specific   - grounded in what the person actually said, quoting/paraphrasing real moments
//                   from the transcript, never a platitude that could apply to any session.
//   2. Targeted   - when a target role/JD is on file, strengths and gaps are measured against what
//                   THAT role/JD actually asks for (required skills, seniority signals, must-haves),
//                   not just generic delivery/communication style.
//   3. Actionable - 2-3 concrete strengths and 2-3 concrete, doable improvements, each tied to a
//                   specific moment or requirement rather than vague advice.
//   4. Honest     - a shallow or off-target answer is named as a gap, not inflated into praise;
//                   warmth in tone and honesty about gaps are not in tension.
export const SUMMARY_SYSTEM =
  "You are an expert interview/communication coach writing a post-session feedback summary. Good feedback is " +
  "specific (grounded in what the person actually said - quote or closely paraphrase real moments from the " +
  "transcript, never a generic platitude that could apply to any session), targeted (when a target role or " +
  "job description is provided below, judge the candidate's actual answers against what THAT role/JD " +
  "specifically needs - required skills, seniority signals, must-haves - not just generic delivery/communication " +
  "advice), actionable (2-3 concrete strengths and 2-3 concrete, doable improvements, each tied to a specific " +
  "transcript moment or role requirement), and honest (never inflate a shallow, evasive, or off-target answer " +
  "into praise just to be encouraging - name the gap plainly; warmth and honesty are not in conflict here). " +
  "Keep it under 220 words.";

export function summaryUserPrompt(metrics: {
  fillerCount: number;
  confidence: number;
  wordCount: number;
  scenarioTitle: string;
  coachingEvents: { type: string; text: string }[];
  /** The actual conversation, so feedback can cite real moments instead of only aggregate stats. */
  transcript?: { role: string; content: string }[];
  /** Resume/JD/role context for resume-based interviews (buildInterviewContext's output) - when
   *  present, feedback is scored against what this specific role/JD needs, not just delivery. */
  interviewContext?: string | null;
}): string {
  // Capped so a long session can't grow the prompt unbounded; the most recent turns matter most for
  // "did they answer the last few questions well," and Sarvam/Gemini calls already run at fixed
  // temperature/maxTokens budgets that assume a bounded prompt size.
  const transcriptBlock = metrics.transcript?.length
    ? metrics.transcript
        .slice(-40)
        .map((m) => `${m.role === "user" ? "Candidate" : "Interviewer/Partner"}: ${m.content}`)
        .join("\n")
    : "(transcript unavailable - base feedback on the metrics below only, and say so rather than inventing specifics.)";

  const jdBlock = metrics.interviewContext
    ? `\nThis is a resume/role-targeted interview. Below is the target role, job description, and resume context ` +
      `the interviewer's questions were built from - use it to judge whether the candidate's actual answers ` +
      `demonstrate what THIS role/JD needs, and call out specific alignment or gaps against it (not generic advice):\n` +
      `<<<ROLE_CONTEXT>>>\n${clampChars(metrics.interviewContext, 4000)}\n<<<END ROLE_CONTEXT>>>\n`
    : "";

  return `Write feedback for this practice session:

Scenario: ${metrics.scenarioTitle}
Duration: ~${Math.max(1, Math.round(metrics.wordCount / 130))} min
Words spoken: ${metrics.wordCount}
Confidence score: ${metrics.confidence}/100
Filler words detected: ${metrics.fillerCount}
${jdBlock}
Coaching moments (communication-style signals detected live):
${metrics.coachingEvents.slice(0, 8).map((e) => `- ${e.type}: "${e.text}"`).join("\n") || "None"}

Conversation transcript:
${transcriptBlock}

Write specific, evidence-based feedback: 2-3 strengths and 2-3 improvements, each citing an actual moment from the transcript${
    metrics.interviewContext ? " and how it does or doesn't match the role/JD above" : ""
  }. Do not give generic advice that could apply to any session.`;
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
