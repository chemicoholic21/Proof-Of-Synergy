import { describe, it, expect } from "vitest";
import { VoiceSession, type GenerateReply, type SynthesizeSpeech, type SynthesizeSpeechStream } from "./VoiceSession";
import { TurnManager } from "./TurnManager";
import { createInterviewEventBus } from "../events/EventBus";
import type { InterviewEvent } from "../events/interviewEvents";
import type { STTProvider } from "../providers/stt/STTProvider";

/** In-memory `STTProvider` test double — no network, fully caller-driven, matching this repo's
 *  existing plain-dependency-injection test style. */
class FakeSTTProvider implements STTProvider {
  connectCalls = 0;
  disconnectCalls = 0;
  sentAudio: ArrayBuffer[] = [];
  connectImpl: () => Promise<void> = async () => {};
  disconnectImpl: () => Promise<void> = async () => {};

  private readonly partialCbs: Array<(text: string) => void> = [];
  private readonly finalCbs: Array<(text: string) => void> = [];

  async connect(): Promise<void> {
    this.connectCalls++;
    await this.connectImpl();
  }

  sendAudio(audio: ArrayBuffer): void {
    this.sentAudio.push(audio);
  }

  async disconnect(): Promise<void> {
    this.disconnectCalls++;
    await this.disconnectImpl();
  }

  onPartial(callback: (text: string) => void): void {
    this.partialCbs.push(callback);
  }

  onFinal(callback: (text: string) => void): void {
    this.finalCbs.push(callback);
  }

  emitPartial(text: string): void {
    for (const cb of this.partialCbs) cb(text);
  }

  emitFinal(text: string): void {
    for (const cb of this.finalCbs) cb(text);
  }
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function toArrayBuffer(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

/** Waits for the next event on `bus` matching `predicate`, or rejects after `timeoutMs`. Used
 *  instead of arbitrary sleeps to deterministically wait out VoiceSession's internal async chains
 *  (LLM -> TTS) started fire-and-forget from a transcript callback. */
function waitForEvent(
  bus: ReturnType<typeof createInterviewEventBus>,
  predicate: (e: InterviewEvent) => boolean,
  timeoutMs = 1000
): Promise<InterviewEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error("timed out waiting for event"));
    }, timeoutMs);
    const unsubscribe = bus.subscribeAll((e) => {
      if (predicate(e)) {
        clearTimeout(timer);
        unsubscribe();
        resolve(e);
      }
    });
  });
}

function harness(
  overrides: {
    generateReply?: GenerateReply;
    synthesizeSpeech?: SynthesizeSpeech;
    synthesizeSpeechStream?: SynthesizeSpeechStream;
  } = {}
) {
  const sttProvider = new FakeSTTProvider();
  const events = createInterviewEventBus();
  const turnManager = new TurnManager();
  const generateReply: GenerateReply = overrides.generateReply ?? (async (t) => `reply to: ${t}`);
  const synthesizeSpeech: SynthesizeSpeech = overrides.synthesizeSpeech ?? (async (t) => toArrayBuffer(`audio(${t})`));
  const session = new VoiceSession({
    sttProvider,
    turnManager,
    eventBus: events,
    generateReply,
    synthesizeSpeech,
    ...(overrides.synthesizeSpeechStream ? { synthesizeSpeechStream: overrides.synthesizeSpeechStream } : {}),
  });
  return { session, sttProvider, events, turnManager };
}

