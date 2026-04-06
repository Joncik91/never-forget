import { describe, it, expect } from "vitest";
import { ContingencyEngine } from "../engine.js";

// --- Full Integration / E2E Test ---

describe("ContingencyEngine — Full Lifecycle", () => {
  it("runs the full happy-path lifecycle", () => {
    const engine = new ContingencyEngine({
      id: "deploy-api",
      name: "Deploy API v2",
      description: "Deploy the new API version to production",
      complexityThreshold: 20,
    });

    // Add required dependencies (A and B)
    engine.addDependency({
      id: "docs",
      name: "API Documentation",
      priority: "required",
      state: "complete",
      description: "Update Swagger docs for v2 endpoints",
    });
    engine.addDependency({
      id: "tests",
      name: "Integration Tests",
      priority: "required",
      state: "complete",
      description: "All integration tests passing",
    });
    engine.addDependency({
      id: "notify",
      name: "Stakeholder Notification",
      priority: "recommended",
      state: "identified",
      description: "Notify stakeholders of deployment",
    });

    // Add tasks
    engine.addTask({
      id: "migrate-db",
      name: "Run Database Migration",
      state: "pending",
      reactions: [],
    });
    engine.addTask({
      id: "deploy",
      name: "Deploy to Production",
      state: "pending",
      reactions: [],
    });

    // Add logic gate: block deploy if tests not complete
    engine.addLogicGate({
      id: "gate-tests",
      name: "Tests must be complete",
      condition: { subject: "tests", property: "state", operator: "neq", value: "complete" },
      action: { type: "block", target: "project", message: "Integration tests are not complete" },
      enabled: true,
    });

    // Evaluate entry gate
    const gateResult = engine.evaluateEntryGate();
    expect(gateResult.passed).toBe(true);

    // Pass entry gate -> state becomes "gated"
    engine.passEntryGate();
    expect(engine.getProject().state).toBe("gated");

    // Start building
    engine.startBuilding();
    expect(engine.getProject().state).toBe("building");

    // Complete tasks
    engine.updateTaskState("migrate-db", "complete");
    engine.updateTaskState("deploy", "complete");

    // Submit for review (post-flight checks must pass)
    engine.submitForReview();
    expect(engine.getProject().state).toBe("review");

    // Mark complete
    engine.markComplete();
    expect(engine.getProject().state).toBe("complete");

    // Deploy
    engine.deploy();
    expect(engine.getProject().state).toBe("deployed");

    // Check observer events
    const events = engine.getEvents();
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((e) => e.type === "state_transition")).toBe(true);
    expect(events.some((e) => e.type === "gate_passed")).toBe(true);
  });

  it("blocks entry gate when required deps not ready", () => {
    const engine = new ContingencyEngine({ id: "p1", name: "Test" });
    engine.addDependency({
      id: "sec",
      name: "Security Review",
      priority: "required",
      state: "identified",
    });
    const result = engine.evaluateEntryGate();
    expect(result.passed).toBe(false);
    expect(result.blocked).toBe(true);
    expect(() => engine.passEntryGate()).toThrow();
  });

  it("enforces proof of work", () => {
    const engine = new ContingencyEngine({
      id: "p1",
      name: "Test",
      requireProofOfWork: true,
    });
    engine.addDependency({
      id: "docs",
      name: "Documentation",
      priority: "required",
      state: "complete",
      // no proofOfWork
    });
    expect(engine.evaluateEntryGate().passed).toBe(false);

    engine.updateDependencyState("docs", "complete", "https://example.com/proof");
    expect(engine.evaluateEntryGate().passed).toBe(true);
  });

  it("detects complexity exceeded", () => {
    const engine = new ContingencyEngine({
      id: "p1",
      name: "Test",
      complexityThreshold: 2, // very low
    });
    engine.addDependency({ id: "d1", name: "D1", priority: "required", state: "complete" });
    engine.addDependency({ id: "d2", name: "D2", priority: "required", state: "complete" });
    engine.addTask({ id: "t1", name: "T1", state: "pending", reactions: [] });

    const result = engine.checkComplexity();
    expect(result.exceeded).toBe(true);
    expect(result.score).toBeGreaterThan(result.threshold);

    // Observer should have logged it
    const events = engine.getWarnings();
    expect(events.some((e) => e.type === "complexity_exceeded")).toBe(true);
  });

  it("scans for missed reactions", () => {
    const engine = new ContingencyEngine({ id: "p1", name: "Test" });
    engine.addDependency({ id: "docs", name: "Docs", priority: "required", state: "complete" });
    engine.addTask({
      id: "t1",
      name: "Build Feature",
      state: "complete",
      reactions: [], // no reaction for "docs" dependency
    });

    const missed = engine.scanForMissedReactions();
    expect(missed).toBe(1);

    const events = engine.getWarnings();
    expect(events.some((e) => e.type === "action_without_reaction")).toBe(true);
  });

  it("evaluates logic gates correctly", () => {
    const engine = new ContingencyEngine({ id: "p1", name: "Test" });
    engine.addDependency({ id: "tests", name: "Tests", priority: "required", state: "identified" });
    engine.addLogicGate({
      id: "g1",
      name: "Block without tests",
      condition: { subject: "tests", property: "state", operator: "neq", value: "complete" },
      action: { type: "block", target: "project", message: "Tests not complete" },
      enabled: true,
    });

    const result = engine.evaluateLogicGates();
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);

    // Fix it
    engine.updateDependencyState("tests", "complete");
    const result2 = engine.evaluateLogicGates();
    expect(result2.valid).toBe(true);
  });

  it("prevents invalid state transitions", () => {
    const engine = new ContingencyEngine({ id: "p1", name: "Test" });
    expect(() => engine.deploy()).toThrow();
    expect(() => engine.startBuilding()).toThrow(); // must pass entry gate first
  });

  it("blocks submitForReview when post-flight checks fail", () => {
    const engine = new ContingencyEngine({ id: "p1", name: "Test" });
    engine.addDependency({ id: "docs", name: "Docs", priority: "required", state: "in_progress" });
    engine.passEntryGate();
    engine.startBuilding();

    // post-flight will fail because dep not verified and task not complete
    expect(() => engine.submitForReview()).toThrow();
  });
});
