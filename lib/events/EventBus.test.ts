import { describe, it, expect } from "vitest";
import { EventBus, createInterviewEventBus } from "./EventBus";
import type { InterviewEvent } from "./interviewEvents";

type TestEvent = { type: "PING"; n: number } | { type: "PONG"; label: string };

describe("EventBus", () => {
  it("delivers a published event only to handlers subscribed to that type", () => {
    const bus = new EventBus<TestEvent>();
    const pings: number[] = [];
    const pongs: string[] = [];
    bus.subscribe("PING", (e) => pings.push(e.n));
    bus.subscribe("PONG", (e) => pongs.push(e.label));

    bus.publish({ type: "PING", n: 1 });
    bus.publish({ type: "PONG", label: "hi" });
    bus.publish({ type: "PING", n: 2 });

    expect(pings).toEqual([1, 2]);
    expect(pongs).toEqual(["hi"]);
  });

  it("invokes multiple handlers for the same type in subscription order", () => {
    const bus = new EventBus<TestEvent>();
    const order: string[] = [];
    bus.subscribe("PING", () => order.push("a"));
    bus.subscribe("PING", () => order.push("b"));
    bus.publish({ type: "PING", n: 0 });
    expect(order).toEqual(["a", "b"]);
  });

  it("stops notifying a handler once its subscribe() disposer is called", () => {
    const bus = new EventBus<TestEvent>();
    let count = 0;
    const unsubscribe = bus.subscribe("PING", () => count++);
    bus.publish({ type: "PING", n: 0 });
    unsubscribe();
    bus.publish({ type: "PING", n: 0 });
    expect(count).toBe(1);
  });

  it("treats calling the same disposer twice as a safe no-op", () => {
    const bus = new EventBus<TestEvent>();
    const unsubscribe = bus.subscribe("PING", () => {});
    expect(() => {
      unsubscribe();
      unsubscribe();
    }).not.toThrow();
    expect(bus.listenerCount("PING")).toBe(0);
  });

  it("unsubscribe(type, handler) removes a handler by reference", () => {
    const bus = new EventBus<TestEvent>();
    let count = 0;
    const handler = () => count++;
    bus.subscribe("PING", handler);
    bus.unsubscribe("PING", handler);
    bus.publish({ type: "PING", n: 0 });
    expect(count).toBe(0);
  });

  it("unsubscribe() for a handler/type that was never registered is a no-op", () => {
    const bus = new EventBus<TestEvent>();
    expect(() => bus.unsubscribe("PING", () => {})).not.toThrow();
  });

  it("subscribeAll() receives every event regardless of type, in publish order", () => {
    const bus = new EventBus<TestEvent>();
    const seen: TestEvent["type"][] = [];
    bus.subscribeAll((e) => seen.push(e.type));
    bus.publish({ type: "PING", n: 1 });
    bus.publish({ type: "PONG", label: "x" });
    expect(seen).toEqual(["PING", "PONG"]);
  });

  it("unsubscribeAll() and the subscribeAll() disposer both stop wildcard delivery", () => {
    const bus = new EventBus<TestEvent>();
    let a = 0;
    let b = 0;
    const handlerA = () => a++;
    const disposeB = bus.subscribeAll(() => b++);
    bus.subscribeAll(handlerA);

    bus.publish({ type: "PING", n: 0 });
    bus.unsubscribeAll(handlerA);
    disposeB();
    bus.publish({ type: "PING", n: 0 });

    expect(a).toBe(1);
    expect(b).toBe(1);
  });

  it("isolates a throwing handler: later handlers still run and publish() does not throw", () => {
    const bus = new EventBus<TestEvent>();
    const errors: unknown[] = [];
    const busWithHook = new EventBus<TestEvent>({ onError: (err) => errors.push(err) });
    let ranAfter = false;

    busWithHook.subscribe("PING", () => {
      throw new Error("boom");
    });
    busWithHook.subscribe("PING", () => {
      ranAfter = true;
    });

    expect(() => busWithHook.publish({ type: "PING", n: 0 })).not.toThrow();
    expect(ranAfter).toBe(true);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("boom");
    // the default (no onError supplied) path must also never throw out of publish()
    bus.subscribe("PING", () => {
      throw new Error("boom too");
    });
    expect(() => bus.publish({ type: "PING", n: 0 })).not.toThrow();
  });

  it("subscribing the same function reference twice for one type dedupes to a single registration", () => {
    const bus = new EventBus<TestEvent>();
    let count = 0;
    const handler = () => count++;
    bus.subscribe("PING", handler);
    bus.subscribe("PING", handler);
    expect(bus.listenerCount("PING")).toBe(1);
    bus.publish({ type: "PING", n: 0 });
    expect(count).toBe(1);
  });

  it("listenerCount() reports per-type and total counts, including wildcard handlers", () => {
    const bus = new EventBus<TestEvent>();
    bus.subscribe("PING", () => {});
    bus.subscribe("PING", () => {});
    bus.subscribe("PONG", () => {});
    bus.subscribeAll(() => {});
    expect(bus.listenerCount("PING")).toBe(3); // 2 PING-specific + 1 wildcard
    expect(bus.listenerCount("PONG")).toBe(2); // 1 PONG-specific + 1 wildcard
    expect(bus.listenerCount()).toBe(4); // 2 + 1 + 1 wildcard, counted once
  });

  it("dispose() removes every subscription and makes publish()/subscribe() permanently inert", () => {
    const bus = new EventBus<TestEvent>();
    let count = 0;
    bus.subscribe("PING", () => count++);
    bus.subscribeAll(() => count++);
    bus.dispose();

    expect(bus.listenerCount()).toBe(0);
    bus.publish({ type: "PING", n: 0 });
    expect(count).toBe(0);

    // subscribing after dispose returns a harmless disposer but never actually registers anything
    const postDisposeUnsubscribe = bus.subscribe("PING", () => count++);
    bus.publish({ type: "PING", n: 0 });
    expect(count).toBe(0);
    expect(() => postDisposeUnsubscribe()).not.toThrow();
  });

  it("a handler that unsubscribes itself mid-publish does not disrupt the current dispatch", () => {
    const bus = new EventBus<TestEvent>();
    const calls: string[] = [];
    let disposeSelf: () => void = () => {};
    disposeSelf = bus.subscribe("PING", () => {
      calls.push("self");
      disposeSelf();
    });
    bus.subscribe("PING", () => calls.push("other"));

    bus.publish({ type: "PING", n: 0 });
    expect(calls).toEqual(["self", "other"]);

    bus.publish({ type: "PING", n: 0 });
    expect(calls).toEqual(["self", "other", "other"]);
  });
});