describe("VoiceSession — session lifecycle", () => {
  it("start() connects the STT provider and moves to LISTENING", async () => {
    const { session, sttProvider, turnManager } = harness();
    await session.start();
    expect(sttProvider.connectCalls).toBe(1);
    expect(turnManager.state).toBe("LISTENING");
  });

  it("start() throws if called more than once", async () => {
    const { session } = harness();
    await session.start();
    await expect(session.start()).rejects.toThrow(/more than once/);
  });

  it("end() disconnects the STT provider and resets to IDLE", async () => {
    const { session, sttProvider, turnManager } = harness();
    await session.start();
    await session.end();
    expect(sttProvider.disconnectCalls).toBe(1);
    expect(turnManager.state).toBe("IDLE");
  });

  it("end() is idempotent — a second call does not disconnect again", async () => {
    const { session, sttProvider } = harness();
    await session.start();
    await session.end();
    await session.end();
    expect(sttProvider.disconnectCalls).toBe(1);
  });

  it("end() disposes a privately-created event bus but not an injected/shared one", async () => {
    // No eventBus override here — VoiceSession must create (and own) its own.
    const ownedSttProvider = new FakeSTTProvider();
    const ownedSession = new VoiceSession({ sttProvider: ownedSttProvider });
    await ownedSession.start();
    let count = 0;
    ownedSession.events.subscribeAll(() => count++);
    await ownedSession.end();
    ownedSession.events.publish({ type: "SPEECH_STARTED", timestamp: Date.now() });
    expect(count).toBe(0); // disposed — nothing delivered

    const sharedBus = createInterviewEventBus();
    const sttProvider = new FakeSTTProvider();
    const session2 = new VoiceSession({ sttProvider, eventBus: sharedBus });
    await session2.start();
    await session2.end();
    let sharedCount = 0;
    sharedBus.subscribeAll(() => sharedCount++);
    sharedBus.publish({ type: "SPEECH_STARTED", timestamp: Date.now() });
    expect(sharedCount).toBe(1); // NOT disposed — still a live bus for other consumers
  });
});

describe("VoiceSession — speech lifecycle and audio streaming", () => {
  it("notifySpeechStarted() moves LISTENING -> USER_SPEAKING and publishes SPEECH_STARTED", async () => {
    const { session, events, turnManager } = harness();
    await session.start();
    const seen: InterviewEvent[] = [];
    events.subscribeAll((e) => seen.push(e));

    expect(session.notifySpeechStarted()).toBe(true);
    expect(turnManager.state).toBe("USER_SPEAKING");
    expect(seen).toEqual([{ type: "SPEECH_STARTED", timestamp: expect.any(Number) }]);
  });

  it("notifySpeechStarted() is a no-op (returns false) from a state that can't reach USER_SPEAKING", async () => {
    const { session } = harness();
    // never started -> IDLE
    expect(session.notifySpeechStarted()).toBe(false);
  });

  it("pushAudio() throws before notifySpeechStarted() and forwards audio once speaking", async () => {
    const { session, sttProvider } = harness();
    await session.start();
    expect(() => session.pushAudio(toArrayBuffer("x"))).toThrow(/notifySpeechStarted/);

    session.notifySpeechStarted();
    session.pushAudio(toArrayBuffer("hello"));
    expect(sttProvider.sentAudio).toHaveLength(1);
  });

  it("notifySpeechPaused() moves USER_SPEAKING -> USER_PAUSED, and pushAudio() still works there", async () => {
    const { session, sttProvider, turnManager } = harness();
    await session.start();
    session.notifySpeechStarted();
    expect(session.notifySpeechPaused()).toBe(true);
    expect(turnManager.state).toBe("USER_PAUSED");
    session.pushAudio(toArrayBuffer("still buffering"));
    expect(sttProvider.sentAudio).toHaveLength(1);
  });
});

describe("VoiceSession — realtime-style autonomous finalization (no submitUtterance needed)", () => {
  it("reacts to onFinal firing on its own and runs the full LLM -> TTS turn back to LISTENING", async () => {
    const { session, sttProvider, events, turnManager } = harness();
    await session.start();
    session.notifySpeechStarted();

    const audioCalls: Array<{ text: string }> = [];
    session.onAudio((_audio, text) => audioCalls.push({ text }));

    const done = waitForEvent(events, (e) => e.type === "TTS_PLAYBACK_COMPLETED");
    sttProvider.emitFinal("what is a closure");
    await done;

    expect(turnManager.state).toBe("LISTENING");
    expect(audioCalls).toEqual([{ text: "reply to: what is a closure" }]);
  });

  it("publishes the full expected event sequence for one turn", async () => {
    const { session, sttProvider, events } = harness();
    await session.start();
    session.notifySpeechStarted();

    const seen: InterviewEvent["type"][] = [];
    events.subscribeAll((e) => seen.push(e.type));
    const done = waitForEvent(events, (e) => e.type === "TTS_PLAYBACK_COMPLETED");
    sttProvider.emitFinal("hello");
    await done;

    expect(seen).toEqual([
      "FINAL_TRANSCRIPT",
      "TURN_COMPLETED",
      "AGENT_GENERATION_STARTED",
      "AGENT_GENERATION_COMPLETED",
      "TTS_PLAYBACK_STARTED",
      "TTS_PLAYBACK_COMPLETED",
    ]);
  });

  it("delivers partial transcripts as PARTIAL_TRANSCRIPT without affecting turn state", async () => {
    const { session, sttProvider, events, turnManager } = harness();
    await session.start();
    session.notifySpeechStarted();

    const partials: string[] = [];
    events.subscribe("PARTIAL_TRANSCRIPT", (e) => partials.push(e.text));
    sttProvider.emitPartial("what");
    sttProvider.emitPartial("what is");

    expect(partials).toEqual(["what", "what is"]);
    expect(turnManager.state).toBe("USER_SPEAKING");
  });
});

