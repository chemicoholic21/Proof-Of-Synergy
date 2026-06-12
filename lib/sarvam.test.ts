import { describe, it, expect } from "vitest";
import { extractJson, extractValidatedJson } from "./sarvam";
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
