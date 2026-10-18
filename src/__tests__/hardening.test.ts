import { describe, it, expect, vi } from "vitest";
import {
  ContingencyEngine,
  createObserver,
  createProject,
  generateShadowTasks,
  evaluateAllGates,
  evaluateCondition,
  shadowReactionId,
  GateBlockedError,
  InvalidStateTransitionError,
  DuplicateIdError,
  NotFoundError,
  ProjectLockedError,
  ValidationError,
  NeverForgetError,
  type Dependency,
  type LogicGate,
  type Project,
} from "../index.js";

const dep = (id: string, over: Partial<Dependency> = {}): Dependency => ({
  id,
  name: id.toUpperCase(),
  priority: "required",
  state: "complete",
  ...over,
});

const gate = (over: Partial<LogicGate> & Pick<LogicGate, "condition" | "action">): LogicGate => ({
  id: "g",
  name: "G",
  enabled: true,
  ...over,
});

/** Engine in "building" with one required dep and one task. */
function building(): ContingencyEngine {
  const e = new ContingencyEngine({ id: "p", name: "P" });
  e.addDependency(dep("a"));
  e.passEntryGate().startBuilding();
  e.addTask({ id: "t", name: "T", state: "pending", reactions: [] });
  return e;
}

function finishAll(e: ContingencyEngine): ContingencyEngine {
  e.generateShadowTasks();
  for (const t of e.getProject().tasks) {
    for (const r of t.reactions) e.updateReactionState(t.id, { reactionId: r.id }, "complete");
    e.updateTaskState(t.id, "complete");
  }
  return e;
}

describe("core invariant: no task ships without addressing required dependencies", () => {
  it("blocks review when a completed task never addressed a required dependency", () => {
    const e = building();
    e.updateTaskState("t", "complete");
    expect(() => e.submitForReview()).toThrow(GateBlockedError);
    expect(e.getProject().state).toBe("building");
  });

  it("covers tasks added after shadow generation", () => {
    const e = finishAll(building());
    e.addTask({ id: "late", name: "Late", state: "complete", reactions: [] });
    const exit = e.checkExitCriteria();
    expect(exit.passed).toBe(false);
    expect(exit.blockers.join()).toContain("Late → A");
  });

  it("flags action-without-reaction the moment a task completes", () => {
    const e = building();
    e.updateTaskState("t", "complete");
    expect(e.getWarnings().some((w) => w.type === "action_without_reaction")).toBe(true);
  });

  it("ships the full lifecycle once reactions are complete", () => {
    const e = finishAll(building());
    e.submitForReview().markComplete().deploy();
    expect(e.getProject().state).toBe("deployed");
  });

  it("does not let open reactions for optional dependencies block shipping", () => {
    const e = new ContingencyEngine({ id: "p", name: "P" });
    e.addDependency(dep("a")).addDependency(dep("opt", { priority: "optional", state: "undefined" }));
    e.passEntryGate().startBuilding();
    e.addTask({ id: "t", name: "T", state: "pending", reactions: [] }).generateShadowTasks();
    e.updateReactionState("t", { dependencyId: "a" }, "complete").updateTaskState("t", "complete");
    const post = e.runPostFlightChecks();
    expect(post.allPassed).toBe(true);
    expect(post.checks.find((c) => c.id === "non-required-reactions-complete")?.passed).toBe(false);
    e.submitForReview();
  });
});