describe("VoiceSession — submitUtterance() (batch-style provider)", () => {
  it("finalizes via disconnect()+connect() and drives the turn when the provider fires onFinal from inside disconnect()", async () => {
    const { session, sttProvider, events, turnManager } = harness();
    await session.start();
    session.notifySpeechStarted();

    sttProvider.disconnectImpl = async () => {
      sttProvider.emitFinal("batch transcript"); // mirrors SarvamSTTProvider firing onFinal pre-resolve
    };

    const speechEnded = waitForEvent(events, (e) => e.type === "SPEECH_ENDED");
    const turnDone = waitForEvent(events, (e) => e.type === "TTS_PLAYBACK_COMPLETED");
    await session.submitUtterance();
    await speechEnded;
    await turnDone; // the LLM->TTS leg runs fire-and-forget from inside disconnect() above

    expect(sttProvider.disconnectCalls).toBe(1);
    expect(sttProvider.connectCalls).toBe(2); // start() + the reconnect for the next utterance
    expect(turnManager.state).toBe("LISTENING"); // the whole turn completed and looped back around
  });

  it("throws if called while not USER_SPEAKING/USER_PAUSED", async () => {
    const { session } = harness();
    await session.start();
    await expect(session.submitUtterance()).rejects.toThrow(/is invalid from state LISTENING/);
  });

  it("returns to LISTENING (without getting stuck) when no speech was actually captured", async () => {
    const { session, sttProvider, turnManager } = harness();
    await session.start();
    session.notifySpeechStarted();
    // disconnectImpl resolves without ever calling emitFinal — an empty utterance.

    await session.submitUtterance();
    expect(turnManager.state).toBe("LISTENING");
    expect(sttProvider.connectCalls).toBe(2);
  });

  it("reports a TRANSCRIPTION error but still tries to reconnect if disconnect() rejects", async () => {
    const { session, sttProvider, events, turnManager } = harness();
    await session.start();
    session.notifySpeechStarted();
    sttProvider.disconnectImpl = async () => {
      throw new Error("network blip");
    };

    const errorEvent = waitForEvent(events, (e) => e.type === "ERROR") as Promise<
      Extract<InterviewEvent, { type: "ERROR" }>
    >;
    await session.submitUtterance();
    const err = await errorEvent;

    expect(err.stage).toBe("TRANSCRIPTION");
    expect(err.message).toContain("network blip");
    expect(sttProvider.connectCalls).toBe(2); // still attempts to prep the next utterance
    expect(turnManager.state).toBe("LISTENING");
  });
});

