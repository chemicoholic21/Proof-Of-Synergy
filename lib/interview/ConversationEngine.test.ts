import { describe, it, expect } from "vitest";
import { ConversationEngine, INTERVIEW_ACTIONS, type InterviewTurnResponse } from "./ConversationEngine";
import type { LLMGenerateOptions, LLMMessage, LLMProvider, LLMResult, LLMTokenCallback } from "../providers/llm/types";

/** In-memory `LLMProvider` test double that returns queued responses in order (or throws a queued
 *  Error), recording every call — no network, matching this repo's plain-DI test style. */
class FakeLLMProvider implements LLMProvider {
  calls: Array<{ messages: LLMMessage[]; opts?: LLMGenerateOptions }> = [];
  private queue: Array<string | Error>;

  constructor(responses: Array<string | Error>) {
    this.queue = [...responses];
  }

  async generate(messages: LLMMessage[], opts?: LLMGenerateOptions): Promise<LLMResult> {
    this.calls.push({ messages, opts });
    const next = this.queue.shift();
    if (next === undefined) throw new Error("FakeLLMProvider: no more queued responses");
    if (next instanceof Error) throw next;
    return { text: next };
  }

  async generateStream(_messages: LLMMessage[], _onToken: LLMTokenCallback): Promise<LLMResult> {
    throw new Error("ConversationEngine should never call generateStream() — structured output needs the full reply");
  }
}

function history(...turns: LLMMessage[]): LLMMessage[] {
  return turns;
}

const VALID_JSON = JSON.stringify({
  action: "FOLLOW_UP",
  speech: "Can you explain that further?",
  topic: "distributed systems",
  evaluation_required: true,
});

