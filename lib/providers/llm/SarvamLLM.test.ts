import { describe, it, expect } from "vitest";
import { SarvamLLM } from "./SarvamLLM";
import type { LLMMessage } from "./types";

const MESSAGES: LLMMessage[] = [
  { role: "system", content: "You are a helpful interviewer." },
  { role: "user", content: "Tell me about yourself." },
];

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
    body: null,
  } as unknown as Response;
}

/** Fetch-shaped double that respects the AbortSignal it's given, mirroring real `fetch` behavior,
 *  so this file's cancellation/timeout tests exercise the same code path a real network call would. */
function abortAwareFetch(run: (init: RequestInit) => Promise<Response>): typeof fetch {
  return (async (_url: string, init?: RequestInit) => {
    const signal = init?.signal;
    if (signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
    return new Promise<Response>((resolve, reject) => {
      const onAbort = () => reject(new DOMException("The operation was aborted.", "AbortError"));
      signal?.addEventListener("abort", onAbort, { once: true });
      run(init ?? {}).then(
        (res) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(res);
        },
        (err) => {
          signal?.removeEventListener("abort", onAbort);
          reject(err);
        }
      );
    });
  }) as unknown as typeof fetch;
}

/** Manually-driven fake for a streaming response body — gives tests exact control over when each
 *  chunk "arrives" and when the stream ends, without depending on real ReadableStream timing. */
class FakeStreamBody {
  private queue: Uint8Array[] = [];
  private waiters: Array<(r: { done: boolean; value?: Uint8Array }) => void> = [];
  private closed = false;
  cancelled = false;

  push(text: string): void {
    const bytes = new TextEncoder().encode(text);
    const waiter = this.waiters.shift();
    if (waiter) waiter({ done: false, value: bytes });
    else this.queue.push(bytes);
  }

  close(): void {
    this.closed = true;
    while (this.waiters.length > 0) this.waiters.shift()!({ done: true, value: undefined });
  }

