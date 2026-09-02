/**
 * `LLMProvider` implementation over Sarvam's OpenAI-compatible chat completions endpoint
 * (`POST https://api.sarvam.ai/v1/chat/completions`), with genuine token streaming and
 * cancellation — the two things `lib/sarvam.ts`'s existing `sarvamChat` doesn't support (it always
 * waits for the full response and accepts no `AbortSignal`).
 *
 * This is a new, independent client, not a wrapper around `sarvamChat`: `lib/sarvam.ts` and
 * `lib/prompts.ts` (and therefore `app/api/gemini/route.ts` and the rest of today's interview
 * flow) are completely untouched by this file — nothing here changes current interview behavior.
 * `SarvamLLM` reads the same `SARVAM_API_KEY` / `SARVAM_CHAT_MODEL` / `SARVAM_MAX_TOKENS` /
 * `SARVAM_REASONING_EFFORT` config `lib/sarvam.ts` already uses (see lib/env.ts), so the two clients
 * stay configured identically even though they're separate code paths.
 *
 * Streaming format: Sarvam's docs (docs.sarvam.ai/api-reference-docs/chat/chat-completions)
 * confirm `stream: true` triggers Server-Sent Events but do not publish the exact chunk schema.
 * The endpoint's request/response shape otherwise mirrors OpenAI's chat completions API exactly
 * (as `lib/sarvam.ts` already relies on for `choices[0].message`), so this client parses the
 * de facto standard OpenAI-compatible SSE stream: one `data: {...}` line per chunk with
 * `choices[0].delta.content`, terminated by a literal `data: [DONE]` line. This is the same format
 * essentially every OpenAI-compatible provider (vLLM, Together, Groq, Fireworks, etc.) uses, but
 * it is an informed assumption, not something Sarvam's docs confirm outright — verify against a
 * live call before depending on this in production.
 *
 * Sarvam's reasoning models can emit `<think>...</think>` before the real answer (see
 * `sarvamChatOnce` in lib/sarvam.ts); this client strips that out of both the buffered
 * (`generate`) and streamed (`generateStream`) text so a caller never sees it, but — unlike
 * `sarvamChat` — does not retry with a larger token budget on an empty/truncated response. Reuse
 * `lib/sarvam.ts`'s `sarvamChat` directly if you need that retry behavior; this class favors a
 * smaller, more predictable surface suited to a swappable `LLMProvider`.
 */

import { env } from "../../env";
import { logger } from "../../logger";
import type { LLMGenerateOptions, LLMMessage, LLMProvider, LLMResult, LLMTokenCallback, LLMUsage } from "./types";

const log = logger.child({ module: "sarvam-llm" });

const DEFAULT_BASE_URL = "https://api.sarvam.ai";
const CHAT_PATH = "/v1/chat/completions";
const THINK_TAG_RE = /<think>[\s\S]*?<\/think>/gi;

export interface SarvamLLMOptions {
  /** Defaults to `env.SARVAM_API_KEY`. */
  apiKey?: string;
  /** Defaults to `env.SARVAM_CHAT_MODEL` (`"sarvam-105b"` unless overridden). */
  model?: string;
  /** Defaults to `env.SARVAM_MAX_TOKENS`; per-call `maxTokens` is clamped to this ceiling, same as
   *  `lib/sarvam.ts`'s `sarvamChat`. */
  maxTokensCeiling?: number;
  /** Defaults to `env.SARVAM_REASONING_EFFORT` (disabled unless configured). */
  reasoningEffort?: string;
  /** Overall per-call timeout (ms), aborting the request if exceeded. Default 45000, matching
   *  `sarvamChat`'s default. */
  timeoutMs?: number;
  /** Base URL, overridable for a proxy or test server. Defaults to `https://api.sarvam.ai`. */
  baseUrl?: string;
  /** Injected for testing (or an alternate transport). Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

function reasoningWireValue(effort: string | undefined): "low" | "medium" | "high" | null {
  const v = (effort ?? "").trim().toLowerCase();
  return v === "low" || v === "medium" || v === "high" ? v : null;
}

function stripThinkTags(text: string): string {
  return text.replace(THINK_TAG_RE, "").trim();
}

function abortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

/** Links `external` (if given) to `controller`, so aborting either aborts the request. Implemented
 *  by hand rather than via `AbortSignal.any` (added in Node 20.3) since this project targets
 *  Node >=18.18. Returns a cleanup function that removes the listener. */
function linkAbortSignal(external: AbortSignal | undefined, controller: AbortController): () => void {
  if (!external) return () => {};
  if (external.aborted) {
    controller.abort(external.reason);
    return () => {};
  }
  const onAbort = () => controller.abort(external.reason);
  external.addEventListener("abort", onAbort, { once: true });
  return () => external.removeEventListener("abort", onAbort);
}

function usageFromResponse(data: unknown): LLMUsage | undefined {
  const usage = (data as { usage?: Record<string, unknown> } | undefined)?.usage;
  if (!usage) return undefined;
  return {
    promptTokens: typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : undefined,
    completionTokens: typeof usage.completion_tokens === "number" ? usage.completion_tokens : undefined,
    totalTokens: typeof usage.total_tokens === "number" ? usage.total_tokens : undefined,
  };
}

export class SarvamLLM implements LLMProvider {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly maxTokensCeiling: number;
  private readonly reasoningEffort: string | undefined;
  private readonly timeoutMs: number;
  private readonly chatUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: SarvamLLMOptions = {}) {
    this.apiKey = opts.apiKey ?? env.SARVAM_API_KEY ?? "";
    this.model = opts.model ?? env.SARVAM_CHAT_MODEL;
    this.maxTokensCeiling = opts.maxTokensCeiling ?? env.SARVAM_MAX_TOKENS;
    this.reasoningEffort = opts.reasoningEffort ?? env.SARVAM_REASONING_EFFORT;
    this.timeoutMs = opts.timeoutMs ?? 45_000;
    this.chatUrl = `${opts.baseUrl ?? DEFAULT_BASE_URL}${CHAT_PATH}`;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** Generate a full completion, waiting for the entire response before resolving. */
  async generate(messages: LLMMessage[], opts: LLMGenerateOptions = {}): Promise<LLMResult> {
    if (!this.apiKey) throw new Error("SarvamLLM: SARVAM_API_KEY not set");

    const controller = new AbortController();
    const unlink = linkAbortSignal(opts.signal, controller);
    const timeoutTimer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(this.chatUrl, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(this.buildBody(messages, opts, false)),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`Sarvam chat ${res.status}: ${await res.text()}`);

      const data = await res.json();
      const choice = data?.choices?.[0];
      const text = stripThinkTags((choice?.message?.content ?? "") as string);
      if (!text) {
        const finish = choice?.finish_reason ?? "unknown";
        throw new Error(`Sarvam chat returned empty content (model=${this.model}, finish_reason=${finish})`);
      }
      return {
        text,
        model: data?.model ?? this.model,
        finishReason: choice?.finish_reason,
        usage: usageFromResponse(data),
      };
    } catch (e) {
      if (controller.signal.aborted) throw abortError();
      throw e;
    } finally {
      clearTimeout(timeoutTimer);
      unlink();
    }
  }

