import { describe, it, expect } from "vitest";
import { extractJson, extractValidatedJson, clampSpeech, extractJsonArrayItems } from "./sarvam";
import { z } from "zod";

describe("extractJson", () => {
  it("parses a bare JSON object", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it("parses JSON wrapped in prose", () => {
    expect(extractJson('Here is your result: {"score": 90}, done.')).toEqual({ score: 90 });
  });

  it("parses JSON inside a ```json code fence", () => {
    const raw = "```json\n{\"ok\": true}\n```";
    expect(extractJson(raw)).toEqual({ ok: true });
  });

  it("parses JSON arrays", () => {
    expect(extractJson("prefix [1,2,3] suffix")).toEqual([1, 2, 3]);
  });

  it("does NOT break on braces inside string values", () => {
    const raw = '{"feedback":"use a map like { key: value }","score":80}';
    expect(extractJson(raw)).toEqual({ feedback: "use a map like { key: value }", score: 80 });
  });

  it("does NOT break on escaped quotes inside strings", () => {
    const raw = '{"feedback":"he said \\"hi\\" then left","score":50}';
    expect(extractJson(raw)).toEqual({ feedback: 'he said "hi" then left', score: 50 });
  });

  it("extracts only the FIRST balanced object when two are present", () => {
    const raw = '{"score":1} garbage {"score":2}';
    expect(extractJson(raw)).toEqual({ score: 1 });
  });

  it("throws when no JSON is present", () => {
    expect(() => extractJson("no json here")).toThrow(/No JSON found/);
  });
});

describe("extractJsonArrayItems (truncation salvage)", () => {
  it("returns all items from a complete array", () => {
    const raw = '{"questions":[{"id":1,"text":"a"},{"id":2,"text":"b"}]}';
    expect(extractJsonArrayItems(raw)).toEqual([{ id: 1, text: "a" }, { id: 2, text: "b" }]);
  });

  it("salvages complete objects when the final one is truncated mid-string", () => {
    // Array never closes; last object is cut off inside a string value.
    const raw = '{"questions":[{"id":1,"text":"complete"},{"id":2,"text":"this got cut o';
    expect(extractJsonArrayItems(raw)).toEqual([{ id: 1, text: "complete" }]);
  });

  it("does not get confused by braces/brackets inside string values", () => {
    const raw = '{"questions":[{"id":1,"text":"use a map { } and a list [ ]"},{"id":2,"text":"trunc';
    expect(extractJsonArrayItems(raw)).toEqual([{ id: 1, text: "use a map { } and a list [ ]" }]);
  });

  it("returns [] when there is no array", () => {
    expect(extractJsonArrayItems("no json here")).toEqual([]);
  });
});

describe("clampSpeech", () => {
  it("returns short text unchanged", () => {
    expect(clampSpeech("Hello there.", 100)).toBe("Hello there.");
  });

  it("never exceeds the limit", () => {
    const long = "word ".repeat(500);
    expect(clampSpeech(long, 100).length).toBeLessThanOrEqual(100);
  });

  it("does not cut mid-word (breaks on whitespace)", () => {
    const out = clampSpeech("alpha bravo charlie delta echo foxtrot", 20);
    expect(out.endsWith(" ")).toBe(false);
    expect(out.split(" ").every((w) => "alpha bravo charlie delta echo foxtrot".includes(w))).toBe(true);
  });

  it("prefers a sentence boundary when one is reasonably near the limit", () => {
    const out = clampSpeech("First sentence here. Second sentence runs on and on and on.", 30);
    expect(out).toBe("First sentence here.");
  });
});

describe("extractValidatedJson", () => {
  const schema = z.object({ score: z.coerce.number(), feedback: z.string() });

  it("returns validated data", () => {
    expect(extractValidatedJson('{"score":"88","feedback":"good"}', schema)).toEqual({
      score: 88,
      feedback: "good",
    });
  });

  it("throws when the parsed JSON violates the schema", () => {
    expect(() => extractValidatedJson('{"score":90}', schema)).toThrow();
  });
});
