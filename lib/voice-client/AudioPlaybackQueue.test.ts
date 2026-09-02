import { describe, it, expect } from "vitest";
import { AudioPlaybackQueue } from "./AudioPlaybackQueue";

function chunk(label: string): ArrayBuffer {
  return new TextEncoder().encode(label).buffer;
}

function toLabel(buf: ArrayBuffer): string {
  return new TextDecoder().decode(buf);
}

/** A controllable fake `play()` — resolves only when the test calls `resolveNext()`, so tests can
 *  assert strict ordering (chunk 2 never starts playing before chunk 1 resolves). */
function controllablePlayer() {
  const started: string[] = [];
  const pending: Array<() => void> = [];
  const play = (buf: ArrayBuffer): Promise<void> => {
    started.push(toLabel(buf));
    return new Promise((resolve) => pending.push(resolve));
  };
  const resolveNext = () => {
    const resolve = pending.shift();
    if (!resolve) throw new Error("controllablePlayer: nothing pending to resolve");
    resolve();
  };
  return { play, started, resolveNext, pendingCount: () => pending.length };
}

describe("AudioPlaybackQueue", () => {
  it("plays a single enqueued chunk", async () => {
    const started: string[] = [];
    const queue = new AudioPlaybackQueue({
      play: async (buf) => {
        started.push(toLabel(buf));
      },
    });
    queue.enqueue(chunk("a"));
    await new Promise((r) => setTimeout(r, 0));
    expect(started).toEqual(["a"]);
  });

  it("never starts a second chunk before the first one's play() resolves", async () => {
    const { play, started, resolveNext } = controllablePlayer();
    const queue = new AudioPlaybackQueue({ play });

    queue.enqueue(chunk("a"));
    queue.enqueue(chunk("b"));
    queue.enqueue(chunk("c"));

    await new Promise((r) => setTimeout(r, 0));
    expect(started).toEqual(["a"]); // b and c must still be waiting

    resolveNext();
    await new Promise((r) => setTimeout(r, 0));
    expect(started).toEqual(["a", "b"]);

    resolveNext();
    await new Promise((r) => setTimeout(r, 0));
    expect(started).toEqual(["a", "b", "c"]);

    resolveNext();
    await new Promise((r) => setTimeout(r, 0));
    expect(queue.length).toBe(0);
  });

  it("keeps playing later chunks after an earlier one's play() rejects, reporting the error instead of throwing", async () => {
    const started: string[] = [];
    const errors: Array<{ message: string; label: string }> = [];
    const queue = new AudioPlaybackQueue({
      play: async (buf) => {
        const label = toLabel(buf);
        started.push(label);
        if (label === "bad") throw new Error("boom");
      },
      onError: (error, buf) => errors.push({ message: error.message, label: toLabel(buf) }),
    });

    queue.enqueue(chunk("good-1"));
    queue.enqueue(chunk("bad"));
    queue.enqueue(chunk("good-2"));

    await new Promise((r) => setTimeout(r, 10));
    expect(started).toEqual(["good-1", "bad", "good-2"]);
    expect(errors).toEqual([{ message: "boom", label: "bad" }]);
  });

  it("enqueuing while idle (nothing draining) starts a new drain immediately", async () => {
    const { play, started, resolveNext } = controllablePlayer();
    const queue = new AudioPlaybackQueue({ play });

    queue.enqueue(chunk("a"));
    await new Promise((r) => setTimeout(r, 0));
    resolveNext();
    await new Promise((r) => setTimeout(r, 0));
    expect(queue.length).toBe(0);

    queue.enqueue(chunk("b"));
    await new Promise((r) => setTimeout(r, 0));
    expect(started).toEqual(["a", "b"]);
  });

  it("clear() drops every queued-but-unplayed chunk and stops the drain from continuing into them", async () => {
    const { play, started, resolveNext } = controllablePlayer();
    const queue = new AudioPlaybackQueue({ play });

    queue.enqueue(chunk("a"));
    queue.enqueue(chunk("b"));
    queue.enqueue(chunk("c"));
    await new Promise((r) => setTimeout(r, 0));
    expect(started).toEqual(["a"]);

    queue.clear();
    expect(queue.length).toBe(0);

    // "a"'s in-flight play() resolving late must not resurrect "b"/"c" — the non-cooperative
    // cancellation guard (`generation`) must have already invalidated this drain loop.
    resolveNext();
    await new Promise((r) => setTimeout(r, 10));
    expect(started).toEqual(["a"]);
    expect(queue.length).toBe(0);
  });

  it("a fresh enqueue() after clear() starts a brand-new drain rather than staying stuck", async () => {
    const { play, started, resolveNext } = controllablePlayer();
    const queue = new AudioPlaybackQueue({ play });

    queue.enqueue(chunk("a"));
    await new Promise((r) => setTimeout(r, 0));
    queue.clear();
    resolveNext();

    queue.enqueue(chunk("z"));
    await new Promise((r) => setTimeout(r, 0));
    expect(started).toEqual(["a", "z"]);
  });
});
