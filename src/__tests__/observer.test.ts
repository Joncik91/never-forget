import { describe, it, expect } from "vitest";
import {
  createObserver,
  observeActionWithoutReaction,
  observeGateBlocked,
  observeGatePassed,
  observeStateTransition,
  observeComplexityExceeded,
  scanForMissedReactions,
} from "../observer.js";
import type { Project } from "../types.js";

function makeProject(): Project {
  return {
    id: "proj-1",
    name: "Test",
    description: "",
    state: "building",
    dependencies: [
      { id: "dep-1", name: "Docs", priority: "required", state: "complete" },
    ],
    logicGates: [],
    tasks: [
      {
        id: "task-1",
        name: "Build API",
        state: "complete",
        reactions: [],
      },
    ],
    complexityThreshold: 10,
    requireProofOfWork: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe("createObserver", () => {
  it("starts with no events", () => {
    const obs = createObserver();
    expect(obs.getEvents()).toHaveLength(0);
  });

  it("logs and retrieves events", () => {
    const obs = createObserver();
    obs.log({
      type: "state_transition",
      subject: "project",
      details: "defined -> gated",
      severity: "info",
    });
    expect(obs.getEvents()).toHaveLength(1);
    expect(obs.getEvents()[0].type).toBe("state_transition");
    expect(obs.getEvents()[0].timestamp).toBeDefined();
  });

  it("filters events by type", () => {
    const obs = createObserver();
    obs.log({ type: "gate_blocked", subject: "entry", details: "blocked", severity: "error" });
    obs.log({ type: "gate_passed", subject: "entry", details: "passed", severity: "info" });
    expect(obs.getEventsByType("gate_blocked")).toHaveLength(1);
    expect(obs.getEventsByType("gate_passed")).toHaveLength(1);
  });

  it("filters events by severity", () => {
    const obs = createObserver();
    obs.log({ type: "gate_blocked", subject: "x", details: "x", severity: "error" });
    obs.log({ type: "gate_passed", subject: "x", details: "x", severity: "info" });
    obs.log({ type: "state_transition", subject: "x", details: "x", severity: "warning" });
    expect(obs.getEventsBySeverity("error")).toHaveLength(1);
    expect(obs.getEventsBySeverity("info")).toHaveLength(1);
    expect(obs.getEventsBySeverity("warning")).toHaveLength(1);
  });

  it("clears all events", () => {
    const obs = createObserver();
    obs.log({ type: "gate_passed", subject: "x", details: "x", severity: "info" });
    obs.clear();
    expect(obs.getEvents()).toHaveLength(0);
  });
});

describe("observeActionWithoutReaction", () => {
  it("logs a warning event", () => {
    const obs = createObserver();
    observeActionWithoutReaction(obs, "Build API", "Docs");
    const events = obs.getEvents();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("action_without_reaction");
    expect(events[0].severity).toBe("warning");
  });
});

describe("observeGateBlocked", () => {
  it("logs an error event", () => {
    const obs = createObserver();
    observeGateBlocked(obs, "entry", "Missing docs");
    const events = obs.getEvents();
    expect(events[0].type).toBe("gate_blocked");
    expect(events[0].severity).toBe("error");
  });
});

describe("observeGatePassed", () => {
  it("logs an info event", () => {
    const obs = createObserver();
    observeGatePassed(obs, "entry");
    expect(obs.getEvents()[0].severity).toBe("info");
  });
});

describe("observeStateTransition", () => {
  it("logs an info event", () => {
    const obs = createObserver();
    observeStateTransition(obs, "defined", "gated");
    expect(obs.getEvents()[0].details).toContain("defined");
    expect(obs.getEvents()[0].details).toContain("gated");
  });
});

describe("observeComplexityExceeded", () => {
  it("logs a warning event", () => {
    const obs = createObserver();
    observeComplexityExceeded(obs, 25, 10);
    const evt = obs.getEvents()[0];
    expect(evt.type).toBe("complexity_exceeded");
    expect(evt.details).toContain("25");
    expect(evt.details).toContain("10");
  });
});

describe("scanForMissedReactions", () => {
  it("detects missed reactions for completed tasks", () => {
    const project = makeProject();
    // task-1 is complete but has no reaction for dep-1 (required)
    const obs = createObserver();
    const missed = scanForMissedReactions(project, obs);
    expect(missed).toBe(1);
    expect(obs.getEventsByType("action_without_reaction")).toHaveLength(1);
  });

  it("returns 0 when all reactions are complete", () => {
    const project = makeProject();
    project.tasks[0].reactions = [
      { id: "r1", dependencyId: "dep-1", description: "Update docs", state: "complete" },
    ];
    const obs = createObserver();
    const missed = scanForMissedReactions(project, obs);
    expect(missed).toBe(0);
  });

  it("ignores pending tasks", () => {
    const project = makeProject();
    project.tasks[0].state = "pending";
    const obs = createObserver();
    const missed = scanForMissedReactions(project, obs);
    expect(missed).toBe(0);
  });
});
