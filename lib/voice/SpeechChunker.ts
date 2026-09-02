/**
 * Streaming chunker that sits between an incremental LLM token stream and a streaming TTS
 * provider — the missing link between `LLMProvider.generateStream()`'s `onToken` callback
 * (lib/providers/llm/types.ts) and `TTSProvider.sendText()` (lib/providers/tts/TTSProvider.ts):
 *
 *   generateStream(messages, token => chunker.push(token))
 *   chunker.onChunk(text => ttsProvider.sendText(text))
 *   chunker.onComplete(() => ttsProvider.flush())
 *
 * Feeding raw LLM tokens straight into `sendText()` one at a time would work, but it throws away
 * exactly the judgment call this class exists to make: *when* is it worth interrupting the flow of
 * words to start speaking what's been generated so far. Too eager (emit every token immediately)
 * and the TTS provider — and the voice coming out the other end — sounds fragmented, choppy,
 * mid-thought. Too conservative (wait for the whole reply) and the learner sits in silence for the
 * entire generation time, defeating the point of streaming at all. `SpeechChunker` picks a point in
 * between, deterministically, using three rules, checked in this priority order every time new
 * text arrives:
 *
 *   1. **Sentence boundary** — a `.`/`!`/`?` (with basic abbreviation/decimal-number guards, e.g.
 *      "Dr." and "3.14" don't count) that closes out a complete sentence. Always taken immediately,
 *      regardless of how short the sentence is — a complete sentence is never "too fragmented,"
 *      even "Yes." or "Okay." on their own.
 *   2. **Safe phrase boundary** — a `,` `;` `:` or em/en dash — but *only* once generation has gone
 *      quiet for `maxSilenceMs` with no new `push()` (the "generation is slow" case the task calls
 *      for) *and* there's already at least `minChunkChars` buffered. Both conditions matter: without
 *      the silence gate, this would fragment normal, fast generation at every comma; without the
 *      minimum-length gate, a slow model could get a two-word fragment ("Well,") pushed out on its
 *      own the moment it pauses.
 *   3. **Maximum chunk length** — a hard ceiling (`maxChunkChars`) so a long, unpunctuated run of
 *      text (a stalled model rambling with no natural breaks) still gets sent to TTS in bounded
 *      pieces instead of growing forever. Always cuts at a word boundary — see "Never emit
 *      incomplete words" below.
 *
 * If none of the three rules fire, the text just keeps accumulating; nothing is ever emitted on a
 * guess. Forward progress when the model has stalled *and* there's no usable boundary at all is
 * `flush()`'s job (see below), not something this class does silently on its own — that keeps the
 * three rules above the only things that decide chunk boundaries during normal streaming, and
 * "the stream is over, say whatever's left" a separate, explicit, caller-driven signal.
 *
 * ## Never emit incomplete words
 *
 * Every cut point — sentence end, phrase boundary, or the max-length ceiling — is found by
 * scanning for actual boundary characters or whitespace; the max-length rule specifically looks
 * for the last space before the ceiling and, in the vanishingly rare case there isn't one *at all*
 * within the window (one absurdly long unbroken run of non-space characters), keeps extending
 * *forward* to the next available space rather than ever cutting mid-word. `maxChunkChars` is
 * therefore a target, not a byte-exact limit — word integrity always wins.
 *
 * ## Flush and cancellation
 *
 * - `flush()` — call once the LLM stream is genuinely done (its promise resolved). Relaxes through
 *   every rule above one more time and then emits whatever's left, no boundary required at all,
 *   since there's no more text coming to wait for. Fires `onComplete()` afterward.
 * - `cancel()` — call on a barge-in/interruption (see `VoiceSession.interrupt()`). Discards
 *   whatever's buffered and emits nothing further — the same "never let stale output slip through
 *   after a cancellation" bar `BulbulV3TTSProvider.cancel()` and `SarvamLLM`'s stream cancellation
 *   are already held to.
 *
 * One instance is meant for one utterance: after `flush()` or `cancel()`, further `push()` calls
 * are silently ignored (not thrown) rather than treated as a caller bug — a few stray tokens from
 * an LLM stream that hasn't yet noticed it was aborted is an expected race, not a mistake. Construct
 * a fresh `SpeechChunker` for the next utterance rather than trying to reuse one.
 */

export type SpeechChunkReason = "sentence" | "phrase" | "max_length" | "flush";

export type SpeechChunkCallback = (text: string, reason: SpeechChunkReason) => void;
export type SpeechChunkerCompleteCallback = () => void;