describe("VoiceSession — LLM/TTS failure handling", () => {
  it("a generateReply() failure publishes an AGENT_GENERATION error and returns to LISTENING without calling TTS", async () => {
    let ttsCalls = 0;
    const { session, sttProvider, events, turnManager } = harness({
      generateReply: async () => {
        throw new Error("sarvam down");
      },
      synthesizeSpeech: async (t) => {
        ttsCalls++;
        return toArrayBuffer(t);
      },
    });
    await session.start();
    session.notifySpeechStarted();

    const errorEvent = waitForEvent(events, (e) => e.type === "ERROR") as Promise<
      Extract<InterviewEvent, { type: "ERROR" }>
    >;
    sttProvider.emitFinal("hello");
    const err = await errorEvent;

    expect(err.stage).toBe("AGENT_GENERATION");
    expect(err.message).toBe("sarvam down");
    expect(ttsCalls).toBe(0);
    expect(turnManager.state).toBe("LISTENING");
  });

  it("a synthesizeSpeech() failure publishes a TTS_PLAYBACK error, returns to LISTENING, and never calls onAudio", async () => {
    const audioCalls: unknown[] = [];
    const { session, sttProvider, events, turnManager } = harness({
      synthesizeSpeech: async () => {
        throw new Error("bulbul down");
      },
    });
    session.onAudio((audio, text) => audioCalls.push({ audio, text }));
    await session.start();
    session.notifySpeechStarted();

    const errorEvent = waitForEvent(events, (e) => e.type === "ERROR") as Promise<
      Extract<InterviewEvent, { type: "ERROR" }>
    >;
    sttProvider.emitFinal("hello");
    const err = await errorEvent;

    expect(err.stage).toBe("TTS_PLAYBACK");
    expect(audioCalls).toHaveLength(0);
    expect(turnManager.state).toBe("LISTENING");
  });
});

describe("VoiceSession — streaming TTS (synthesizeSpeechStream)", () => {
  it("uses synthesizeSpeechStream instead of synthesizeSpeech when both are configured", async () => {
    let singleShotCalls = 0;
    const stream: SynthesizeSpeechStream = async (text, onChunk) => {
      onChunk(toArrayBuffer(`chunk-a(${text})`));
      onChunk(toArrayBuffer(`chunk-b(${text})`));
    };
    const { session, sttProvider, events } = harness({
      synthesizeSpeech: async (t) => {
        singleShotCalls++;
        return toArrayBuffer(t);
      },
      synthesizeSpeechStream: stream,
    });
    const audioCalls: string[] = [];
    session.onAudio((audio) => audioCalls.push(Buffer.from(audio).toString("utf-8")));

    await session.start();
    session.notifySpeechStarted();
    const done = waitForEvent(events, (e) => e.type === "TTS_PLAYBACK_COMPLETED");
    sttProvider.emitFinal("hello");
    await done;

    expect(singleShotCalls).toBe(0); // the single-shot synthesizer must never be called
    expect(audioCalls).toEqual(["chunk-a(reply to: hello)", "chunk-b(reply to: hello)"]);
  });

  it("calls onAudio once per chunk, each with the full reply text", async () => {
    const stream: SynthesizeSpeechStream = async (_text, onChunk) => {
      onChunk(toArrayBuffer("chunk-1"));
      onChunk(toArrayBuffer("chunk-2"));
      onChunk(toArrayBuffer("chunk-3"));
    };
    const { session, sttProvider, events } = harness({ synthesizeSpeechStream: stream });
    const received: Array<{ audio: string; text: string }> = [];
    session.onAudio((audio, text) => received.push({ audio: Buffer.from(audio).toString("utf-8"), text }));

    await session.start();
    session.notifySpeechStarted();
    const done = waitForEvent(events, (e) => e.type === "TTS_PLAYBACK_COMPLETED");
    sttProvider.emitFinal("hello");
    await done;

    expect(received).toEqual([
      { audio: "chunk-1", text: "reply to: hello" },
      { audio: "chunk-2", text: "reply to: hello" },
      { audio: "chunk-3", text: "reply to: hello" },
    ]);
  });

  it("publishes TTS_PLAYBACK_COMPLETED exactly once, after every chunk has been delivered", async () => {
    const stream: SynthesizeSpeechStream = async (_text, onChunk) => {
      onChunk(toArrayBuffer("a"));
      await Promise.resolve();
      onChunk(toArrayBuffer("b"));
    };
    const { session, sttProvider, events } = harness({ synthesizeSpeechStream: stream });
    const seen: string[] = [];
    events.subscribeAll((e) => seen.push(e.type));
    session.onAudio(() => seen.push("AUDIO_CHUNK"));

    await session.start();
    session.notifySpeechStarted();
    const done = waitForEvent(events, (e) => e.type === "TTS_PLAYBACK_COMPLETED");
    sttProvider.emitFinal("hello");
    await done;

    const completedCount = seen.filter((t) => t === "TTS_PLAYBACK_COMPLETED").length;
    expect(completedCount).toBe(1);
    expect(seen.indexOf("AUDIO_CHUNK")).toBeLessThan(seen.lastIndexOf("TTS_PLAYBACK_COMPLETED"));
  });

  it("a rejecting synthesizeSpeechStream publishes a TTS_PLAYBACK error and never completes", async () => {
    const stream: SynthesizeSpeechStream = async () => {
      throw new Error("bulbul stream down");
    };
    const { session, sttProvider, events, turnManager } = harness({ synthesizeSpeechStream: stream });
    const audioCalls: unknown[] = [];
    session.onAudio((a) => audioCalls.push(a));

    await session.start();
    session.notifySpeechStarted();
    const errorEvent = waitForEvent(events, (e) => e.type === "ERROR") as Promise<
      Extract<InterviewEvent, { type: "ERROR" }>
    >;
    sttProvider.emitFinal("hello");
    const err = await errorEvent;

    expect(err.stage).toBe("TTS_PLAYBACK");
    expect(audioCalls).toHaveLength(0);
    expect(turnManager.state).toBe("LISTENING");
  });

  it("stops delivering chunks to onAudio the moment interrupt() fires, even if the stream keeps calling onChunk afterward", async () => {
    const late: { deliver: (() => void) | null } = { deliver: null };
    const stream: SynthesizeSpeechStream = async (_text, onChunk, signal) => {
      onChunk(toArrayBuffer("before-interrupt"));
      await new Promise<void>((resolve) => {
        late.deliver = () => {
          // A non-cooperative synthesizer: keeps producing chunks even though `signal` was
          // already aborted by the time this fires.
          onChunk(toArrayBuffer("after-interrupt"));
          resolve();
        };
      });
      void signal; // the fake doesn't actually check it — VoiceSession's own per-chunk guard must do the work
    };
    const { session, sttProvider, events, turnManager } = harness({ synthesizeSpeechStream: stream });
    const received: string[] = [];
    session.onAudio((audio) => received.push(Buffer.from(audio).toString("utf-8")));

    await session.start();
    session.notifySpeechStarted();
    sttProvider.emitFinal("hello");
    await waitForEvent(events, (e) => e.type === "TTS_PLAYBACK_STARTED");
    await new Promise((r) => setTimeout(r, 0)); // let the first onChunk("before-interrupt") land

    expect(session.interrupt()).toBe(true);
    expect(turnManager.state).toBe("LISTENING");

    late.deliver?.();
    await new Promise((r) => setTimeout(r, 0));

    expect(received).toEqual(["before-interrupt"]); // the post-interrupt chunk never arrived
  });
});

