import { describe, it, expect } from "vitest";
import {
  SpeechChunker,
  findSentenceBoundary,
  findPhraseBoundary,
  findMaxLengthCut,
  type SpeechChunkReason,
} from "./SpeechChunker";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Emitted {
  text: string;
  reason: SpeechChunkReason;
}

describe("findSentenceBoundary", () => {
  it("finds a period followed by a space", () => {
    expect(findSentenceBoundary("Hello there. ")).toBe(12);
  });

  it("treats end-of-buffer right after sentence punctuation as a boundary (no trailing space needed)", () => {
    const text = "Hello there.";
    expect(findSentenceBoundary(text)).toBe(text.length);
  });

  it("recognizes ! and ?", () => {
    expect(findSentenceBoundary("Really?! ")).not.toBeNull();
    expect(findSentenceBoundary("Wow! ")).toBe(4);
  });

  it("does not treat a decimal number's period as a sentence end", () => {
    expect(findSentenceBoundary("Pi is 3.14 roughly.")).toBe("Pi is 3.14 roughly.".length);
  });

  it("does not treat a common abbreviation's period as a sentence end", () => {
    expect(findSentenceBoundary("Dr. Smith will see you now.")).toBe("Dr. Smith will see you now.".length);
  });

  it("absorbs a trailing closing quote or parenthesis", () => {
    const text = 'He said "stop." Then left.';
    const cut = findSentenceBoundary(text);
    expect(cut).not.toBeNull();
    expect(text.slice(0, cut!)).toBe('He said "stop."');
  });

  it("returns null when there is no sentence boundary yet", () => {
    expect(findSentenceBoundary("this is still going")).toBeNull();
  });
});

describe("findPhraseBoundary", () => {
  it.each([
    ["a comma, then more", ","],
    ["a clause; then more", ";"],
    ["a list: then more", ":"],
    ["a break— then more", "—"],
  ])("finds %s", (text) => {
    expect(findPhraseBoundary(text)).not.toBeNull();
  });

  it("returns null when there is no phrase boundary", () => {
    expect(findPhraseBoundary("no punctuation here at all")).toBeNull();
  });
});

describe("findMaxLengthCut", () => {
  it("cuts at the last space at or before the ceiling", () => {
    const text = "one two three four five";
    const cut = findMaxLengthCut(text, 13); // "one two three" is 13 chars
    expect(text.slice(0, cut).trim()).toBe("one two");
  });

  it("never cuts mid-word — extends forward to the next space if none exists within the window", () => {
    const text = "a".repeat(50) + " done";
    const cut = findMaxLengthCut(text, 10);
    expect(text.slice(0, cut)).toBe("a".repeat(50) + " ");
    expect(cut).toBeGreaterThan(10);
  });
});

describe("SpeechChunker — sentence boundary (rule 1)", () => {
  it("emits immediately on a complete sentence, tagged 'sentence'", () => {
    const chunker = new SpeechChunker();
    const emitted: Emitted[] = [];
    chunker.onChunk((text, reason) => emitted.push({ text, reason }));

    chunker.push("Sure. ");
    expect(emitted).toEqual([{ text: "Sure.", reason: "sentence" }]);
  });

  it("emits a very short sentence on its own without waiting for more text", () => {
    const chunker = new SpeechChunker({ minChunkChars: 50 });
    const emitted: Emitted[] = [];
    chunker.onChunk((text, reason) => emitted.push({ text, reason }));
    chunker.push("Yes.");
    expect(emitted).toEqual([{ text: "Yes.", reason: "sentence" }]);
  });

  it("emits every complete sentence delivered in one push(), leaving an incomplete trailing one buffered", () => {
    const chunker = new SpeechChunker();
    const emitted: Emitted[] = [];
    chunker.onChunk((text, reason) => emitted.push({ text, reason }));

    chunker.push("First one. Second one! Third is unfin");
    expect(emitted).toEqual([
      { text: "First one.", reason: "sentence" },
      { text: "Second one!", reason: "sentence" },
    ]);
  });

  it("assembles a sentence split across many small token pushes", () => {
    const chunker = new SpeechChunker();
    const emitted: Emitted[] = [];
    chunker.onChunk((text, reason) => emitted.push({ text, reason }));

    for (const token of ["Dis", "trib", "uted systems are hard", ". ", "Let's talk about CAP", "."]) {
      chunker.push(token);
    }
    expect(emitted).toEqual([
      { text: "Distributed systems are hard.", reason: "sentence" },
      { text: "Let's talk about CAP.", reason: "sentence" },
    ]);
  });
});