export interface SpeechChunkerOptions {
  /**
   * Hard ceiling on one emitted chunk's length, in characters — the rule-3 safety valve. Defaults
   * to 400, comfortably under `BulbulV3TTSProvider`'s own recommended ~500-character WebSocket
   * message ceiling (`MAX_TEXT_MESSAGE_CHARS`, lib/providers/tts/BulbulV3TTSProvider.ts), so a
   * chunk this class emits never itself needs further splitting downstream.
   */
  maxChunkChars?: number;
  /**
   * Floor below which a phrase boundary (rule 2) will not fire, even when generation is slow —
   * avoids emitting a fragment as short as "Well," on its own. A complete sentence (rule 1) is
   * always emitted regardless of this floor, since it's a whole semantic unit no matter how short.
   * Default 20.
   */
  minChunkChars?: number;
  /**
   * How long to wait with no new `push()` before relaxing from "sentence boundaries only" to also
   * accepting a phrase boundary (rule 2) — the "generation is slow" condition. Default 600ms. Pass
   * `0` to disable phrase-boundary chunking entirely during streaming (it can still fire once,
   * inside `flush()`).
   */
  maxSilenceMs?: number;
}

const DEFAULT_MAX_CHUNK_CHARS = 400;
const DEFAULT_MIN_CHUNK_CHARS = 20;
const DEFAULT_MAX_SILENCE_MS = 600;

const SENTENCE_END_CHARS = new Set([".", "!", "?"]);
const PHRASE_BOUNDARY_CHARS = new Set([",", ";", ":", "—", "–"]); // , ; : — –
const CLOSING_CHARS_RE = /[)\]"'’”]/;

// Best-effort, not exhaustive — real natural-language sentence segmentation is a much deeper
// problem than this class needs to solve. Getting this wrong just means one abbreviation
// occasionally ends a "sentence" a beat early or late, not a functional failure.
const ABBREVIATIONS = new Set([
  "mr",
  "mrs",
  "ms",
  "dr",
  "prof",
  "sr",
  "jr",
  "vs",
  "etc",
  "approx",
  "st",
  "e.g",
  "i.e",
]);

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

function endsWithAbbreviation(textBeforeDot: string): boolean {
  const match = /([a-zA-Z.]+)$/.exec(textBeforeDot);
  if (!match) return false;
  return ABBREVIATIONS.has(match[1].toLowerCase());
}

/**
 * Finds the end index (exclusive) of the first complete sentence in `text`, or `null` if none has
 * closed out yet. A sentence-ending character counts as a boundary once it's followed by
 * whitespace, or once it's the very end of the buffered text so far (no need to wait for a
 * trailing space token that just hasn't arrived yet — see the module docstring on latency).
 */
export function findSentenceBoundary(text: string): number | null {
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (!SENTENCE_END_CHARS.has(ch)) continue;
    if (ch === "." && isDigit(text[i - 1] ?? "") && isDigit(text[i + 1] ?? "")) continue; // "3.14"
    if (ch === "." && endsWithAbbreviation(text.slice(0, i))) continue; // "Dr." "e.g."

    let end = i + 1;
    while (end < text.length && CLOSING_CHARS_RE.test(text[end])) end++; // absorb closing "') etc.
    if (end === text.length || /\s/.test(text[end])) return end;
  }
  return null;
}

/**
 * Finds the end index (exclusive) of the first safe phrase boundary in `text` (comma, semicolon,
 * colon, or em/en dash followed by whitespace or end-of-buffer) whose resulting piece is at least
 * `minPieceChars` long, or `null` if none. A boundary that would produce a shorter piece is
 * skipped in favor of a later one — this is what keeps `minChunkChars` (lib/voice/SpeechChunker.ts)
 * a real floor on emitted piece size, not just a check that *some* text somewhere is long enough.
 */
export function findPhraseBoundary(text: string, minPieceChars = 0): number | null {
  for (let i = 0; i < text.length; i++) {
    if (!PHRASE_BOUNDARY_CHARS.has(text[i])) continue;
    const end = i + 1;
    if (end < minPieceChars) continue; // this piece would be too short — keep scanning for a later boundary
    if (end === text.length || /\s/.test(text[end])) return end;
  }
  return null;
}

/**
 * Finds a cut point at or near `maxChars`, at a word boundary, for text known to be longer than
 * `maxChars`. Prefers the last space at or before `maxChars`; if there is truly none (one unbroken
 * run longer than the whole ceiling), extends *forward* to the next space instead of ever cutting
 * mid-word — see "Never emit incomplete words" in the module docstring.
 */
export function findMaxLengthCut(text: string, maxChars: number): number {
  const window = text.slice(0, maxChars);
  const lastSpace = window.lastIndexOf(" ");
  if (lastSpace > 0) return lastSpace + 1;
  const nextSpace = text.indexOf(" ", maxChars);
  return nextSpace === -1 ? text.length : nextSpace + 1;
}

export class SpeechChunker {
  private readonly maxChunkChars: number;
  private readonly minChunkChars: number;
  private readonly maxSilenceMs: number;

  private buffer = "";
  private active = true;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly chunkCallbacks: SpeechChunkCallback[] = [];
  private readonly completeCallbacks: SpeechChunkerCompleteCallback[] = [];

