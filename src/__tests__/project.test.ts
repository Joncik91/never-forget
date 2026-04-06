import { describe, it, expect } from "vitest";
import {
  createProject,
  addDependency,
  updateDependencyState,
  addTask,
  transitionState,
  evaluateEntryGate,
  passEntryGate,
  runPreFlightChecks,
  runPostFlightChecks,
} from "../project.js";
import type { Dependency, Task, Project } from "../types.js";
import { GateBlockedError, InvalidStateTransitionError } from "../errors.js";

function makeProject(): Project {
  return createProject({
    id: "proj-1",
    name: "Test Project",
    description: "A test project",
  });
}

function makeRequiredDep(overrides?: Partial<Dependency>): Dependency {
  return {
    id: "dep-1",
    name: "Documentation",
    priority: "required",
    state: "complete",
    ...overrides,
  };
}

function makeTask(overrides?: Partial<Task>): Task {
  return {
    id: "task-1",
    name: "Update Database",
    state: "pending",
    reactions: [],
    ...overrides,
  };
}

// --- createProject ---

describe("createProject", () => {
  it("creates a project with defaults", () => {
    const p = createProject({ id: "p1", name: "Test" });
    expect(p.id).toBe("p1");
    expect(p.name).toBe("Test");
    expect(p.state).toBe("defined");
    expect(p.dependencies).toEqual([]);
    expect(p.logicGates).toEqual([]);
    expect(p.tasks).toEqual([]);
    expect(p.requireProofOfWork).toBe(false);
    expect(p.complexityThreshold).toBe(10);
  });

  it("applies config overrides", () => {
    const dep = makeRequiredDep();
    const p = createProject({
      id: "p1",
      name: "Test",
      dependencies: [dep],
      requireProofOfWork: true,
      complexityThreshold: 20,
    });
    expect(p.dependencies).toHaveLength(1);
    expect(p.requireProofOfWork).toBe(true);
    expect(p.complexityThreshold).toBe(20);
  });
});

// --- addDependency ---

describe("addDependency", () => {
  it("adds a dependency to the project", () => {
    const p = addDependency(makeProject(), makeRequiredDep());
    expect(p.dependencies).toHaveLength(1);
    expect(p.dependencies[0].name).toBe("Documentation");
  });

  it("throws if dependency already exists", () => {
    const p = addDependency(makeProject(), makeRequiredDep());
    expect(() => addDependency(p, makeRequiredDep())).toThrow("already exists");
  });
});

// --- updateDependencyState ---

describe("updateDependencyState", () => {
  it("updates the state of a dependency", () => {
    const p = addDependency(makeProject(), makeRequiredDep({ state: "identified" }));
    const updated = updateDependencyState(p, "dep-1", "complete");
    expect(updated.dependencies[0].state).toBe("complete");
  });

  it("sets proof of work when provided", () => {
    const p = addDependency(makeProject(), makeRequiredDep());
    const updated = updateDependencyState(p, "dep-1", "verified", "https://example.com/proof");
    expect(updated.dependencies[0].proofOfWork).toBe("https://example.com/proof");
  });

  it("throws if dependency not found", () => {
    expect(() => updateDependencyState(makeProject(), "missing", "complete")).toThrow(
      "not found",
    );
  });
});

// --- addTask ---

describe("addTask", () => {
  it("adds a task to the project", () => {
    const p = addTask(makeProject(), makeTask());
    expect(p.tasks).toHaveLength(1);
    expect(p.tasks[0].name).toBe("Update Database");
  });
});

// --- transitionState ---

describe("transitionState", () => {
  it("transitions from defined to gated", () => {
    const p = transitionState(makeProject(), "gated");
    expect(p.state).toBe("gated");
  });

  it("throws on invalid transition", () => {
    expect(() => transitionState(makeProject(), "deployed")).toThrow(
      InvalidStateTransitionError,
    );
  });

  it("allows full lifecycle transitions", () => {
    let p = makeProject();
    p = transitionState(p, "gated");
    p = transitionState(p, "building");
    p = transitionState(p, "review");
    p = transitionState(p, "complete");
    p = transitionState(p, "deployed");
    expect(p.state).toBe("deployed");
  });
});

// --- evaluateEntryGate (Tier 1: Binary Lock) ---