describe("SpeechChunker — safe phrase boundary (rule 2, gated on slow generation)", () => {
  it("does not fragment at a comma while tokens keep arriving quickly", async () => {
    const chunker = new SpeechChunker({ maxSilenceMs: 200 });
    const emitted: Emitted[] = [];
    chunker.onChunk((text, reason) => emitted.push({ text, reason }));

    chunker.push("Well, ");
    await sleep(10);
    chunker.push("actually, ");
    await sleep(10);
    chunker.push("it depends on the workload.");

    // No phrase boundary ever fired (each push arrived well within maxSilenceMs), so the whole
    // thing — commas and all — accumulates until the sentence finally ends.
    expect(emitted).toEqual([{ text: "Well, actually, it depends on the workload.", reason: "sentence" }]);
  });

  it("relaxes to a phrase boundary once generation goes quiet, when enough text is buffered", async () => {
    // minChunkChars is set higher than "Well," (5 chars) so that too-short first boundary is
    // skipped in favor of the next one that actually meets the floor.
    const chunker = new SpeechChunker({ maxSilenceMs: 15, minChunkChars: 20 });
    const emitted: Emitted[] = [];
    chunker.onChunk((text, reason) => emitted.push({ text, reason }));

    chunker.push("Well, that's a great question,");
    await sleep(30);

    expect(emitted).toEqual([{ text: "Well, that's a great question,", reason: "phrase" }]);
  });

  it("does not force a phrase boundary on silence if the buffer is still under minChunkChars", async () => {
    const chunker = new SpeechChunker({ maxSilenceMs: 15, minChunkChars: 100 });
    const emitted: Emitted[] = [];
    chunker.onChunk((text, reason) => emitted.push({ text, reason }));

    chunker.push("Well,");
    await sleep(30);

    expect(emitted).toEqual([]); // too short to fragment even though generation went quiet
  });

  it("resets the silence timer on every push, so continuous (if slow) activity never triggers a phrase emit", async () => {
    const chunker = new SpeechChunker({ maxSilenceMs: 30, minChunkChars: 5 });
    const emitted: Emitted[] = [];
    chunker.onChunk((text, reason) => emitted.push({ text, reason }));

    chunker.push("Well, actually,");
    await sleep(20);
    chunker.push(" it depends,"); // arrives before the 30ms timer would have fired
    await sleep(20);
    chunker.push(" on the workload.");

    expect(emitted).toEqual([{ text: "Well, actually, it depends, on the workload.", reason: "sentence" }]);
  });

  it("never fires a phrase boundary during streaming when maxSilenceMs is 0", async () => {
    const chunker = new SpeechChunker({ maxSilenceMs: 0, minChunkChars: 1 });
    const emitted: Emitted[] = [];
    chunker.onChunk((text, reason) => emitted.push({ text, reason }));

    chunker.push("Well, that's interesting,");
    await sleep(30);
    expect(emitted).toEqual([]); // nothing fires mid-stream with phrase-boundary chunking disabled

    chunker.flush();
    // flush() still relaxes to phrase boundaries regardless of maxSilenceMs — with minChunkChars:1
    // each comma-bounded piece already meets the floor, so both come out separately.
    expect(emitted).toEqual([
      { text: "Well,", reason: "phrase" },
      { text: "that's interesting,", reason: "phrase" },
    ]);
  });
});

describe("SpeechChunker — maximum chunk length (rule 3)", () => {
  it("emits once the buffer reaches maxChunkChars, cut at a word boundary", () => {
    const chunker = new SpeechChunker({ maxChunkChars: 20 });
    const emitted: Emitted[] = [];
    chunker.onChunk((text, reason) => emitted.push({ text, reason }));

    chunker.push("one two three four five six seven"); // no punctuation at all
    expect(emitted).toHaveLength(1);
    expect(emitted[0].reason).toBe("max_length");
    expect(emitted[0].text.length).toBeLessThanOrEqual(20);
    expect("one two three four five six seven").toContain(emitted[0].text);
  });

  it("never emits an incomplete word even when the max length falls mid-word", () => {
    const chunker = new SpeechChunker({ maxChunkChars: 10 });
    const emitted: Emitted[] = [];
    chunker.onChunk((text, reason) => emitted.push({ text, reason }));

    chunker.push("supercalifragilisticexpialidocious is a long word");
    for (const e of emitted) {
      expect("supercalifragilisticexpialidocious is a long word").toContain(e.text);
    }
  });

  it("keeps chunking a long unpunctuated stream in bounded pieces as more tokens arrive", () => {
    const chunker = new SpeechChunker({ maxChunkChars: 15 });
    const emitted: Emitted[] = [];
    chunker.onChunk((text, reason) => emitted.push({ text, reason }));

    for (let i = 0; i < 10; i++) chunker.push(`word${i} `);
    expect(emitted.length).toBeGreaterThan(1);
    expect(emitted.every((e) => e.reason === "max_length")).toBe(true);
    expect(emitted.every((e) => e.text.length <= 15)).toBe(true);
  });
});

