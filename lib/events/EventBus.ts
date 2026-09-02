/**
 * Lightweight, dependency-free typed event bus.
 *
 * Framework-independent: nothing here touches React, the DOM, or Next.js, so an `EventBus` can
 * run inside a browser component (`VoiceRecorder`, `app/practice/page.tsx`), a server route
 * handler, or a plain script equally well. `EventBus<TEvent>` is generic over any discriminated
 * union shaped `{ type: string }` — `./interviewEvents`'s `InterviewEvent` is just the type this
 * module was built for, wired up via the `createInterviewEventBus()` convenience export at the
 * bottom of this file, not a hard dependency of the class itself.
 *
 * This module only defines the bus itself — no producers publish `InterviewEvent`s onto it yet,
 * and no consumer subscribes to it. Wiring it into the actual voice pipeline is later work.
 */

import type { InterviewEvent } from "./interviewEvents";

/** Returned by every subscription method. Call it to remove that one registration. Calling it
 *  more than once is safe and a no-op after the first call. */
export type Unsubscribe = () => void;

export type EventHandler<TEvent> = (event: TEvent) => void;

/** Narrow a union `TEvent` down to the member(s) whose `type` field is exactly `TType`. */
type EventOfType<TEvent extends { type: string }, TType extends TEvent["type"]> = Extract<
  TEvent,
  { type: TType }
>;

/**
 * Invoked when a listener throws, instead of letting the throw escape `publish()` and interrupt
 * still-pending listeners. Must not itself throw — the bus does not guard against that.
 */
export type EventBusErrorHandler<TEvent extends { type: string } = { type: string }> = (
  error: unknown,
  event: TEvent
) => void;

/** Default error hook: report to the console rather than crash the publisher. Swallows its own
 *  failures so a broken `console` can never break `publish()`. */
function defaultOnError(error: unknown, event: { type: string }): void {
  try {
    console.error(`[EventBus] listener for "${event.type}" threw`, error);
  } catch {
    /* the console itself must never be able to break publish() */
  }
}

/**
 * A minimal typed publish/subscribe bus for a discriminated union of events (`TEvent`).
 *
 * - `subscribe(type, handler)` registers `handler` for one event type and returns an
 *   `Unsubscribe` function that removes exactly that registration.
 * - `unsubscribe(type, handler)` removes a handler registered with the same `type` + handler
 *   reference, for callers that would rather hold onto the handler than the disposer.
 * - `subscribeAll(handler)` / `unsubscribeAll(handler)` register/remove a handler that receives
 *   every event regardless of `type` — handy for a single logging/telemetry sink.
 * - `publish(event)` synchronously notifies every matching handler. Handlers are isolated from
 *   each other: one throwing is reported via the (overridable) error hook and never stops the
 *   remaining handlers — or the publisher — from running.
 * - `dispose()` removes every registration in one call and makes the bus permanently inert, so a
 *   session/component teardown can guarantee no handler (and whatever closure state it captured)
 *   is invoked, or kept alive, ever again — the main safeguard against a forgotten `unsubscribe`
 *   leaking memory.
 *
 * Subscribing the exact same function reference to the same type more than once is deduped to a
 * single registration (a plain `Set`, the same behavior as `EventTarget.addEventListener`) — use
 * distinct closures if independent registrations of equivalent logic are actually needed.
 */
export class EventBus<TEvent extends { type: string } = { type: string }> {
  private readonly listeners = new Map<TEvent["type"], Set<EventHandler<TEvent>>>();
  private readonly wildcardListeners = new Set<EventHandler<TEvent>>();
  private readonly onError: EventBusErrorHandler<TEvent>;
  private disposed = false;

  constructor(opts: { onError?: EventBusErrorHandler<TEvent> } = {}) {
    this.onError = opts.onError ?? (defaultOnError as EventBusErrorHandler<TEvent>);
  }