describe("state machine and audit consistency", () => {
  it("re-checks exit criteria on markComplete and deploy", () => {
    const e = finishAll(building()).submitForReview();
    e.updateDependencyState("a", "in_progress");
    expect(() => e.markComplete()).toThrow(GateBlockedError);
    e.updateDependencyState("a", "verified").markComplete();
    e.updateDependencyState("a", "drafted");
    expect(() => e.deploy()).toThrow(/Unverified: A/);
  });

  it("supports rework loops", () => {
    const e = finishAll(building()).submitForReview().requestChanges();
    expect(e.getProject().state).toBe("building");
    e.submitForReview().markComplete().reopen();
    expect(e.getProject().state).toBe("review");
  });

  it("logs the real from-state on every transition", () => {
    const e = finishAll(building()).submitForReview().requestChanges();
    const last = e.getEvents().filter((x) => x.type === "state_transition").at(-1);
    expect(last?.details).toBe("State transitioned from review to building");
  });

  it("checks the transition before the gate, so no bogus gate_passed is logged", () => {
    const e = new ContingencyEngine({ id: "p", name: "P" });
    e.addDependency(dep("a")).passEntryGate();
    expect(() => e.passEntryGate()).toThrow(InvalidStateTransitionError);
    expect(e.getEvents().filter((x) => x.type === "gate_passed")).toHaveLength(1);
  });

  it("removes the building → building self-transition", () => {
    const e = building();
    expect(() => e.startBuilding()).toThrow(InvalidStateTransitionError);
  });

  it("throws GateBlockedError carrying full blockers from the engine entry gate", () => {
    const e = new ContingencyEngine({ id: "p", name: "P" });
    e.addDependency(dep("a", { state: "identified" }));
    try {
      e.passEntryGate();
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(GateBlockedError);
      expect((err as GateBlockedError).gate).toBe("entry");
      expect((err as GateBlockedError).blockers[0]).toContain('"A" (a) is not ready');
    }
    expect(e.getErrors().some((x) => x.type === "gate_blocked" && x.details.includes("(a)"))).toBe(true);
  });

  it("requires at least one required dependency at the entry gate", () => {
    const e = new ContingencyEngine({ id: "p", name: "P" });
    e.addDependency(dep("o", { priority: "optional" }));
    expect(e.evaluateEntryGate().passed).toBe(false);
  });

  it("locks deployed projects", () => {
    const e = finishAll(building()).submitForReview().markComplete().deploy();
    expect(() => e.addTask({ id: "x", name: "X", state: "pending", reactions: [] })).toThrow(ProjectLockedError);
    expect(() => e.updateDependencyState("a", "undefined")).toThrow(ProjectLockedError);
    expect(() => e.generateShadowTasks()).toThrow(ProjectLockedError);
    expect(() => e.reopen()).toThrow(InvalidStateTransitionError);
  });

  it("is atomic: a rejected mutation leaves state untouched", () => {
    const e = building();
    const before = e.getProject();
    const events = e.getEvents().length;
    expect(() => e.addTask({ id: "a", name: "clash", state: "pending", reactions: [] })).toThrow(DuplicateIdError);
    expect(() => e.updateTaskState("missing", "complete")).toThrow(NotFoundError);
    expect(e.getProject()).toBe(before);
    expect(e.getEvents()).toHaveLength(events);
  });
});

describe("isolation from caller mutation", () => {
  it("copies inputs and deep-freezes snapshots", () => {
    const d = dep("a", { state: "undefined" });
    const e = new ContingencyEngine({ id: "p", name: "P" });
    e.addDependency(d);
    d.state = "complete";
    expect(e.getProject().dependencies[0].state).toBe("undefined");

    const snap = e.getProject() as Project;
    expect(() => snap.dependencies.push(dep("z"))).toThrow(TypeError);
    expect(() => {
      snap.dependencies[0].state = "verified";
    }).toThrow(TypeError);
  });

  it("copies config collections in createProject", () => {
    const deps = [dep("a")];
    const p = createProject({ id: "p", name: "P", dependencies: deps });
    deps.push(dep("b"));
    deps[0].state = "undefined";
    expect(p.dependencies).toHaveLength(1);
    expect(p.dependencies[0].state).toBe("complete");
  });
});

