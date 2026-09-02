import { describe, it, expect } from "vitest";
import { EvidenceEvaluator, isQuoteGrounded, type EvidenceEvaluation } from "./EvidenceEvaluator";
import type { LLMGenerateOptions, LLMMessage, LLMProvider, LLMResult, LLMTokenCallback } from "../providers/llm/types";

/** In-memory `LLMProvider` test double that returns queued responses in order (or throws a queued
 *  Error), recording every call — matching lib/interview/ConversationEngine.test.ts's FakeLLMProvider. */
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
    throw new Error("EvidenceEvaluator should never call generateStream()");
  }
}

const ANSWER = "I used Redis for caching and I designed the schema to support fast lookups.";

const VALID_JSON = JSON.stringify({
  technical_correctness: 8,
  technical_depth: 7,
  communication: 9,
  evidence: [{ quote: "I used Redis for caching", assessment: "demonstrates relevant experience" }],
  follow_up_opportunity: "Ask about cache invalidation",
});

describe("EvidenceEvaluator.evaluate()", () => {
  it("parses a valid evidence-grounded response and returns it as-is", async () => {
    const llm = new FakeLLMProvider([VALID_JSON]);
    const evaluator = new EvidenceEvaluator({ llm });

    const result = await evaluator.evaluate({ answer: ANSWER, question: "How did you handle caching?" });

    expect(result).toEqual<EvidenceEvaluation>({
      technical_correctness: 8,
      technical_depth: 7,
      communication: 9,
      evidence: [{ quote: "I used Redis for caching", assessment: "demonstrates relevant experience" }],
      follow_up_opportunity: "Ask about cache invalidation",
    });
    expect(llm.calls).toHaveLength(1);
  });

  it("includes the question, topic, and answer in the user prompt sent to the LLM", async () => {
    const llm = new FakeLLMProvider([VALID_JSON]);
    const evaluator = new EvidenceEvaluator({ llm });
    await evaluator.evaluate({ answer: ANSWER, question: "How did you handle caching?", topic: "caching" });

    const userMessage = llm.calls[0].messages[1];
    expect(userMessage.role).toBe("user");
    expect(userMessage.content).toContain("How did you handle caching?");
    expect(userMessage.content).toContain("Topic: caching");
    expect(userMessage.content).toContain(ANSWER);
  });

  it("notes the question as not provided when omitted, rather than silently dropping the field", async () => {
    const llm = new FakeLLMProvider([VALID_JSON]);
    const evaluator = new EvidenceEvaluator({ llm });
    await evaluator.evaluate({ answer: ANSWER });
    expect(llm.calls[0].messages[1].content).toContain("(not provided)");
  });

  it("accepts a response wrapped in a markdown code fence", async () => {
    const llm = new FakeLLMProvider(["```json\n" + VALID_JSON + "\n```"]);
    const evaluator = new EvidenceEvaluator({ llm });
    const result = await evaluator.evaluate({ answer: ANSWER });
    expect(result.technical_correctness).toBe(8);
  });

  it("drops an evidence quote that does not actually appear in the answer, keeping grounded ones", async () => {
    const mixed = JSON.stringify({
      technical_correctness: 6,
      technical_depth: 5,
      communication: 7,
      evidence: [
        { quote: "I used Redis for caching", assessment: "real, grounded quote" },
        { quote: "I scaled the system to ten million users", assessment: "fabricated — never said" },
      ],
      follow_up_opportunity: "Ask about scale",
    });
    const llm = new FakeLLMProvider([mixed]);
    const evaluator = new EvidenceEvaluator({ llm });
    const result = await evaluator.evaluate({ answer: ANSWER });

    expect(result.evidence).toEqual([{ quote: "I used Redis for caching", assessment: "real, grounded quote" }]);
  });

  it("retries once when every evidence quote in the first response is fabricated, and succeeds", async () => {
    const fullyFabricated = JSON.stringify({
      technical_correctness: 5,
      technical_depth: 5,
      communication: 5,
      evidence: [{ quote: "something the candidate never said", assessment: "made up" }],
      follow_up_opportunity: "n/a",
    });
    const llm = new FakeLLMProvider([fullyFabricated, VALID_JSON]);
    const evaluator = new EvidenceEvaluator({ llm });

    const result = await evaluator.evaluate({ answer: ANSWER });
    expect(result.evidence[0].quote).toBe("I used Redis for caching");
    expect(llm.calls).toHaveLength(2);
    const retryMessages = llm.calls[1].messages;
    expect(retryMessages.at(-1)?.content).toMatch(/not actually present/i);
  });

  it("retries once on invalid JSON, and succeeds", async () => {
    const llm = new FakeLLMProvider(["not json at all", VALID_JSON]);
    const evaluator = new EvidenceEvaluator({ llm });
    const result = await evaluator.evaluate({ answer: ANSWER });
    expect(result.technical_correctness).toBe(8);
    expect(llm.calls).toHaveLength(2);
  });

  it("retries once when a score is out of the 0-10 range", async () => {
    const outOfRange = JSON.stringify({
      technical_correctness: 15,
      technical_depth: 7,
      communication: 9,
      evidence: [],
      follow_up_opportunity: "n/a",
    });
    const llm = new FakeLLMProvider([outOfRange, VALID_JSON]);
    const evaluator = new EvidenceEvaluator({ llm });
    const result = await evaluator.evaluate({ answer: ANSWER });
    expect(result.technical_correctness).toBe(8);
  });

  it("retries once when a required field is missing", async () => {
    const missingCommunication = JSON.stringify({
      technical_correctness: 7,
      technical_depth: 6,
      evidence: [],
      follow_up_opportunity: "n/a",
    });
    const llm = new FakeLLMProvider([missingCommunication, VALID_JSON]);
    const evaluator = new EvidenceEvaluator({ llm });
    const result = await evaluator.evaluate({ answer: ANSWER });
    expect(result.technical_correctness).toBe(8);
  });

  it("throws (never fabricates a score) if both attempts return invalid JSON", async () => {
    const llm = new FakeLLMProvider(["garbage one", "garbage two"]);
    const evaluator = new EvidenceEvaluator({ llm });
    await expect(evaluator.evaluate({ answer: ANSWER })).rejects.toThrow(/could not obtain a valid/);
  });

  it("throws if both attempts are fully fabricated (no grounded evidence either time)", async () => {
    const fabricated = JSON.stringify({
      technical_correctness: 5,
      technical_depth: 5,
      communication: 5,
      evidence: [{ quote: "never said this", assessment: "made up" }],
      follow_up_opportunity: "n/a",
    });
    const llm = new FakeLLMProvider([fabricated, fabricated]);
    const evaluator = new EvidenceEvaluator({ llm });
    await expect(evaluator.evaluate({ answer: ANSWER })).rejects.toThrow(/could not obtain a valid/);
  });

  it("propagates an underlying LLMProvider failure instead of retrying or fabricating a score", async () => {
    const llm = new FakeLLMProvider([new Error("network blip")]);
    const evaluator = new EvidenceEvaluator({ llm });
    await expect(evaluator.evaluate({ answer: ANSWER })).rejects.toThrow("network blip");
    expect(llm.calls).toHaveLength(1); // no internal retry for a call-level failure
  });

  it("forwards the caller's AbortSignal", async () => {
    const llm = new FakeLLMProvider([VALID_JSON]);
    const evaluator = new EvidenceEvaluator({ llm });
    const controller = new AbortController();
    await evaluator.evaluate({ answer: ANSWER }, { signal: controller.signal });
    expect(llm.calls[0].opts?.signal).toBe(controller.signal);
  });

  it("merges systemPromptExtra between the persona/rules and the structured-output contract", async () => {
    const llm = new FakeLLMProvider([VALID_JSON]);
    const evaluator = new EvidenceEvaluator({ llm, systemPromptExtra: "Grade against a senior-engineer rubric." });
    await evaluator.evaluate({ answer: ANSWER });

    const systemMessage = llm.calls[0].messages[0].content;
    expect(systemMessage).toContain("evidence-based technical interview evaluator");
    expect(systemMessage).toContain("Grade against a senior-engineer rubric.");
    expect(systemMessage).toContain("Respond with ONLY a single JSON object");
    expect(systemMessage.indexOf("evidence-based technical interview evaluator")).toBeLessThan(
      systemMessage.indexOf("Grade against a senior-engineer rubric.")
    );
    expect(systemMessage.indexOf("Grade against a senior-engineer rubric.")).toBeLessThan(
      systemMessage.indexOf("Respond with ONLY a single JSON object")
    );
  });

  it("includes the given rules verbatim in the system prompt", async () => {
    const llm = new FakeLLMProvider([VALID_JSON]);
    const evaluator = new EvidenceEvaluator({ llm });
    await evaluator.evaluate({ answer: ANSWER });
    const systemMessage = llm.calls[0].messages[0].content;
    expect(systemMessage).toContain("Do not reward confidence without evidence.");
    expect(systemMessage).toContain("Do not invent information the candidate did not provide.");
  });
});

describe("isQuoteGrounded", () => {
  it("matches an exact substring", () => {
    expect(isQuoteGrounded(ANSWER, "I used Redis for caching")).toBe(true);
  });

  it("is case-insensitive and whitespace-normalized", () => {
    expect(isQuoteGrounded(ANSWER, "i   USED redis for CACHING")).toBe(true);
  });

  it("ignores surrounding quote marks and normalizes curly quotes", () => {
    expect(isQuoteGrounded(ANSWER, '"I used Redis for caching"')).toBe(true);
    expect(isQuoteGrounded("She said “hello there”", "hello there")).toBe(true);
  });

  it("returns false for text that isn't actually present", () => {
    expect(isQuoteGrounded(ANSWER, "I scaled to ten million users")).toBe(false);
  });

  it("returns false for an empty quote", () => {
    expect(isQuoteGrounded(ANSWER, "   ")).toBe(false);
  });
});

describe("EvidenceEvaluator construction", () => {
  it("constructs with no arguments (defaults to a SarvamLLM with its own default model)", () => {
    expect(() => new EvidenceEvaluator()).not.toThrow();
  });
});