describe("SpeechChunker — flush()", () => {
  it("emits whatever remains, tagged 'flush', when no boundary applies", () => {
    const chunker = new SpeechChunker();
    const emitted: Emitted[] = [];
    chunker.onChunk((text, reason) => emitted.push({ text, reason }));

    chunker.push("this never got a sentence end");
    chunker.flush();

    expect(emitted).toEqual([{ text: "this never got a sentence end", reason: "flush" }]);
  });

  it("relaxes to phrase boundaries during flush without waiting for silence", () => {
    const chunker = new SpeechChunker({ maxSilenceMs: 60_000, minChunkChars: 1 });
    const emitted: Emitted[] = [];
    chunker.onChunk((text, reason) => emitted.push({ text, reason }));

    chunker.push("First clause, second clause, third clause with no ending");
    chunker.flush();

    expect(emitted.slice(0, 2)).toEqual([
      { text: "First clause,", reason: "phrase" },
      { text: "second clause,", reason: "phrase" },
    ]);
    expect(emitted.at(-1)).toEqual({ text: "third clause with no ending", reason: "flush" });
  });

  it("fires onComplete exactly once", () => {
    const chunker = new SpeechChunker();
    let completed = 0;
    chunker.onComplete(() => completed++);
    chunker.push("Some text.");
    chunker.flush();
    chunker.flush(); // idempotent
    expect(completed).toBe(1);
  });

  it("fires onComplete with no chunk at all when the buffer is empty", () => {
    const chunker = new SpeechChunker();
    const emitted: Emitted[] = [];
    let completed = 0;
    chunker.onChunk((text, reason) => emitted.push({ text, reason }));
    chunker.onComplete(() => completed++);

    chunker.push("A complete sentence.");
    expect(emitted).toHaveLength(1); // already emitted by the sentence rule - nothing left buffered
    chunker.flush();
    expect(emitted).toHaveLength(1); // flush() had nothing more to add
    expect(completed).toBe(1);
  });

  it("ignores push() after flush()", () => {
    const chunker = new SpeechChunker();
    const emitted: Emitted[] = [];
    chunker.onChunk((text, reason) => emitted.push({ text, reason }));
    chunker.flush();
    chunker.push("too late");
    expect(emitted).toEqual([]);
  });
});

describe("SpeechChunker — cancel()", () => {
  it("discards buffered text and emits nothing", () => {
    const chunker = new SpeechChunker();
    const emitted: Emitted[] = [];
    chunker.onChunk((text, reason) => emitted.push({ text, reason }));

    chunker.push("this will never be spoken");
    chunker.cancel();

    expect(emitted).toEqual([]);
  });

  it("never fires onComplete", () => {
    const chunker = new SpeechChunker();
    let completed = 0;
    chunker.onComplete(() => completed++);
    chunker.push("some text");
    chunker.cancel();
    expect(completed).toBe(0);
  });

  it("ignores push() after cancel()", () => {
    const chunker = new SpeechChunker();
    const emitted: Emitted[] = [];
    chunker.onChunk((text, reason) => emitted.push({ text, reason }));
    chunker.cancel();
    chunker.push("too late");
    expect(emitted).toEqual([]);
  });

  it("is idempotent and safe to call after flush() (and vice versa)", () => {
    const chunker = new SpeechChunker();
    let completed = 0;
    chunker.onComplete(() => completed++);
    chunker.push("hello there.");
    chunker.flush();
    expect(() => chunker.cancel()).not.toThrow();
    expect(completed).toBe(1); // cancel() after flush() doesn't un-fire or re-fire completion

    const chunker2 = new SpeechChunker();
    chunker2.cancel();
    expect(() => chunker2.flush()).not.toThrow();
  });

  it("clears any pending silence timer so it can't fire after cancellation", async () => {
    const chunker = new SpeechChunker({ maxSilenceMs: 10, minChunkChars: 1 });
    const emitted: Emitted[] = [];
    chunker.onChunk((text, reason) => emitted.push({ text, reason }));
    chunker.push("Well, something,");
    chunker.cancel();
    await sleep(30);
    expect(emitted).toEqual([]);
  });
});

describe("SpeechChunker — end-to-end reconstruction", () => {
  it("reassembling every emitted chunk (in order) reproduces the streamed reply", () => {
    const chunker = new SpeechChunker();
    const emitted: string[] = [];
    chunker.onChunk((text) => emitted.push(text));

    const tokens = [
      "A CDN ",
      "caches static assets ",
      "close to users. ",
      "That reduces latency ",
      "and origin load. ",
      "Would you like ",
      "an example",
      "?",
    ];
    for (const t of tokens) chunker.push(t);
    chunker.flush();

    expect(emitted.join(" ")).toBe(
      "A CDN caches static assets close to users. That reduces latency and origin load. Would you like an example?"
    );
  });
});