describe("VoiceSession — cancellation / interruption", () => {
  it("interrupt() during AGENT_THINKING aborts generateReply's signal and never publishes AGENT_GENERATION_COMPLETED", async () => {
    const gen = deferred<string>();
    const captured: { signal: AbortSignal | null } = { signal: null };
    const { session, sttProvider, events, turnManager } = harness({
      generateReply: (_t, signal) => {
        captured.signal = signal;
        return gen.promise;
      },
    });
    const seen: InterviewEvent[] = [];
    events.subscribeAll((e) => seen.push(e));
    await session.start();
    session.notifySpeechStarted();
    // generateReply() returns a pending (not-yet-resolved) promise here, so runAgentTurn()
    // suspends immediately after publishing AGENT_GENERATION_STARTED and transitioning to
    // AGENT_THINKING — both already true synchronously by the time emitFinal() returns.
    sttProvider.emitFinal("hello");

    expect(turnManager.state).toBe("AGENT_THINKING");
    expect(session.interrupt()).toBe(true);
    // INTERRUPTED is a transient pass-through — interrupt() resumes LISTENING immediately per the
    // barge-in flow (stop audio -> cancel TTS -> cancel LLM if safe -> INTERRUPTED -> LISTENING).
    expect(turnManager.state).toBe("LISTENING");
    expect(captured.signal?.aborted).toBe(true);

    const interrupted = seen.find((e) => e.type === "AGENT_INTERRUPTED");
    expect(interrupted).toMatchObject({ type: "AGENT_INTERRUPTED", interruptedStage: "AGENT_GENERATION" });

    // Even if the (non-cooperative) generateReply resolves late, VoiceSession must not act on it.
    gen.resolve("too late");
    await new Promise((r) => setTimeout(r, 10));
    expect(seen.some((e) => e.type === "AGENT_GENERATION_COMPLETED")).toBe(false);
  });

  it("interrupt() during AGENT_SPEAKING aborts synthesizeSpeech's signal and never calls onAudio", async () => {
    const tts = deferred<ArrayBuffer>();
    const captured: { signal: AbortSignal | null } = { signal: null };
    const { session, sttProvider, events, turnManager } = harness({
      synthesizeSpeech: (_t, signal) => {
        captured.signal = signal;
        return tts.promise;
      },
    });
    const audioCalls: unknown[] = [];
    session.onAudio((a) => audioCalls.push(a));
    await session.start();
    session.notifySpeechStarted();
    sttProvider.emitFinal("hello");
    await waitForEvent(events, (e) => e.type === "TTS_PLAYBACK_STARTED");

    expect(turnManager.state).toBe("AGENT_SPEAKING");
    expect(session.interrupt()).toBe(true);
    expect(captured.signal?.aborted).toBe(true);

    tts.resolve(toArrayBuffer("late audio"));
    await new Promise((r) => setTimeout(r, 10));
    expect(audioCalls).toHaveLength(0);
    // INTERRUPTED is transient — interrupt() resumes LISTENING right away.
    expect(turnManager.state).toBe("LISTENING");
  });

  it("interrupt() is a no-op outside AGENT_THINKING/AGENT_SPEAKING", async () => {
    const { session, turnManager } = harness();
    await session.start();
    expect(session.interrupt()).toBe(false);
    expect(turnManager.state).toBe("LISTENING");

    session.notifySpeechStarted();
    expect(session.interrupt()).toBe(false);
    expect(turnManager.state).toBe("USER_SPEAKING");
  });

  it("end() aborts an in-flight generateReply call too", async () => {
    const gen = deferred<string>();
    const captured: { signal: AbortSignal | null } = { signal: null };
    const { session, sttProvider, events } = harness({
      generateReply: (_t, signal) => {
        captured.signal = signal;
        return gen.promise;
      },
    });
    await session.start();
    session.notifySpeechStarted();
    // Same reasoning as above: AGENT_GENERATION_STARTED has already fired synchronously.
    sttProvider.emitFinal("hello");

    await session.end();
    expect(captured.signal?.aborted).toBe(true);
  });
});

