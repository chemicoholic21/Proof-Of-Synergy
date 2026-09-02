/**
 * Vendor-agnostic LLM provider abstraction: shared types plus the `LLMProvider` contract itself.
 *
 * Mirrors the split already established for speech-to-text (lib/providers/stt/STTProvider.ts +
 * types.ts) — code that needs a chat completion should depend on `LLMProvider`, not import a
 * vendor SDK/HTTP client (e.g. lib/sarvam.ts, lib/gemini.ts) directly, so the vendor can be
 * swapped, or replaced with a test double, without touching call sites.
 *
 * `./SarvamLLM.ts` is the first (and so far only) concrete implementation.
 */

export type LLMRole = "system" | "user" | "assistant";

export interface LLMMessage {
  role: LLMRole;
  content: string;
}

export interface LLMGenerateOptions {
  temperature?: number;
  maxTokens?: number;
  /** Aborts the in-flight request (and, for `generateStream`, stops delivering further tokens)
   *  when triggered. Both `LLMProvider` methods reject with a `DOMException` named `"AbortError"`
   *  once aborted — never resolve with a partial/stale result. */
  signal?: AbortSignal;
}

export interface LLMUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface LLMResult {
  text: string;
  /** The model id that actually answered — useful when a provider resolves a configured id to a
   *  concrete one (fallback chains, aliases, etc.). */
  model?: string;
  /** The provider's own reason the generation stopped (e.g. `"stop"`, `"length"`), when reported. */
  finishReason?: string;
  usage?: LLMUsage;
}

/** One incremental piece of generated text, as delivered to `LLMProvider.generateStream()`'s
 *  `onToken` callback. Vendors that stream token-by-token or chunk-by-chunk both fit this shape —
 *  a "token" here just means "whatever increment of text arrived in one update." */
export type LLMTokenCallback = (token: string) => void;

/**
 * Vendor-agnostic chat-completion provider contract. Every method accepts an optional
 * `AbortSignal` (via `LLMGenerateOptions.signal`) and honors it: an aborted call rejects promptly
 * rather than resolving with a stale/partial result, and `generateStream()` stops invoking
 * `onToken` the moment it's aborted.
 */
export interface LLMProvider {
  /** Generate a full completion for `messages`, resolving once generation is complete. */
  generate(messages: LLMMessage[], opts?: LLMGenerateOptions): Promise<LLMResult>;

  /**
   * Generate a completion for `messages`, invoking `onToken` for each incremental piece of text
   * as it arrives, and resolving with the fully assembled result once generation completes.
   * Implementations that can't actually stream should still honor this signature by buffering the
   * full response and delivering it as a single `onToken` call before resolving — callers must be
   * able to depend on `generateStream()` existing on any `LLMProvider`, whether or not a given
   * vendor call happens to be able to stream today.
   */
  generateStream(messages: LLMMessage[], onToken: LLMTokenCallback, opts?: LLMGenerateOptions): Promise<LLMResult>;
}
