import { NextRequest, NextResponse } from "next/server";
import { GeminiChatBody } from "@/lib/schemas";
import { geminiChat, geminiConfigured } from "@/lib/gemini";
import { getScenario } from "@/lib/scenarios";
import { logger } from "@/lib/logger";
import { newRequestId, errorResponse, enforceRateLimit, parseJsonBody, ValidationError } from "@/lib/http";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * POST /api/gemini - Gemini Live conversation turn.
 * Accepts a messages array + scenarioId, builds the conversation prompt from the scenario's system
 * prompt, and returns the partner's reply.
 */
export async function POST(req: NextRequest) {
  const requestId = newRequestId();
  const log = logger.child({ requestId, route: "gemini" });
  const limited = enforceRateLimit(req, "gemini", requestId, { max: 30, windowMs: 60_000 });
  if (limited) return limited;

  let body;
  try {
    body = await parseJsonBody(req, GeminiChatBody);
  } catch (e) {
    if (e instanceof ValidationError) return errorResponse(400, "invalid_body", "Invalid request body.", requestId, { details: e.details });
    throw e;
  }

  if (!geminiConfigured()) {
    return errorResponse(503, "service_unconfigured", "Gemini is unavailable: GEMINI_API_KEY is not configured.", requestId);
  }

  const scenario = getScenario(body.scenarioId);
  const system = body.systemPrompt ?? scenario?.systemPrompt ?? "You are a warm, realistic conversation partner in a high-stakes practice scenario. Keep responses concise (2-4 sentences) so the learner gets plenty of speaking time. Never break character.";
  const lastUser = [...body.messages].reverse().find((m) => m.role === "user");
  if (!lastUser) {
    return errorResponse(400, "no_user_message", "No learner message found in the conversation.", requestId);
  }
  const history = body.messages.map((m) => `${m.role === "user" ? "Learner" : "Partner"}: ${m.content}`).join("\n");
  const userPrompt = `${history}\n\nRespond as the partner to the learner's last message (2-4 sentences).`;

  try {
    const reply = await geminiChat(system, userPrompt, { temperature: 0.7, maxTokens: 800 });
    log.info("gemini reply generated", { scenarioId: body.scenarioId, chars: reply.length });
    return NextResponse.json({ reply, model: "gemini", scenarioId: body.scenarioId });
  } catch (e) {
    log.error("gemini chat failed", { error: e });
    return errorResponse(502, "gemini_failed", `Gemini failed: ${(e as Error).message}`, requestId);
  }
}
