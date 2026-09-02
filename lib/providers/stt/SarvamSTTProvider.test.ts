import { describe, it, expect } from "vitest";
import { SarvamSTTProvider } from "./SarvamSTTProvider";

function textToArrayBuffer(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

/** A fake `sarvamTranscribe` replacement — records every call and returns a canned result, so
 *  these tests never touch the network (matching this repo's existing test style: no vi.mock,
 *  just plain dependency injection). */
function fakeTranscribe(result: { text: string; language: string } = { text: "hello world", language: "en-IN" }) {
  const calls: Array<{ blob: Blob; filename: string; timeoutMs: number }> = [];
  const fn = async (blob: Blob, filename: string, timeoutMs = 20000) => {
    calls.push({ blob, filename, timeoutMs });
    return result;
  };
  return { fn, calls };
}

function fakeFailingTranscribe(error: Error) {
  const calls: unknown[] = [];
  const fn = async () => {
    calls.push(true);
    throw error;
  };
  return { fn, calls };
}

describe("SarvamSTTProvider", () => {
  it("throws if sendAudio() is called before connect()", () => {
    const provider = new SarvamSTTProvider();
    expect(() => provider.sendAudio(textToArrayBuffer("x"))).toThrow(/connect/);
  });

  it("disconnect() with no buffered audio resolves without calling transcribe or firing onFinal", async () => {
    const { fn, calls } = fakeTranscribe();
    const provider = new SarvamSTTProvider({ transcribe: fn });
    let finalCount = 0;
    provider.onFinal(() => finalCount++);

    await provider.connect();
    await provider.disconnect();

    expect(calls).toHaveLength(0);
    expect(finalCount).toBe(0);
  });

  it("assembles buffered chunks into one Blob and hands it to transcribe on disconnect()", async () => {
    const { fn, calls } = fakeTranscribe();
    const provider = new SarvamSTTProvider({ transcribe: fn });

    await provider.connect();
    provider.sendAudio(textToArrayBuffer("hello "));
    provider.sendAudio(textToArrayBuffer("world"));
    await provider.disconnect();

    expect(calls).toHaveLength(1);
    const { blob, filename } = calls[0];
    expect(blob.type).toBe("audio/webm");
    expect(filename).toBe("utterance.webm");
    expect(await blob.text()).toBe("hello world");
  });

  it("invokes every registered onFinal callback with the transcript text on success", async () => {
    const { fn } = fakeTranscribe({ text: "the final transcript", language: "hi-IN" });
    const provider = new SarvamSTTProvider({ transcribe: fn });
    const seenA: string[] = [];
    const seenB: string[] = [];
    provider.onFinal((text) => seenA.push(text));
    provider.onFinal((text) => seenB.push(text));

    await provider.connect();
    provider.sendAudio(textToArrayBuffer("audio"));
    await provider.disconnect();

    expect(seenA).toEqual(["the final transcript"]);
    expect(seenB).toEqual(["the final transcript"]);
  });

  it("exposes the detected language on lastLanguage after a successful disconnect()", async () => {
    const { fn } = fakeTranscribe({ text: "namaste", language: "hi-IN" });
    const provider = new SarvamSTTProvider({ transcribe: fn });

    expect(provider.lastLanguage).toBeNull();
    await provider.connect();
    provider.sendAudio(textToArrayBuffer("audio"));
    await provider.disconnect();

    expect(provider.lastLanguage).toBe("hi-IN");
  });

  it("registers onPartial callbacks but never invokes them (Sarvam has no partial results)", async () => {
    const { fn } = fakeTranscribe();
    const provider = new SarvamSTTProvider({ transcribe: fn });
    let partialCount = 0;
    provider.onPartial(() => partialCount++);

    await provider.connect();
    provider.sendAudio(textToArrayBuffer("audio"));
    await provider.disconnect();

    expect(partialCount).toBe(0);
  });

  it("propagates a transcribe() failure by rejecting disconnect(), without firing onFinal", async () => {
    const { fn, calls } = fakeFailingTranscribe(new Error("Sarvam STT 500: boom"));
    const provider = new SarvamSTTProvider({ transcribe: fn });
    let finalCount = 0;
    provider.onFinal(() => finalCount++);

    await provider.connect();
    provider.sendAudio(textToArrayBuffer("audio"));
    await expect(provider.disconnect()).rejects.toThrow("Sarvam STT 500: boom");

    expect(calls).toHaveLength(1);
    expect(finalCount).toBe(0);
  });

  it("marks the session closed even when the transcribe() call fails", async () => {
    const { fn } = fakeFailingTranscribe(new Error("boom"));
    const provider = new SarvamSTTProvider({ transcribe: fn });

    await provider.connect();
    provider.sendAudio(textToArrayBuffer("audio"));
    await expect(provider.disconnect()).rejects.toThrow();

    // The session is over; sendAudio() must require a fresh connect(), not silently keep buffering.
    expect(() => provider.sendAudio(textToArrayBuffer("more"))).toThrow(/connect/);
  });

  it("disconnect() is idempotent: a second call does not re-transcribe or fire onFinal again", async () => {
    const { fn, calls } = fakeTranscribe();
    const provider = new SarvamSTTProvider({ transcribe: fn });
    let finalCount = 0;
    provider.onFinal(() => finalCount++);

    await provider.connect();
    provider.sendAudio(textToArrayBuffer("audio"));
    await provider.disconnect();
    await provider.disconnect();

    expect(calls).toHaveLength(1);
    expect(finalCount).toBe(1);
  });

  it("sendAudio() after disconnect() throws rather than silently buffering for a future session", async () => {
    const { fn } = fakeTranscribe();
    const provider = new SarvamSTTProvider({ transcribe: fn });

    await provider.connect();
    provider.sendAudio(textToArrayBuffer("audio"));
    await provider.disconnect();

    expect(() => provider.sendAudio(textToArrayBuffer("more"))).toThrow(/connect/);
  });

  it("connect() after a completed session starts a clean buffer for the next utterance", async () => {
    const { fn, calls } = fakeTranscribe({ text: "first", language: "en-IN" });
    const provider = new SarvamSTTProvider({ transcribe: fn });

    await provider.connect();
    provider.sendAudio(textToArrayBuffer("first utterance"));
    await provider.disconnect();

    await provider.connect();
    provider.sendAudio(textToArrayBuffer("second utterance"));
    await provider.disconnect();

    expect(calls).toHaveLength(2);
    expect(await calls[1].blob.text()).toBe("second utterance");
  });

  it("connect() while already connected discards any unfinalized buffered audio", async () => {
    const { fn, calls } = fakeTranscribe();
    const provider = new SarvamSTTProvider({ transcribe: fn });

    await provider.connect();
    provider.sendAudio(textToArrayBuffer("abandoned"));
    await provider.connect(); // re-connect without ever disconnecting - starts fresh
    provider.sendAudio(textToArrayBuffer("kept"));
    await provider.disconnect();

    expect(calls).toHaveLength(1);
    expect(await calls[0].blob.text()).toBe("kept");
  });

  it("honors custom mimeType, filename, and timeoutMs options", async () => {
    const { fn, calls } = fakeTranscribe();
    const provider = new SarvamSTTProvider({
      transcribe: fn,
      mimeType: "audio/wav",
      filename: "answer-1.wav",
      timeoutMs: 5000,
    });

    await provider.connect();
    provider.sendAudio(textToArrayBuffer("audio"));
    await provider.disconnect();

    expect(calls[0].blob.type).toBe("audio/wav");
    expect(calls[0].filename).toBe("answer-1.wav");
    expect(calls[0].timeoutMs).toBe(5000);
  });

  it("defaults to the real sarvamTranscribe when no transcribe override is supplied", () => {
    // Purely a construction smoke test - asserts the default wiring doesn't throw building the
    // instance; SARVAM_API_KEY is unset in the test env, so we never actually call disconnect()
    // here (that would hit the real network path in lib/sarvam.ts).
    expect(() => new SarvamSTTProvider()).not.toThrow();
  });
});
