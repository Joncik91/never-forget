import { describe, it, expect } from "vitest";
import { evaluateCondition, evaluateGate, evaluateAllGates } from "../logic-gate.js";
import type { Project, LogicGate } from "../types.js";

function makeProject(overrides?: Partial<Project>): Project {
  return {
    id: "proj-1",
    name: "Test Project",
    description: "",
    state: "building",
    dependencies: [
      { id: "dep-1", name: "Docs", priority: "required", state: "complete" },
      { id: "dep-2", name: "Tests", priority: "required", state: "identified" },
    ],
    logicGates: [],
    tasks: [{ id: "task-1", name: "Build API", state: "in_progress", reactions: [] }],
    complexityThreshold: 10,
    requireProofOfWork: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

// --- evaluateCondition ---

describe("evaluateCondition", () => {
  it("evaluates project state with eq operator", () => {
    const project = makeProject();
    expect(
      evaluateCondition(
        { subject: "project", property: "state", operator: "eq", value: "building" },
        project,
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        { subject: "project", property: "state", operator: "eq", value: "complete" },
        project,
      ),
    ).toBe(false);
  });

  it("evaluates dependency state", () => {
    const project = makeProject();
    expect(
      evaluateCondition(
        { subject: "dep-1", property: "state", operator: "eq", value: "complete" },
        project,
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        { subject: "dep-2", property: "state", operator: "eq", value: "identified" },
        project,
      ),
    ).toBe(true);
  });

  it("evaluates in operator", () => {
    const project = makeProject();
    expect(
      evaluateCondition(
        { subject: "dep-1", property: "state", operator: "in", value: ["complete", "verified"] },
        project,
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        { subject: "dep-2", property: "state", operator: "in", value: ["complete", "verified"] },
        project,
      ),
    ).toBe(false);
  });

  it("evaluates not_in operator", () => {
    const project = makeProject();
    expect(
      evaluateCondition(
        { subject: "dep-2", property: "state", operator: "not_in", value: ["complete", "verified"] },
        project,
      ),
    ).toBe(true);
  });

  it("evaluates exists operator", () => {
    const project = makeProject();
    expect(
      evaluateCondition(
        { subject: "dep-1", property: "state", operator: "exists", value: "" },
        project,
      ),
    ).toBe(true);
  });

  it("evaluates neq operator", () => {
    const project = makeProject();
    expect(
      evaluateCondition(
        { subject: "project", property: "state", operator: "neq", value: "complete" },
        project,
      ),
    ).toBe(true);
  });

  it("returns false for unknown subject", () => {
    const project = makeProject();
    expect(
      evaluateCondition(
        { subject: "unknown", property: "state", operator: "eq", value: "x" },
        project,
      ),
    ).toBe(false);
  });
});

// --- evaluateGate ---

describe("evaluateGate", () => {
  it("returns triggered when condition is true", () => {
    const project = makeProject();
    const gate: LogicGate = {
      id: "g1",
      name: "Block if tests not done",
      condition: { subject: "dep-2", property: "state", operator: "neq", value: "complete" },
      action: { type: "block", target: "project", message: "Tests not complete" },
      enabled: true,
    };
    const result = evaluateGate(gate, project);
    expect(result.triggered).toBe(true);
  });

  it("returns not triggered when condition is false", () => {
    const project = makeProject();
    const gate2: LogicGate = {
      id: "g2",
      name: "Block if tests incomplete",
      condition: { subject: "dep-1", property: "state", operator: "eq", value: "incomplete" },
      action: { type: "block", target: "project", message: "Docs incomplete" },
      enabled: true,
    };
    const result2 = evaluateGate(gate2, project);
    expect(result2.triggered).toBe(false);
  });

  it("skips disabled gates", () => {
    const project = makeProject();
    const gate: LogicGate = {
      id: "g1",
      name: "Block",
      condition: { subject: "dep-2", property: "state", operator: "neq", value: "complete" },
      action: { type: "block", target: "project", message: "Blocked" },
      enabled: false,
    };
    const result = evaluateGate(gate, project);
    expect(result.triggered).toBe(false);
  });
});

// --- evaluateAllGates ---

describe("evaluateAllGates", () => {
  it("returns errors for block-type triggered gates", () => {
    const project = makeProject();
    project.logicGates = [
      {
        id: "g1",
        name: "Test check",
        condition: { subject: "dep-2", property: "state", operator: "neq", value: "complete" },
        action: { type: "block", target: "project", message: "Tests not done" },
        enabled: true,
      },
    ];
    const result = evaluateAllGates(project);
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
  });

  it("returns warnings for warn-type triggered gates", () => {
    const project = makeProject();
    project.logicGates = [
      {
        id: "g1",
        name: "Soft check",
        condition: { subject: "dep-2", property: "state", operator: "neq", value: "complete" },
        action: { type: "warn", target: "project", message: "Tests not done yet" },
        enabled: true,
      },
    ];
    const result = evaluateAllGates(project);
    expect(result.valid).toBe(true);
    expect(result.warnings).toHaveLength(1);
  });

  it("returns valid when no gates triggered", () => {
    const project = makeProject();
    project.logicGates = [
      {
        id: "g1",
        name: "Check docs",
        condition: { subject: "dep-1", property: "state", operator: "eq", value: "complete" },
        action: { type: "warn", target: "project", message: "Should not trigger" },
        enabled: true,
      },
    ];
    // dep-1 state IS "complete" so this WILL trigger. Use a condition that's false.
    project.logicGates = [
      {
        id: "g1",
        name: "Check incomplete",
        condition: { subject: "dep-1", property: "state", operator: "eq", value: "undefined" },
        action: { type: "block", target: "project", message: "Docs missing" },
        enabled: true,
      },
    ];
    const result = evaluateAllGates(project);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});