  getReader() {
    return {
      read: (): Promise<{ done: boolean; value?: Uint8Array }> => {
        const next = this.queue.shift();
        if (next) return Promise.resolve({ done: false, value: next });
        if (this.closed) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
      cancel: async () => {
        this.cancelled = true;
      },
      releaseLock: () => {},
    };
  }
}

function streamResponse(body: FakeStreamBody): Response {
  return { ok: true, status: 200, body: body as unknown as ReadableStream<Uint8Array>, text: async () => "" } as unknown as Response;
}

/** Waits for one full microtask-queue drain — enough for this file's push()-driven fake stream
 *  reads (no real timers involved) to settle before the next assertion. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("SarvamLLM.generate()", () => {
  it("posts the expected body/headers and returns the parsed completion", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return jsonResponse(200, {
        model: "sarvam-105b",
        choices: [{ message: { content: "Sure — I'm a backend engineer." }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
    }) as unknown as typeof fetch;

    const llm = new SarvamLLM({ apiKey: "test-key", fetchImpl });
    const result = await llm.generate(MESSAGES, { temperature: 0.5, maxTokens: 200 });

    expect(capturedUrl).toBe("https://api.sarvam.ai/v1/chat/completions");
    expect(capturedInit?.headers).toMatchObject({ "api-subscription-key": "test-key" });
    const body = JSON.parse(capturedInit?.body as string);
    expect(body).toMatchObject({ model: "sarvam-105b", messages: MESSAGES, temperature: 0.5, max_tokens: 200, stream: false });

    expect(result).toEqual({
      text: "Sure — I'm a backend engineer.",
      model: "sarvam-105b",
      finishReason: "stop",
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    });
  });

  it("clamps maxTokens to the configured ceiling", async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      body = JSON.parse(init?.body as string);
      return jsonResponse(200, { choices: [{ message: { content: "ok" } }] });
    }) as unknown as typeof fetch;

    const llm = new SarvamLLM({ apiKey: "k", fetchImpl, maxTokensCeiling: 100 });
    await llm.generate(MESSAGES, { maxTokens: 99999 });
    expect(body.max_tokens).toBe(100);
  });

  it("strips <think>...</think> reasoning content before returning text", async () => {
    const fetchImpl = (async () =>
      jsonResponse(200, { choices: [{ message: { content: "<think>hmm let me consider</think>The answer is 42." } }] })) as unknown as typeof fetch;
    const llm = new SarvamLLM({ apiKey: "k", fetchImpl });
    const result = await llm.generate(MESSAGES);
    expect(result.text).toBe("The answer is 42.");
  });

  it("throws when the response content is empty after stripping reasoning", async () => {
    const fetchImpl = (async () =>
      jsonResponse(200, { choices: [{ message: { content: "<think>only thinking</think>" }, finish_reason: "length" }] })) as unknown as typeof fetch;
    const llm = new SarvamLLM({ apiKey: "k", fetchImpl });
    await expect(llm.generate(MESSAGES)).rejects.toThrow(/empty content/);
  });

  it("throws with the status and body text on a non-2xx response", async () => {
    const fetchImpl = (async () => jsonResponse(401, { error: "bad key" })) as unknown as typeof fetch;
    const llm = new SarvamLLM({ apiKey: "k", fetchImpl });
    await expect(llm.generate(MESSAGES)).rejects.toThrow(/Sarvam chat 401/);
  });

  it("rejects immediately with SARVAM_API_KEY message if no key is configured", async () => {
    const llm = new SarvamLLM({ apiKey: "" });
    await expect(llm.generate(MESSAGES)).rejects.toThrow(/SARVAM_API_KEY/);
  });

  it("rejects with an AbortError when the caller's signal is aborted before the call resolves", async () => {
    const controller = new AbortController();
    const fetchImpl = abortAwareFetch(() => new Promise(() => {})); // never resolves on its own
    const llm = new SarvamLLM({ apiKey: "k", fetchImpl, timeoutMs: 60_000 });

    const resultPromise = llm.generate(MESSAGES, { signal: controller.signal });
    controller.abort();

    await expect(resultPromise).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects with an AbortError when the internal timeout elapses", async () => {
    const fetchImpl = abortAwareFetch(() => new Promise(() => {})); // never resolves
    const llm = new SarvamLLM({ apiKey: "k", fetchImpl, timeoutMs: 10 });
    await expect(llm.generate(MESSAGES)).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("SarvamLLM.generateStream()", () => {
  it("delivers each delta to onToken and resolves with the full assembled text on [DONE]", async () => {
    const body = new FakeStreamBody();
    const fetchImpl = (async () => streamResponse(body)) as unknown as typeof fetch;
    const llm = new SarvamLLM({ apiKey: "k", fetchImpl });

    const tokens: string[] = [];
    const resultPromise = llm.generateStream(MESSAGES, (t) => tokens.push(t));

    body.push('data: {"model":"sarvam-105b","choices":[{"delta":{"content":"Sure"}}]}\n\n');
    body.push('data: {"choices":[{"delta":{"content":" — I write"}}]}\n\n');
    body.push('data: {"choices":[{"delta":{"content":" backend code."},"finish_reason":"stop"}]}\n\n');
    body.push("data: [DONE]\n\n");
    body.close();

    const result = await resultPromise;
    expect(tokens).toEqual(["Sure", " — I write", " backend code."]);
    expect(result).toEqual({ text: "Sure — I write backend code.", model: "sarvam-105b", finishReason: "stop", usage: undefined });
  });

  it("handles a chunk split across two reads (a data: line straddling a read boundary)", async () => {
    const body = new FakeStreamBody();
    const fetchImpl = (async () => streamResponse(body)) as unknown as typeof fetch;
    const llm = new SarvamLLM({ apiKey: "k", fetchImpl });

    const tokens: string[] = [];
    const resultPromise = llm.generateStream(MESSAGES, (t) => tokens.push(t));

    body.push('data: {"choices":[{"delta":{"content":"Hel');
    body.push('lo there"}}]}\n\n');
    body.push("data: [DONE]\n\n");
    body.close();

    const result = await resultPromise;
    expect(tokens).toEqual(["Hello there"]);
    expect(result.text).toBe("Hello there");
  });

  it("strips <think> reasoning content from the final streamed text", async () => {
    const body = new FakeStreamBody();
    const fetchImpl = (async () => streamResponse(body)) as unknown as typeof fetch;
    const llm = new SarvamLLM({ apiKey: "k", fetchImpl });

    const resultPromise = llm.generateStream(MESSAGES, () => {});
    body.push('data: {"choices":[{"delta":{"content":"<think>hmm</think>Final answer."}}]}\n\n');
    body.push("data: [DONE]\n\n");
    body.close();

    expect((await resultPromise).text).toBe("Final answer.");
  });

  it("ends cleanly when the stream just closes without an explicit [DONE] line", async () => {
    const body = new FakeStreamBody();
    const fetchImpl = (async () => streamResponse(body)) as unknown as typeof fetch;
    const llm = new SarvamLLM({ apiKey: "k", fetchImpl });

    const resultPromise = llm.generateStream(MESSAGES, () => {});
    body.push('data: {"choices":[{"delta":{"content":"done anyway"}}]}\n\n');
    body.close();

    expect((await resultPromise).text).toBe("done anyway");
  });

  it("isolates a throwing onToken callback — the stream keeps assembling text regardless", async () => {
    const body = new FakeStreamBody();
    const fetchImpl = (async () => streamResponse(body)) as unknown as typeof fetch;
    const llm = new SarvamLLM({ apiKey: "k", fetchImpl });

    let calls = 0;
    const resultPromise = llm.generateStream(MESSAGES, () => {
      calls++;
      throw new Error("consumer bug");
    });
    body.push('data: {"choices":[{"delta":{"content":"a"}}]}\n\n');
    body.push('data: {"choices":[{"delta":{"content":"b"}}]}\n\n');
    body.push("data: [DONE]\n\n");
    body.close();

    const result = await resultPromise;
    expect(calls).toBe(2);
    expect(result.text).toBe("ab"); // assembly is unaffected by the callback throwing
  });

  it("ignores malformed/non-JSON data lines instead of failing the whole stream", async () => {
    const body = new FakeStreamBody();
    const fetchImpl = (async () => streamResponse(body)) as unknown as typeof fetch;
    const llm = new SarvamLLM({ apiKey: "k", fetchImpl });

    const tokens: string[] = [];
    const resultPromise = llm.generateStream(MESSAGES, (t) => tokens.push(t));
    body.push("data: not json at all\n\n");
    body.push('data: {"choices":[{"delta":{"content":"still works"}}]}\n\n');
    body.push("data: [DONE]\n\n");
    body.close();

    expect((await resultPromise).text).toBe("still works");
    expect(tokens).toEqual(["still works"]);
  });

  it("stops delivering tokens and rejects with AbortError once aborted mid-stream", async () => {
    const body = new FakeStreamBody();
    const fetchImpl = (async () => streamResponse(body)) as unknown as typeof fetch;
    const llm = new SarvamLLM({ apiKey: "k", fetchImpl });
    const controller = new AbortController();

    const tokens: string[] = [];
    const resultPromise = llm.generateStream(MESSAGES, (t) => tokens.push(t), { signal: controller.signal });

    body.push('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n');
    await flush();
    expect(tokens).toEqual(["Hello"]);

    controller.abort();
    body.push('data: {"choices":[{"delta":{"content":" World"}}]}\n\n'); // must never be consumed
    body.close();

    await expect(resultPromise).rejects.toMatchObject({ name: "AbortError" });
    expect(tokens).toEqual(["Hello"]); // the post-abort chunk never reached onToken
  });

  it("throws if the fetch response has no body", async () => {
    const fetchImpl = (async () => ({ ok: true, status: 200, body: null, text: async () => "" }) as unknown as Response) as unknown as typeof fetch;
    const llm = new SarvamLLM({ apiKey: "k", fetchImpl });
    await expect(llm.generateStream(MESSAGES, () => {})).rejects.toThrow(/no body/);
  });

  it("rejects immediately with SARVAM_API_KEY message if no key is configured", async () => {
    const llm = new SarvamLLM({ apiKey: "" });
    await expect(llm.generateStream(MESSAGES, () => {})).rejects.toThrow(/SARVAM_API_KEY/);
  });
});
