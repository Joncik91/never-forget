import type { Project, ObserverEvent, Severity } from "./types.js";

// --- Observer Protocol ---

export interface Observer {
  log(event: Omit<ObserverEvent, "timestamp">): void;
  getEvents(): ObserverEvent[];
  getEventsByType(type: ObserverEvent["type"]): ObserverEvent[];
  getEventsBySeverity(severity: Severity): ObserverEvent[];
  clear(): void;
}

const MAX_EVENTS = 1000;

export function createObserver(): Observer {
  const events: ObserverEvent[] = [];

  return {
    log(event) {
      if (events.length >= MAX_EVENTS) {
        events.shift();
      }
      events.push({
        ...event,
        timestamp: new Date().toISOString(),
      });
    },

    getEvents() {
      return [...events];
    },

    getEventsByType(type) {
      return events.filter((e) => e.type === type);
    },

    getEventsBySeverity(severity) {
      return events.filter((e) => e.severity === severity);
    },

    clear() {
      events.length = 0;
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

export function observeGateBlocked(
  observer: Observer,
  gateName: string,
  reason: string,
): void {
  observer.log({
    type: "gate_blocked",
    subject: gateName,
    details: reason,
    severity: "error",
  });
}

export function observeGatePassed(
  observer: Observer,
  gateName: string,
): void {
  observer.log({
    type: "gate_passed",
    subject: gateName,
    details: `Gate "${gateName}" passed`,
    severity: "info",
  });
}

export function observeStateTransition(
  observer: Observer,
  fromState: string,
  toState: string,
): void {
  observer.log({
    type: "state_transition",
    subject: "project",
    details: `State transitioned from ${fromState} to ${toState}`,
    severity: "info",
  });
}

export function observeComplexityExceeded(
  observer: Observer,
  current: number,
  threshold: number,
): void {
  observer.log({
    type: "complexity_exceeded",
    subject: "project",
    details: `Complexity (${current}) exceeds threshold (${threshold}) — re-evaluate dependencies`,
    severity: "warning",
  });
}

export function scanForMissedReactions(
  project: Project,
  observer: Observer,
): number {
  let missed = 0;
  for (const task of project.tasks) {
    if (task.state === "complete") {
      for (const dep of project.dependencies) {
        const hasReaction = task.reactions.some(
          (r) => r.dependencyId === dep.id && r.state === "complete",
        );
        if (!hasReaction && dep.priority === "required") {
          observeActionWithoutReaction(observer, task.name, dep.name);
          missed++;
        }
      }
    }
  }
  return missed;
}