  /** Subscribe `handler` to events whose `type` is exactly `type`. Returns a disposer. */
  subscribe<TType extends TEvent["type"]>(
    type: TType,
    handler: EventHandler<EventOfType<TEvent, TType>>
  ): Unsubscribe {
    if (this.disposed) return noop;
    const asBusHandler = handler as unknown as EventHandler<TEvent>;
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(asBusHandler);

    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const current = this.listeners.get(type);
      current?.delete(asBusHandler);
      if (current && current.size === 0) this.listeners.delete(type);
    };
  }

  /** Remove a handler previously registered for `type` via `subscribe`. A no-op if it isn't registered. */
  unsubscribe<TType extends TEvent["type"]>(
    type: TType,
    handler: EventHandler<EventOfType<TEvent, TType>>
  ): void {
    const set = this.listeners.get(type);
    if (!set) return;
    set.delete(handler as unknown as EventHandler<TEvent>);
    if (set.size === 0) this.listeners.delete(type);
  }

  /** Subscribe `handler` to every event, regardless of `type`. Returns a disposer. */
  subscribeAll(handler: EventHandler<TEvent>): Unsubscribe {
    if (this.disposed) return noop;
    this.wildcardListeners.add(handler);

    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.wildcardListeners.delete(handler);
    };
  }

  /** Remove a handler previously registered via `subscribeAll`. A no-op if it isn't registered. */
  unsubscribeAll(handler: EventHandler<TEvent>): void {
    this.wildcardListeners.delete(handler);
  }

  /**
   * Notify every handler subscribed to `event.type`, then every wildcard handler. A no-op after
   * `dispose()`. Each notification list is snapshotted before iterating, so a handler that
   * subscribes or unsubscribes in reaction to this exact event can never skip, duplicate, or
   * otherwise perturb the handlers already scheduled for this `publish()` call.
   */
  publish(event: TEvent): void {
    if (this.disposed) return;

    const typed = this.listeners.get(event.type);
    if (typed && typed.size > 0) {
      for (const handler of Array.from(typed)) this.invoke(handler, event);
    }
    if (this.wildcardListeners.size > 0) {
      for (const handler of Array.from(this.wildcardListeners)) this.invoke(handler, event);
    }
  }

  private invoke(handler: EventHandler<TEvent>, event: TEvent): void {
    try {
      handler(event);
    } catch (error) {
      this.onError(error, event);
    }
  }

  /** Number of handlers currently registered for `type`, or the total across every type and the
   *  wildcard list when `type` is omitted. Mainly useful for tests and diagnostics. */
  listenerCount(type?: TEvent["type"]): number {
    if (type === undefined) {
      let total = this.wildcardListeners.size;
      for (const set of this.listeners.values()) total += set.size;
      return total;
    }
    return (this.listeners.get(type)?.size ?? 0) + this.wildcardListeners.size;
  }

  /**
   * Remove every subscription at once (typed and wildcard) and mark the bus inert: any further
   * `subscribe`/`subscribeAll` call returns a no-op disposer instead of registering a handler,
   * and `publish` becomes a no-op. Call this when the owning session/component unmounts (e.g. a
   * React `useEffect` cleanup) so no handler closure — and whatever it captured, timers, DOM
   * nodes, component state — is kept reachable by a subscription nobody remembered to cancel
   * individually.
   */
  dispose(): void {
    this.listeners.clear();
    this.wildcardListeners.clear();
    this.disposed = true;
  }
}

function noop(): void {
  /* returned by subscribe()/subscribeAll() once the bus is disposed */
}

/** A bus scoped to `InterviewEvent` — the concrete type this module exists to carry. */
export type InterviewEventBus = EventBus<InterviewEvent>;

/** Construct a new, empty event bus for one interview session's event stream. */
export function createInterviewEventBus(opts?: {
  onError?: EventBusErrorHandler<InterviewEvent>;
}): InterviewEventBus {
  return new EventBus<InterviewEvent>(opts);
}