  constructor(opts: SpeechChunkerOptions = {}) {
    this.maxChunkChars = opts.maxChunkChars ?? DEFAULT_MAX_CHUNK_CHARS;
    this.minChunkChars = opts.minChunkChars ?? DEFAULT_MIN_CHUNK_CHARS;
    this.maxSilenceMs = opts.maxSilenceMs ?? DEFAULT_MAX_SILENCE_MS;
  }

  /** Feed the next incremental piece of LLM output. Silently ignored once `flush()`/`cancel()`
   *  has finalized this instance — see the module docstring on why that's not an error. */
  push(token: string): void {
    if (!this.active || !token) return;
    this.buffer += token;
    this.emitReady();
    this.resetSilenceTimer();
  }

  /**
   * The LLM stream is done — relax through every chunking rule one more time and emit whatever's
   * left, no boundary required, since there's no more text coming. Fires `onComplete()`
   * afterward. Safe to call more than once; a call after `cancel()` or a previous `flush()` is a
   * no-op.
   */
  flush(): void {
    if (!this.active) return;
    this.active = false;
    this.clearSilenceTimer();

    this.emitReady();
    this.trySemanticEmit(); // relax to phrase boundaries too, without waiting for silence
    this.emitReady(); // removing a phrase-bounded prefix can expose a sentence boundary right behind it

    const remainder = this.buffer.trim();
    this.buffer = "";
    if (remainder) {
      for (const cb of this.chunkCallbacks) cb(remainder, "flush");
    }
    for (const cb of this.completeCallbacks) cb();
  }

  /** The learner interrupted the agent — discard whatever's buffered and emit nothing further.
   *  Safe to call more than once, or after `flush()` already finalized this instance. */
  cancel(): void {
    if (!this.active) return;
    this.active = false;
    this.clearSilenceTimer();
    this.buffer = "";
  }

  /** Register a callback for each emitted chunk, in order. */
  onChunk(callback: SpeechChunkCallback): void {
    this.chunkCallbacks.push(callback);
  }

  /** Register a callback fired once, after `flush()` has emitted everything it's going to. Never
   *  fires after `cancel()`. */
  onComplete(callback: SpeechChunkerCompleteCallback): void {
    this.completeCallbacks.push(callback);
  }

  // -- Internals ------------------------------------------------------------------------------

  /** Applies rule 1 (sentence boundary) and rule 3 (max length), repeatedly, until neither fires —
   *  the two rules always active during normal streaming, independent of how long it's been quiet. */
  private emitReady(): void {
    for (;;) {
      const sentenceEnd = findSentenceBoundary(this.buffer);
      if (sentenceEnd !== null) {
        this.emit(sentenceEnd, "sentence");
        continue;
      }
      if (this.buffer.length >= this.maxChunkChars) {
        this.emit(findMaxLengthCut(this.buffer, this.maxChunkChars), "max_length");
        continue;
      }
      break;
    }
  }

  /**
   * Applies rule 2 (phrase boundary), repeatedly extracting every currently-available piece that
   * meets `minChunkChars` — only ever called once generation has gone quiet for `maxSilenceMs`
   * (from `handleSilenceTimeout`) or from `flush()`, never from a plain `push()`. Each candidate
   * boundary is skipped (in favor of a later one) if the piece it would produce is shorter than
   * `minChunkChars` — that floor is enforced per piece, not just "is there enough text somewhere."
   */
  private trySemanticEmit(): void {
    while (this.buffer.trim().length >= this.minChunkChars) {
      const cut = findPhraseBoundary(this.buffer, this.minChunkChars);
      if (cut === null) break;
      this.emit(cut, "phrase");
    }
  }

  private emit(cut: number, reason: SpeechChunkReason): void {
    const piece = this.buffer.slice(0, cut).trim();
    this.buffer = this.buffer.slice(cut).replace(/^\s+/, "");
    if (piece) {
      for (const cb of this.chunkCallbacks) cb(piece, reason);
    }
  }

  private resetSilenceTimer(): void {
    this.clearSilenceTimer();
    if (!this.maxSilenceMs || this.buffer.length === 0) return;
    this.silenceTimer = setTimeout(() => this.handleSilenceTimeout(), this.maxSilenceMs);
  }

  private handleSilenceTimeout(): void {
    this.silenceTimer = null;
    if (!this.active) return;
    // Generation has gone quiet — relax to the phrase-boundary rule in addition to the two that
    // are always active, then keep watching in case more text trickles in slowly. If nothing
    // qualifies even now, this deliberately does NOT force out whatever's buffered regardless of
    // boundary — that's flush()'s job once the caller knows the stream is actually finished, not a
    // guess this class makes on its own (see the module docstring).
    this.emitReady();
    this.trySemanticEmit();
    this.resetSilenceTimer();
  }

  private clearSilenceTimer(): void {
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
  }
}