describe("validation", () => {
  it("rejects malformed entities with every issue listed", () => {
    const e = new ContingencyEngine({ id: "p", name: "P" });
    try {
      e.addDependency({ id: "", name: "", priority: "must" as never, state: "done" as never });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).issues).toHaveLength(4);
    }
  });

  it("rejects bad config", () => {
    expect(() => new ContingencyEngine({ id: "p", name: "P", complexityThreshold: NaN })).toThrow(ValidationError);
    expect(() => new ContingencyEngine(null as never)).toThrow(ValidationError);
    expect(() =>
      createProject({ id: "p", name: "P", tasks: [{ id: "t", name: "T", state: "pending", reactions: [{ id: "r", dependencyId: "ghost", description: "", state: "pending" }] }] }),
    ).toThrow(/unknown dependency "ghost"/);
  });

  it("enforces one id namespace for dependencies and tasks, reserving the project subject", () => {
    const e = new ContingencyEngine({ id: "p", name: "P" });
    e.addDependency(dep("a"));
    expect(() => e.addTask({ id: "a", name: "T", state: "pending", reactions: [] })).toThrow(DuplicateIdError);
    expect(() => e.addDependency(dep("project"))).toThrow(DuplicateIdError);
    expect(() => e.addDependency(dep("p"))).toThrow(DuplicateIdError);
    e.addTask({ id: "t", name: "T", state: "pending", reactions: [] });
    expect(() => e.addTask({ id: "t", name: "T2", state: "pending", reactions: [] })).toThrow(DuplicateIdError);
  });

  it("rejects duplicate gate ids and type-mismatched condition values", () => {
    const e = new ContingencyEngine({ id: "p", name: "P" });
    const g = gate({ condition: { subject: "project", property: "state", operator: "eq", value: "x" }, action: { type: "warn", target: "project" } });
    e.addLogicGate(g);
    expect(() => e.addLogicGate(g)).toThrow(DuplicateIdError);
    expect(() =>
      e.addLogicGate(gate({ id: "g2", condition: { subject: "a", property: "state", operator: "in", value: "complete" as never }, action: { type: "warn", target: "project" } })),
    ).toThrow(ValidationError);
    expect(() =>
      e.addLogicGate(gate({ id: "g3", condition: { subject: "a", property: "state", operator: "gt", value: "3" as never }, action: { type: "warn", target: "project" } })),
    ).toThrow(ValidationError);
  });

  it("rejects invalid task and reaction states", () => {
    const e = building();
    expect(() => e.updateTaskState("t", "done" as never)).toThrow(ValidationError);
    e.generateShadowTasks();
    expect(() => e.updateReactionState("t", { dependencyId: "a" }, "nope" as never)).toThrow(ValidationError);
    expect(() => e.updateReactionState("t", { dependencyId: "zzz" }, "complete")).toThrow(NotFoundError);
    expect(() => e.updateDependencyState("a", "complete", "  ")).toThrow(ValidationError);
  });
});

