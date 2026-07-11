import { sarvamChat } from "./sarvam";
import { geminiChat } from "./gemini";
import { env } from "./env";
import { logger } from "./logger";

const log = logger.child({ module: "prompts" });

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

export const GEMMA_COACHING_SYSTEM =
  "You are Gemma, a private communication coach. Your job is to detect communication weaknesses in real time and provide gentle, actionable coaching. Focus on: filler words, hesitation markers, rambling, weak structure, confidence drops, and repetitive language. Be concise and supportive. Output JSON only.";

export function gemmaCoachingUserPrompt(transcript: string, recentMessages?: { content: string }[]): string {
  const recent = recentMessages?.length
    ? `\n\nRecent context:\n${recentMessages.map((m, i) => `${i + 1}. ${m.content}`).join("\n")}`
    : "";
  return `Analyze this learner response for communication coaching opportunities:

"${transcript}"
${recent}

Output JSON:
{
  "fillerWords": string[],
  "hesitations": string[],
  "ramble": boolean,
  "weakStructure": boolean,
  "confidenceDrop": boolean,
  "repetitivePhrases": string[],
  "positiveHighlights": string[],
  "suggestion": string
}`;
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