describe("createInterviewEventBus", () => {
  it("produces a bus that accepts real InterviewEvent values end to end", () => {
    const bus = createInterviewEventBus();
    const received: InterviewEvent[] = [];
    const unsubscribe = bus.subscribeAll((e) => received.push(e));

    bus.publish({ type: "SPEECH_STARTED", timestamp: 1 });
    bus.publish({ type: "FINAL_TRANSCRIPT", text: "hello", timestamp: 2 });

    expect(received).toEqual([
      { type: "SPEECH_STARTED", timestamp: 1 },
      { type: "FINAL_TRANSCRIPT", text: "hello", timestamp: 2 },
    ]);

    unsubscribe();
    bus.publish({ type: "AGENT_INTERRUPTED", timestamp: 3 });
    expect(received).toHaveLength(2);
  });

  it("narrows the handler's event type to the subscribed InterviewEvent variant", () => {
    const bus = createInterviewEventBus();
    const texts: string[] = [];
    bus.subscribe("FINAL_TRANSCRIPT", (e) => {
      // TypeScript should know `e.text` exists here without a cast.
      texts.push(e.text);
    });
    bus.publish({ type: "FINAL_TRANSCRIPT", text: "narrowed", timestamp: 1 });
    expect(texts).toEqual(["narrowed"]);
  });
});