describe("shadow tasks", () => {
  it("produces collision-free ids", () => {
    const p = createProject({
      id: "p",
      name: "P",
      dependencies: [dep("c"), dep("b-c")],
      tasks: [
        { id: "a-b", name: "1", state: "pending", reactions: [] },
        { id: "a", name: "2", state: "pending", reactions: [] },
      ],
    });
    const ids = generateShadowTasks(p).tasks.flatMap((t) => t.reactions.map((r) => r.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("does not clobber a caller reaction that already uses the canonical id", () => {
    const id = shadowReactionId("t", "b");
    const p = createProject({
      id: "p",
      name: "P",
      dependencies: [dep("a"), dep("b")],
      tasks: [{ id: "t", name: "T", state: "pending", reactions: [{ id, dependencyId: "a", description: "", state: "pending" }] }],
    });
    const ids = generateShadowTasks(p).tasks[0].reactions.map((r) => r.id);
    expect(new Set(ids).size).toBe(2);
  });

  it("returns the same object when nothing changes", () => {
    const p = generateShadowTasks(createProject({ id: "p", name: "P", dependencies: [dep("a")], tasks: [{ id: "t", name: "T", state: "pending", reactions: [] }] }));
    expect(generateShadowTasks(p)).toBe(p);
  });
});

describe("logic gates", () => {
  it("project-level block gates stop exit transitions", () => {
    const e = finishAll(building());
    e.addLogicGate(gate({ condition: { subject: "project", property: "state", operator: "exists" }, action: { type: "block", target: "project", message: "frozen" } }));
    expect(() => e.submitForReview()).toThrow(/frozen/);
    e.setLogicGateEnabled("g", false).submitForReview();
  });

  it("task-level block gates stop that task from completing", () => {
    const e = building();
    e.addDependency(dep("sec", { priority: "recommended", state: "in_progress" }));
    e.addLogicGate(gate({ condition: { subject: "sec", property: "state", operator: "neq", value: "complete" }, action: { type: "block", target: "t", message: "security first" } }));
    expect(() => e.updateTaskState("t", "complete")).toThrow(GateBlockedError);
    expect(e.evaluateLogicGates().valid).toBe(true);
    expect(() => e.addTask({ id: "t2", name: "T2", state: "complete", reactions: [] })).not.toThrow();
    e.updateDependencyState("sec", "complete").updateTaskState("t", "complete");
  });

  it("fails closed on misconfigured gates", () => {
    const e = finishAll(building());
    e.addLogicGate(gate({ condition: { subject: "typo", property: "state", operator: "neq", value: "x" }, action: { type: "warn", target: "project" } }));
    const r = e.evaluateLogicGates();
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toContain('unknown subject "typo"');
    expect(() => e.submitForReview()).toThrow(GateBlockedError);
  });

  it("unknown subjects never match, whatever the operator", () => {
    const p = createProject({ id: "p", name: "P" });
    expect(evaluateCondition({ subject: "nope", property: "state", operator: "neq", value: "x" }, p)).toBe(false);
  });

  it("supports numeric comparisons on numeric properties", () => {
    const p = createProject({ id: "p", name: "P", dependencies: [dep("a"), dep("b")] });
    expect(evaluateCondition({ subject: "project", property: "dependencyCount", operator: "gte", value: 2 }, p)).toBe(true);
    expect(evaluateCondition({ subject: "project", property: "dependencyCount", operator: "gt", value: 2 }, p)).toBe(false);
    expect(evaluateCondition({ subject: "project", property: "dependencyCount", operator: "eq", value: "2" }, p)).toBe(true);
    const bad = evaluateAllGates({ ...p, logicGates: [gate({ condition: { subject: "a", property: "state", operator: "gt", value: 1 }, action: { type: "warn", target: "project" } })] });
    expect(bad.errors[0]).toContain("not numeric");
  });

  it("require_state blocks exit only while its requirement is unmet", () => {
    const e = finishAll(building());
    e.addLogicGate(gate({ condition: { subject: "project", property: "state", operator: "eq", value: "building" }, action: { type: "require_state", target: "a", state: "verified" } }));
    expect(() => e.submitForReview()).toThrow(/"a" must be verified \(is complete\)/);
    e.updateDependencyState("a", "verified").submitForReview();
  });

  it("generate_task creates the task once and reports it", () => {
    const e = new ContingencyEngine({ id: "p", name: "P" });
    e.addDependency(dep("a"));
    e.addLogicGate(gate({ condition: { subject: "project", property: "state", operator: "eq", value: "building" }, action: { type: "generate_task", task: { id: "rollback", name: "Write rollback plan" } } }));
    expect(e.getProject().tasks).toHaveLength(0);
    e.passEntryGate().startBuilding();
    expect(e.getProject().tasks.map((t) => t.id)).toEqual(["rollback"]);
    e.addTask({ id: "t", name: "T", state: "pending", reactions: [] });
    expect(e.getProject().tasks).toHaveLength(2);
    expect(e.getEvents().filter((x) => x.type === "task_generated")).toHaveLength(1);
  });

  it("emits edge-triggered gate events instead of requiring polling", () => {
    const e = new ContingencyEngine({ id: "p", name: "P" });
    const seen: string[] = [];
    e.subscribe((ev) => {
      if (ev.type.startsWith("gate_")) seen.push(`${ev.type}:${ev.severity}`);
    });
    e.addDependency(dep("a", { state: "drafted" }));
    e.addLogicGate(gate({ condition: { subject: "a", property: "state", operator: "neq", value: "complete" }, action: { type: "warn", target: "project" } }));
    e.updateDependencyState("a", "in_progress"); // still triggered: no new event
    e.updateDependencyState("a", "complete");
    expect(seen).toEqual(["gate_triggered:warning", "gate_cleared:info"]);
  });
});

describe("observer", () => {
  it("evicts oldest events in O(1) and counts drops", () => {
    const obs = createObserver({ maxEvents: 3 });
    for (let i = 0; i < 5; i++) obs.log({ type: "gate_passed", subject: String(i), details: "", severity: "info" });
    expect(obs.getEvents().map((e) => e.subject)).toEqual(["2", "3", "4"]);
    expect(obs.droppedCount()).toBe(2);
    expect(obs.getEvents().map((e) => e.seq)).toEqual([3, 4, 5]);
  });

  it("isolates listener failures and supports unsubscribe", () => {
    const onListenerError = vi.fn();
    const obs = createObserver({ onListenerError });
    const good = vi.fn();
    obs.subscribe(() => {
      throw new Error("boom");
    });
    const off = obs.subscribe(good);
    obs.log({ type: "gate_passed", subject: "x", details: "", severity: "info" });
    off();
    obs.log({ type: "gate_passed", subject: "y", details: "", severity: "info" });
    expect(good).toHaveBeenCalledTimes(1);
    expect(onListenerError).toHaveBeenCalledTimes(2);
    expect(obs.getEvents()).toHaveLength(2);
  });

  it("returns frozen events so the audit log cannot be rewritten", () => {
    const obs = createObserver();
    obs.log({ type: "gate_passed", subject: "x", details: "", severity: "info" });
    expect(Object.isFrozen(obs.getEventsByType("gate_passed")[0])).toBe(true);
  });

  it("rejects nonsensical capacity", () => {
    expect(() => createObserver({ maxEvents: 0 })).toThrow(ValidationError);
  });

  it("can be shared through engine options", () => {
    const obs = createObserver();
    const e = new ContingencyEngine({ id: "p", name: "P" }, { observer: obs });
    e.addDependency(dep("a"));
    expect(obs.getEventsByType("dependency_added")).toHaveLength(1);
  });
});

describe("derived warnings fire once per crossing", () => {
  it("complexity", () => {
    const e = new ContingencyEngine({ id: "p", name: "P", complexityThreshold: 2 });
    e.addDependency(dep("a")).addDependency(dep("b")).addDependency(dep("c"));
    expect(e.getWarnings().filter((w) => w.type === "complexity_exceeded")).toHaveLength(1);
    expect(e.checkComplexity()).toEqual({ exceeded: true, score: 6, threshold: 2 });
  });

  it("proof of work", () => {
    const e = new ContingencyEngine({ id: "p", name: "P", requireProofOfWork: true });
    e.addDependency(dep("a"));
    e.updateDependencyState("a", "verified");
    expect(e.getWarnings().filter((w) => w.type === "proof_required")).toHaveLength(1);
    e.updateDependencyState("a", "verified", "https://ci/1");
    expect(e.evaluateEntryGate().passed).toBe(true);
  });
});

describe("error hierarchy", () => {
  it("every library error is a NeverForgetError", () => {
    const e = new ContingencyEngine({ id: "p", name: "P" });
    for (const fn of [
      () => e.deploy(),
      () => e.passEntryGate(),
      () => e.updateTaskState("x", "complete"),
      () => e.addDependency({} as never),
    ]) {
      expect(fn).toThrow(NeverForgetError);
    }
  });
});
