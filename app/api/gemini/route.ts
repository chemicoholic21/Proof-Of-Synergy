import { NextRequest, NextResponse } from "next/server";
import { GeminiChatBody } from "@/lib/schemas";
import { resolvedGeminiModel } from "@/lib/gemini";
import { SCENARIO_SYSTEM, scenarioUserPrompt, generatePartnerReply, anyChatConfigured } from "@/lib/prompts";
import { getScenario } from "@/lib/scenarios";
import { logger } from "@/lib/logger";
import { traceChain, setSpanOutput, setVoiceLatencyMetrics } from "@/lib/tracing";
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

  if (!anyChatConfigured()) {
    return errorResponse(503, "service_unconfigured", "No chat model is configured. Set SARVAM_API_KEY (preferred) or GEMINI_API_KEY.", requestId);
  }

  const scenario = getScenario(body.scenarioId);
  const lastUser = [...body.messages].reverse().find((m) => m.role === "user");
  if (!lastUser) {
    return errorResponse(400, "no_user_message", "No learner message found in the conversation.", requestId);
  }
  const scenarioContext = body.systemPrompt ?? scenario?.systemPrompt ?? "";
  const userPrompt = scenarioUserPrompt(body.messages, scenarioContext);

  // One conversation turn = one chain span; the backing sarvam.chat / gemini.chat LLM span nests
  // under it, so an interview shows up as a sequence of end-to-end turn traces in Phoenix.
  return traceChain(
    "conversation.turn",
    { input: lastUser.content, metadata: { scenarioId: body.scenarioId, turns: body.messages.length } },
    async (span) => {
      // The chat call isn't streamed today, so `llm_first_token` lands at the same instant as
      // `llm_end` — llmTimeToFirstTokenMs and llmTotalMs will read identical until it is.
      const llmStart = Date.now();
      try {
        const reply = await generatePartnerReply(SCENARIO_SYSTEM, userPrompt, { temperature: 0.7, maxTokens: 800 });
        const llmEnd = Date.now();
        const timing = { llm_start: llmStart, llm_first_token: llmEnd, llm_end: llmEnd };
        const model = resolvedGeminiModel() ?? "sarvam";
        setSpanOutput(span, reply);
        setVoiceLatencyMetrics(span, {}, timing);
        log.info("partner reply generated", {
          scenarioId: body.scenarioId,
          model,
          chars: reply.length,
          llmMs: llmEnd - llmStart,
        });
        return NextResponse.json({ reply, model, scenarioId: body.scenarioId, timing });
      } catch (e) {
        log.error("partner reply failed", { error: e });
        return errorResponse(502, "chat_failed", `Chat generation failed: ${(e as Error).message}`, requestId);
      }
    }
  );
}