  /**
   * Stream a completion, invoking `onToken` for each incremental chunk of text as it arrives. See
   * the module docstring for the (informed-assumption) SSE chunk format this parses.
   */
  async generateStream(
    messages: LLMMessage[],
    onToken: LLMTokenCallback,
    opts: LLMGenerateOptions = {}
  ): Promise<LLMResult> {
    if (!this.apiKey) throw new Error("SarvamLLM: SARVAM_API_KEY not set");

    const controller = new AbortController();
    const unlink = linkAbortSignal(opts.signal, controller);
    const timeoutTimer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(this.chatUrl, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(this.buildBody(messages, opts, true)),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`Sarvam chat ${res.status}: ${await res.text()}`);
      if (!res.body) throw new Error("Sarvam chat: streaming response had no body");

      return await this.consumeStream(res.body, onToken, controller.signal);
    } catch (e) {
      if (controller.signal.aborted) throw abortError();
      throw e;
    } finally {
      clearTimeout(timeoutTimer);
      unlink();
    }
  }

  private async consumeStream(
    body: ReadableStream<Uint8Array>,
    onToken: LLMTokenCallback,
    signal: AbortSignal
  ): Promise<LLMResult> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let fullText = "";
    let model: string | undefined;
    let finishReason: string | undefined;
    let usage: LLMUsage | undefined;

    const emit = (delta: string) => {
      if (!delta) return;
      fullText += delta;
      try {
        onToken(delta);
      } catch (e) {
        // A misbehaving consumer must never break the stream read for itself or corrupt fullText.
        log.warn("onToken callback threw; continuing stream", { error: (e as Error).message });
      }
    };

    try {
      while (true) {
        if (signal.aborted) throw abortError();
        const { done, value } = await reader.read();
        // Check again immediately after the read resolves, not just before it started: an abort
        // that fires while a read() is already in flight must still discard whatever chunk that
        // read resolves with — otherwise one more (stale) chunk slips through after cancellation.
        if (signal.aborted) throw abortError();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? ""; // keep a possibly-incomplete trailing line for the next read

        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line || !line.startsWith("data:")) continue;
          const payload = line.slice("data:".length).trim();
          if (payload === "[DONE]") {
            await reader.cancel().catch(() => {});
            return { text: stripThinkTags(fullText), model, finishReason, usage };
          }

          let json: Record<string, unknown>;
          try {
            json = JSON.parse(payload);
          } catch {
            continue; // a keep-alive/comment line or a chunk split across reads — skip, not fatal
          }
          model = (json.model as string | undefined) ?? model;
          usage = usageFromResponse(json) ?? usage;
          const choice = (json.choices as Array<Record<string, unknown>> | undefined)?.[0];
          const delta = (choice?.delta as { content?: string } | undefined)?.content ?? "";
          emit(delta);
          if (typeof choice?.finish_reason === "string") finishReason = choice.finish_reason;
        }
      }
      return { text: stripThinkTags(fullText), model, finishReason, usage };
    } finally {
      reader.releaseLock();
    }
  }

  private headers(): Record<string, string> {
    // Matches lib/sarvam.ts's authHeaders() exactly — this is the header Sarvam's other endpoints
    // in this codebase already authenticate with successfully.
    return { "api-subscription-key": this.apiKey, "content-type": "application/json" };
  }

  private buildBody(messages: LLMMessage[], opts: LLMGenerateOptions, stream: boolean): Record<string, unknown> {
    return {
      model: this.model,
      messages,
      temperature: opts.temperature ?? 0.2,
      max_tokens: Math.min(opts.maxTokens ?? 4000, this.maxTokensCeiling),
      reasoning_effort: reasoningWireValue(this.reasoningEffort),
      stream,
    };
  }
}
