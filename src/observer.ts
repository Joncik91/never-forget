import type { ObserverEvent, Project, Severity } from "./types.js";
import { findMissingReactions } from "./project.js";
import { ValidationError } from "./errors.js";

// --- Observer Protocol ---

export type ObserverListener = (event: Readonly<ObserverEvent>) => void;

export interface Observer {
  log(event: Omit<ObserverEvent, "timestamp" | "seq">): Readonly<ObserverEvent>;
  getEvents(): Readonly<ObserverEvent>[];
  getEventsByType(type: ObserverEvent["type"]): Readonly<ObserverEvent>[];
  getEventsBySeverity(severity: Severity): Readonly<ObserverEvent>[];
  /** Receives every event as it is logged. Returns an unsubscribe function. */
  subscribe(listener: ObserverListener): () => void;
  /** Events evicted because the buffer was full, since creation or the last clear(). */
  droppedCount(): number;
  clear(): void;
}

export interface ObserverOptions {
  /** Retained events; the oldest are evicted first. Default 1000. */
  maxEvents?: number;
  /**
   * Called when a listener throws. Listener failures never interrupt logging or
   * the engine. Default: console.error.
   */
  onListenerError?: (error: unknown, event: Readonly<ObserverEvent>) => void;
  /** Clock override, mainly for tests. */
  now?: () => Date;
}

export const DEFAULT_MAX_EVENTS = 1000;

export function createObserver(options: ObserverOptions = {}): Observer {
  const capacity = options.maxEvents ?? DEFAULT_MAX_EVENTS;
  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new ValidationError("observer options", ["maxEvents must be an integer >= 1"]);
  }
  const onListenerError =
    options.onListenerError ??
    ((error: unknown) => console.error("[never-forget] observer listener threw:", error));
  const clock = options.now ?? (() => new Date());

  // Ring buffer: O(1) append and eviction.
  const buffer: (Readonly<ObserverEvent> | undefined)[] = new Array(capacity);
  let start = 0;
  let size = 0;
  let seq = 0;
  let dropped = 0;
  const listeners = new Set<ObserverListener>();

  function snapshot(): Readonly<ObserverEvent>[] {
    const out: Readonly<ObserverEvent>[] = [];
    for (let i = 0; i < size; i++) out.push(buffer[(start + i) % capacity]!);
    return out;
  }

  return {
    log(input) {
      const event: Readonly<ObserverEvent> = Object.freeze({
        type: input.type,
        subject: input.subject,
        details: input.details,
        severity: input.severity,
        seq: ++seq,
        timestamp: clock().toISOString(),
      });
      if (size < capacity) {
        buffer[(start + size) % capacity] = event;
        size++;
      } else {
        buffer[start] = event;
        start = (start + 1) % capacity;
        dropped++;
      }
      // Copy so listeners may unsubscribe during dispatch.
      for (const listener of [...listeners]) {
        try {
          listener(event);
        } catch (error) {
          onListenerError(error, event);
        }
      }
      return event;
    },

    getEvents: snapshot,

    getEventsByType(type) {
      return snapshot().filter((e) => e.type === type);
    },

    getEventsBySeverity(severity) {
      return snapshot().filter((e) => e.severity === severity);
    },

    subscribe(listener) {
      if (typeof listener !== "function") {
        throw new ValidationError("observer listener", ["listener must be a function"]);
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    droppedCount() {
      return dropped;
    },

    clear() {
      buffer.fill(undefined);
      start = 0;
      size = 0;
      dropped = 0;
    },
  };
}

// --- Observer Integration ---

export function observeActionWithoutReaction(
  observer: Observer,
  taskName: string,
  missingDependencyName: string,
): void {
  observer.log({
    type: "action_without_reaction",
    subject: taskName,
    details: `Task "${taskName}" executed without addressing dependency "${missingDependencyName}"`,
    severity: "warning",
  });
}

export function observeGateBlocked(observer: Observer, gateName: string, reason: string): void {
  observer.log({ type: "gate_blocked", subject: gateName, details: reason, severity: "error" });
}

export function observeGatePassed(observer: Observer, gateName: string): void {
  observer.log({
    type: "gate_passed",
    subject: gateName,
    details: `Gate "${gateName}" passed`,
    severity: "info",
  });
}

export function observeStateTransition(observer: Observer, fromState: string, toState: string): void {
  observer.log({
    type: "state_transition",
    subject: "project",
    details: `State transitioned from ${fromState} to ${toState}`,
    severity: "info",
  });
}

export function observeComplexityExceeded(observer: Observer, current: number, threshold: number): void {
  observer.log({
    type: "complexity_exceeded",
    subject: "project",
    details: `Complexity (${current}) exceeds threshold (${threshold}) — re-evaluate dependencies`,
    severity: "warning",
  });
}

/** Logs one warning per completed task lacking a completed reaction for a required dependency. Returns the count. */
export function scanForMissedReactions(project: Project, observer: Observer): number {
  const missed = findMissingReactions(project).filter((m) => m.task.state === "complete");
  for (const m of missed) observeActionWithoutReaction(observer, m.task.name, m.dependency.name);
  return missed.length;
}