describe("VoiceSession — barge-in (AGENT_SPEAKING -> speech detected -> ... -> LISTENING)", () => {
  it("notifySpeechStarted() during AGENT_SPEAKING runs the full barge-in flow and ends at LISTENING", async () => {
    const tts = deferred<ArrayBuffer>();
    const captured: { signal: AbortSignal | null } = { signal: null };
    const { session, sttProvider, events, turnManager } = harness({
      synthesizeSpeech: (_t, signal) => {
        captured.signal = signal;
        return tts.promise;
      },
    });
    const audioCalls: unknown[] = [];
    session.onAudio((a) => audioCalls.push(a));
    const seen: InterviewEvent["type"][] = [];
    events.subscribeAll((e) => seen.push(e.type));

    await session.start();
    session.notifySpeechStarted();
    sttProvider.emitFinal("tell me about yourself");
    await waitForEvent(events, (e) => e.type === "TTS_PLAYBACK_STARTED");
    expect(turnManager.state).toBe("AGENT_SPEAKING"); // AGENT SPEAKING

    // USER SPEECH DETECTED
    const bargeIn = session.notifySpeechStarted();

    // STOP AUDIO (the AGENT_INTERRUPTED event is the signal a client must react to) / CANCEL TTS
    expect(bargeIn).toBe(true);
    expect(captured.signal?.aborted).toBe(true);
    expect(seen).toContain("AGENT_INTERRUPTED");

    // -> LISTENING (through the transient INTERRUPTED state)
    expect(turnManager.state).toBe("LISTENING");

    // Prevent stale audio chunks from playing after interruption: even if the abandoned TTS call
    // resolves later, it must never reach onAudio().
    tts.resolve(toArrayBuffer("stale reply audio"));
    await new Promise((r) => setTimeout(r, 10));
    expect(audioCalls).toHaveLength(0);
    expect(seen).not.toContain("TTS_PLAYBACK_COMPLETED");
  });

  it("notifySpeechStarted() during AGENT_THINKING also barges in (before TTS ever starts)", async () => {
    const gen = deferred<string>();
    const { session, sttProvider, events, turnManager } = harness({
      generateReply: () => gen.promise,
    });
    const seen: Array<{ type: string; interruptedStage?: string }> = [];
    events.subscribeAll((e) => seen.push(e as { type: string; interruptedStage?: string }));

    await session.start();
    session.notifySpeechStarted();
    sttProvider.emitFinal("hello");
    expect(turnManager.state).toBe("AGENT_THINKING");

    expect(session.notifySpeechStarted()).toBe(true);
    expect(turnManager.state).toBe("LISTENING");
    expect(seen).toContainEqual(
      expect.objectContaining({ type: "AGENT_INTERRUPTED", interruptedStage: "AGENT_GENERATION" })
    );
  });

  it("publishes AGENT_INTERRUPTED with interruptedStage TTS_PLAYBACK for a barge-in during AGENT_SPEAKING", async () => {
    const tts = deferred<ArrayBuffer>();
    const { session, sttProvider, events } = harness({ synthesizeSpeech: () => tts.promise });
    const interrupted: Array<{ interruptedStage?: string }> = [];
    events.subscribe("AGENT_INTERRUPTED", (e) => interrupted.push(e));

    await session.start();
    session.notifySpeechStarted();
    sttProvider.emitFinal("hello");
    await waitForEvent(events, (e) => e.type === "TTS_PLAYBACK_STARTED");

    session.notifySpeechStarted();
    expect(interrupted).toEqual([
      { type: "AGENT_INTERRUPTED", interruptedStage: "TTS_PLAYBACK", timestamp: expect.any(Number) },
    ]);
  });

  it("the learner's continued speech after a barge-in starts a normal new turn", async () => {
    const tts = deferred<ArrayBuffer>();
    const { session, sttProvider, turnManager, events } = harness({ synthesizeSpeech: () => tts.promise });
    await session.start();
    session.notifySpeechStarted();
    sttProvider.emitFinal("first question's answer");
    await waitForEvent(events, (e) => e.type === "TTS_PLAYBACK_STARTED");

    session.notifySpeechStarted(); // barge-in -> LISTENING
    expect(turnManager.state).toBe("LISTENING");

    // The caller's VAD confirms the learner really is still talking -> a normal turn this time.
    expect(session.notifySpeechStarted()).toBe(true);
    expect(turnManager.state).toBe("USER_SPEAKING");

    session.pushAudio(toArrayBuffer("continuing my answer"));
    expect(sttProvider.sentAudio).toHaveLength(1);
  });

  it("does not resurrect a barged-in turn's audio even after a second, independent turn completes", async () => {
    const firstTts = deferred<ArrayBuffer>();
    let synthesizeCall = 0;
    const { session, sttProvider, events, turnManager } = harness({
      synthesizeSpeech: async (text) => {
        synthesizeCall++;
        if (synthesizeCall === 1) return firstTts.promise;
        return toArrayBuffer(`audio(${text})`);
      },
    });
    const audioCalls: string[] = [];
    session.onAudio((_audio, text) => audioCalls.push(text));

    await session.start();
    session.notifySpeechStarted();
    sttProvider.emitFinal("first"); // turn 1 - will be barged in on
    await waitForEvent(events, (e) => e.type === "TTS_PLAYBACK_STARTED");
    session.notifySpeechStarted(); // barge-in
    expect(turnManager.state).toBe("LISTENING");

    session.notifySpeechStarted(); // real start of turn 2
    const turn2Done = waitForEvent(events, (e) => e.type === "TTS_PLAYBACK_COMPLETED");
    sttProvider.emitFinal("second");
    await turn2Done;

    // Now let turn 1's abandoned, slow TTS call finally resolve.
    firstTts.resolve(toArrayBuffer("audio(first)"));
    await new Promise((r) => setTimeout(r, 10));

    expect(audioCalls).toEqual(["reply to: second"]); // only the real, non-interrupted turn's audio
    expect(turnManager.state).toBe("LISTENING");
  });
});