describe("evaluateEntryGate", () => {
  it("blocks when no dependencies defined", () => {
    const result = evaluateEntryGate(makeProject());
    expect(result.passed).toBe(false);
    expect(result.blocked).toBe(true);
  });

  it("blocks when required dependency is not ready", () => {
    const p = addDependency(
      makeProject(),
      makeRequiredDep({ state: "identified" }),
    );
    const result = evaluateEntryGate(p);
    expect(result.passed).toBe(false);
    expect(result.blocked).toBe(true);
  });

  it("passes when all required dependencies are ready", () => {
    const p = addDependency(
      makeProject(),
      makeRequiredDep({ state: "complete" }),
    );
    const result = evaluateEntryGate(p);
    expect(result.passed).toBe(true);
    expect(result.blocked).toBe(false);
  });

  it("blocks when proof of work required but missing", () => {
    let p = makeProject();
    p = { ...p, requireProofOfWork: true };
    p = addDependency(p, makeRequiredDep({ state: "complete" }));
    const result = evaluateEntryGate(p);
    expect(result.passed).toBe(false);
  });

  it("passes when proof of work is provided", () => {
    let p = makeProject();
    p = { ...p, requireProofOfWork: true };
    p = addDependency(
      p,
      makeRequiredDep({ state: "complete", proofOfWork: "https://proof.example.com" }),
    );
    const result = evaluateEntryGate(p);
    expect(result.passed).toBe(true);
  });

  it("ignores optional dependencies that are not ready", () => {
    const p = addDependency(
      makeProject(),
      makeRequiredDep({ id: "opt-1", priority: "optional", state: "undefined" }),
    );
    const result = evaluateEntryGate(p);
    expect(result.passed).toBe(true);
  });
});

// --- passEntryGate ---

describe("passEntryGate", () => {
  it("transitions project to gated when gate passes", () => {
    const p = addDependency(
      makeProject(),
      makeRequiredDep({ state: "complete" }),
    );
    const result = passEntryGate(p);
    expect(result.state).toBe("gated");
  });

  it("throws GateBlockedError when gate fails", () => {
    expect(() => passEntryGate(makeProject())).toThrow(GateBlockedError);
  });
});

// --- runPreFlightChecks ---

describe("runPreFlightChecks", () => {
  it("fails when no required dependencies", () => {
    const result = runPreFlightChecks(makeProject());
    expect(result.allPassed).toBe(false);
  });

  it("passes with required dependencies and logic gates", () => {
    let p = makeProject();
    p = addDependency(p, makeRequiredDep({ state: "complete" }));
    p = {
      ...p,
      logicGates: [
        {
          id: "gate-1",
          name: "Doc check",
          condition: { subject: "dep-1", property: "state", operator: "eq", value: "complete" },
          action: { type: "block", target: "project", message: "Doc not complete" },
          enabled: true,
        },
      ],
    };
    const result = runPreFlightChecks(p);
    expect(result.allPassed).toBe(true);
  });
});

// --- runPostFlightChecks ---

describe("runPostFlightChecks", () => {
  it("fails when required dependencies not verified", () => {
    let p = makeProject();
    p = addDependency(p, makeRequiredDep({ state: "in_progress" }));
    const result = runPostFlightChecks(p);
    expect(result.allPassed).toBe(false);
  });

  it("fails when tasks incomplete", () => {
    let p = makeProject();
    p = addDependency(p, makeRequiredDep({ state: "verified" }));
    p = addTask(p, makeTask({ state: "in_progress" }));
    const result = runPostFlightChecks(p);
    expect(result.allPassed).toBe(false);
  });

  it("passes when everything complete", () => {
    let p = makeProject();
    p = addDependency(p, makeRequiredDep({ state: "verified" }));
    p = addTask(
      p,
      makeTask({
        state: "complete",
        reactions: [
          { id: "r1", dependencyId: "dep-1", description: "Update docs", state: "complete" },
        ],
      }),
    );
    const result = runPostFlightChecks(p);
    expect(result.allPassed).toBe(true);
  });

  it("fails when proof of work required but missing", () => {
    let p = makeProject();
    p = { ...p, requireProofOfWork: true };
    p = addDependency(p, makeRequiredDep({ state: "verified" }));
    const result = runPostFlightChecks(p);
    expect(result.allPassed).toBe(false);
  });
});