describe("ConversationEngine.nextTurn()", () => {
  it("parses a valid structured response and passes the system prompt + history to the LLM", async () => {
    const llm = new FakeLLMProvider([VALID_JSON]);
    const engine = new ConversationEngine({ llm });
    const messages = history({ role: "user", content: "A CDN caches static assets close to users." });

    const result = await engine.nextTurn(messages);

    expect(result).toEqual<InterviewTurnResponse>({
      action: "FOLLOW_UP",
      speech: "Can you explain that further?",
      topic: "distributed systems",
      evaluation_required: true,
    });
    expect(llm.calls).toHaveLength(1);
    const [{ messages: sent, opts }] = llm.calls;
    expect(sent[0].role).toBe("system");
    expect(sent[0].content).toContain("FOLLOW_UP");
    expect(sent.slice(1)).toEqual(messages);
    expect(opts?.temperature).toBeTypeOf("number");
    expect(opts?.maxTokens).toBeTypeOf("number");
  });

  it("accepts a response wrapped in a markdown code fence", async () => {
    const llm = new FakeLLMProvider(["```json\n" + VALID_JSON + "\n```"]);
    const engine = new ConversationEngine({ llm });
    const result = await engine.nextTurn(history({ role: "user", content: "answer" }));
    expect(result.action).toBe("FOLLOW_UP");
  });

  it("accepts every declared InterviewAction", async () => {
    for (const action of INTERVIEW_ACTIONS) {
      const llm = new FakeLLMProvider([
        JSON.stringify({ action, speech: "Okay.", topic: "general", evaluation_required: false }),
      ]);
      const engine = new ConversationEngine({ llm });
      const result = await engine.nextTurn(history({ role: "user", content: "x" }));
      expect(result.action).toBe(action);
    }
  });

  it("clamps an overly long speech field to keep spoken responses concise", async () => {
    const longSpeech = "This is a very long thing to say. ".repeat(20); // > 320 chars
    const llm = new FakeLLMProvider([
      JSON.stringify({ action: "NEXT_QUESTION", speech: longSpeech, topic: "general", evaluation_required: true }),
    ]);
    const engine = new ConversationEngine({ llm });
    const result = await engine.nextTurn(history({ role: "user", content: "x" }));
    expect(result.speech.length).toBeLessThanOrEqual(320);
    expect(longSpeech.length).toBeGreaterThan(320);
  });

  it("forwards temperature/maxTokens overrides and the caller's AbortSignal", async () => {
    const llm = new FakeLLMProvider([VALID_JSON]);
    const engine = new ConversationEngine({ llm, temperature: 0.9, maxTokens: 111 });
    const controller = new AbortController();
    await engine.nextTurn(history({ role: "user", content: "x" }), { signal: controller.signal });
    expect(llm.calls[0].opts).toMatchObject({ temperature: 0.9, maxTokens: 111, signal: controller.signal });
  });

  it("retries once with a corrective nudge when the first response isn't valid JSON, and succeeds", async () => {
    const llm = new FakeLLMProvider(["not json at all, sorry", VALID_JSON]);
    const engine = new ConversationEngine({ llm });
    const result = await engine.nextTurn(history({ role: "user", content: "x" }));

    expect(result.action).toBe("FOLLOW_UP");
    expect(llm.calls).toHaveLength(2);
    const retryMessages = llm.calls[1].messages;
    expect(retryMessages.at(-2)).toEqual({ role: "assistant", content: "not json at all, sorry" });
    expect(retryMessages.at(-1)?.role).toBe("user");
    expect(retryMessages.at(-1)?.content).toMatch(/valid JSON/i);
  });

  it("retries once when JSON parses but fails schema validation (bad action enum)", async () => {
    const badAction = JSON.stringify({ action: "MAYBE_LATER", speech: "hi", topic: "x", evaluation_required: false });
    const llm = new FakeLLMProvider([badAction, VALID_JSON]);
    const engine = new ConversationEngine({ llm });
    const result = await engine.nextTurn(history({ role: "user", content: "x" }));
    expect(result.action).toBe("FOLLOW_UP");
    expect(llm.calls).toHaveLength(2);
  });

  it("retries when a required field is missing", async () => {
    const missingSpeech = JSON.stringify({ action: "NEXT_QUESTION", topic: "x", evaluation_required: false });
    const llm = new FakeLLMProvider([missingSpeech, VALID_JSON]);
    const engine = new ConversationEngine({ llm });
    const result = await engine.nextTurn(history({ role: "user", content: "x" }));
    expect(result.action).toBe("FOLLOW_UP");
  });

  it("falls back to a generic ACKNOWLEDGE response (never throws) if both attempts are invalid", async () => {
    const llm = new FakeLLMProvider(["garbage one", "garbage two"]);
    const engine = new ConversationEngine({ llm });
    const result = await engine.nextTurn(
      history({ role: "assistant", content: "Tell me about caching." }, { role: "user", content: "I use Redis for caching." })
    );

    expect(result.action).toBe("ACKNOWLEDGE");
    expect(result.evaluation_required).toBe(false);
    expect(typeof result.speech).toBe("string");
    expect(result.speech.length).toBeGreaterThan(0);
    // Falls back to the most recent non-empty message content as a best-effort topic guess.
    expect(result.topic).toBe("I use Redis for caching.");
    expect(llm.calls).toHaveLength(2); // exactly one retry, then gives up
  });

  it("falls back to 'general' when there's no history to infer a topic from", async () => {
    const llm = new FakeLLMProvider(["garbage one", "garbage two"]);
    const engine = new ConversationEngine({ llm });
    const result = await engine.nextTurn([]);
    expect(result.topic).toBe("general");
  });

  it("propagates an underlying LLMProvider failure instead of falling back", async () => {
    const llm = new FakeLLMProvider([new Error("network blip")]);
    const engine = new ConversationEngine({ llm });
    await expect(engine.nextTurn(history({ role: "user", content: "x" }))).rejects.toThrow("network blip");
  });

  it("merges caller-supplied systemPrompt context after the built-in schema instructions", async () => {
    const llm = new FakeLLMProvider([VALID_JSON]);
    const engine = new ConversationEngine({ llm, systemPrompt: "The candidate's resume lists Go and Kubernetes." });
    await engine.nextTurn(history({ role: "user", content: "x" }));
    const systemMessage = llm.calls[0].messages[0].content;
    expect(systemMessage).toContain("FOLLOW_UP");
    expect(systemMessage).toContain("The candidate's resume lists Go and Kubernetes.");
    expect(systemMessage.indexOf("FOLLOW_UP")).toBeLessThan(systemMessage.indexOf("resume lists"));
  });

  it("includes the suggested interviewer persona and behavioral rules ahead of the structured-output contract", async () => {
    const llm = new FakeLLMProvider([VALID_JSON]);
    const engine = new ConversationEngine({ llm });
    await engine.nextTurn(history({ role: "user", content: "x" }));
    const systemMessage = llm.calls[0].messages[0].content;

    expect(systemMessage).toContain("professional technical interviewer conducting a live voice interview");
    expect(systemMessage).toContain("Prefer 10 to 40 words");
    expect(systemMessage).toContain("Do not reveal internal scoring");
    expect(systemMessage).toContain("If the candidate interrupts, immediately stop the previous conversational thread");
    // The persona/rules come first, then the structured-output contract explains how to express them.
    expect(systemMessage.indexOf("professional technical interviewer")).toBeLessThan(
      systemMessage.indexOf("structured output")
    );
  });

  it("never calls generateStream() — structured output requires the complete reply", async () => {
    const llm = new FakeLLMProvider([VALID_JSON]);
    const engine = new ConversationEngine({ llm });
    await expect(engine.nextTurn(history({ role: "user", content: "x" }))).resolves.toBeDefined();
  });
});

describe("ConversationEngine construction", () => {
  it("constructs with no arguments (defaults to a SarvamLLM targeting CONVERSATION_MODEL)", () => {
    expect(() => new ConversationEngine()).not.toThrow();
  });

  it("accepts a model override without requiring a full custom LLMProvider", () => {
    expect(() => new ConversationEngine({ model: "sarvam-105b" })).not.toThrow();
  });
});
