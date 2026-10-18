import type {
  ComplexityResult,
  Dependency,
  DependencyState,
  FlightCheckResult,
  GateEvaluation,
  GateResult,
  LogicGate,
  ObserverEvent,
  Project,
  ProjectConfig,
  ProjectState,
  ReactionSelector,
  Severity,
  Task,
  TaskState,
  ValidationResult,
} from "./types.js";
import {
  addDependency,
  addLogicGate,
  addTask,
  assertCanTransition,
  createProject,
  evaluateEntryGate,
  findMissingReactions,
  needsProof,
  runPostFlightChecks,
  runPreFlightChecks,
  setLogicGateEnabled,
  transitionState,
  updateDependencyState,
  updateReactionState,
  updateTaskState,
} from "./project.js";
import { applyGeneratedTasks, evaluateAllGates, getTaskBlockers } from "./logic-gate.js";
import { generateShadowTasks } from "./shadow-task.js";
import { calculateComplexity } from "./complexity.js";
import { GateBlockedError } from "./errors.js";
import {
  createObserver,
  observeActionWithoutReaction,
  observeComplexityExceeded,
  observeGateBlocked,
  observeGatePassed,
  observeStateTransition,
  scanForMissedReactions,
  type Observer,
  type ObserverListener,
} from "./observer.js";

// ============================================================================
// ContingencyEngine — the stateful orchestrator around the pure core.
//
// Every mutation is atomic: the next state is computed by a pure function
// (which throws on invalid input), then committed in one step. After each
// commit the engine reconciles derived state reactively — generated tasks,
// logic-gate edges, complexity and proof warnings — so consumers subscribe to
// events instead of polling.
// ============================================================================

export interface EngineOptions {
  /** Supply your own observer (custom capacity, shared log, test clock). */
  observer?: Observer;
}

export interface ExitCriteria {
  passed: boolean;
  blockers: string[];
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

function gateSeverity(r: GateEvaluation): Severity {
  if (r.status === "invalid" || r.blocksProject || r.blocksTask) return "error";
  return r.action.type === "warn" ? "warning" : "info";
}

export class ContingencyEngine {
  #project: Project;
  readonly #observer: Observer;
  /** Last seen status per gate, for edge-triggered events. */
  readonly #gateState = new Map<string, string>();
  readonly #proofFlagged = new Set<string>();
  readonly #reportedSkips = new Set<string>();
  #complexityExceeded = false;

  constructor(config: ProjectConfig, options: EngineOptions = {}) {
    this.#observer = options.observer ?? createObserver();
    this.#project = deepFreeze(createProject(config));
    this.#apply(this.#project);
  }

  // --- Read-only access ---

  /** Deep-frozen snapshot. Safe to keep; never changes after it is returned. */
  getProject(): Readonly<Project> {
    return this.#project;
  }

  getEvents(): Readonly<ObserverEvent>[] {
    return this.#observer.getEvents();
  }

  getErrors(): Readonly<ObserverEvent>[] {
    return this.#observer.getEventsBySeverity("error");
  }

  getWarnings(): Readonly<ObserverEvent>[] {
    return this.#observer.getEventsBySeverity("warning");
  }

  /** Live event stream. Returns an unsubscribe function. */
  subscribe(listener: ObserverListener): () => void {
    return this.#observer.subscribe(listener);
  }

  // --- Dependencies ---

  addDependency(dependency: Dependency): this {
    const next = addDependency(this.#project, dependency);
    this.#apply(next, () =>
      this.#log("dependency_added", dependency.id, `Dependency "${dependency.name}" added with priority ${dependency.priority}`),
    );
    return this;
  }

  updateDependencyState(dependencyId: string, newState: DependencyState, proofOfWork?: string): this {
    const before = this.#project.dependencies.find((d) => d.id === dependencyId)?.state;
    const next = updateDependencyState(this.#project, dependencyId, newState, proofOfWork);
    this.#apply(next, () =>
      this.#log(
        "dependency_updated",
        dependencyId,
        `Dependency state ${before} → ${newState}${proofOfWork !== undefined ? " (proof attached)" : ""}`,
      ),
    );
    return this;
  }

  // --- Tasks ---

  addTask(task: Task): this {
    const next = addTask(this.#project, task);
    if (task.state === "complete") this.#assertTaskNotBlocked(next, task.id);
    this.#apply(next, () => {
      this.#log("task_added", task.id, `Task "${task.name}" added (${task.state})`);
      if (task.state === "complete") this.#flagUnaddressed(task.id);
    });
    return this;
  }

  updateTaskState(taskId: string, newState: TaskState): this {
    const before = this.#project.tasks.find((t) => t.id === taskId)?.state;
    if (newState === "complete" && before !== "complete") this.#assertTaskNotBlocked(this.#project, taskId);
    const next = updateTaskState(this.#project, taskId, newState);
    this.#apply(next, () => {
      this.#log("task_updated", taskId, `Task state ${before} → ${newState}`);
      if (newState === "complete" && before !== "complete") this.#flagUnaddressed(taskId);
    });
    return this;
  }

  /** Update one reaction (`{ reactionId }`) or all of a task's reactions for a dependency (`{ dependencyId }`). */
  updateReactionState(
    taskId: string,
    selector: ReactionSelector,
    newState: TaskState,
    proofOfWork?: string,
  ): this {
    const next = updateReactionState(this.#project, taskId, selector, newState, proofOfWork);
    const which = "reactionId" in selector ? `reaction ${selector.reactionId}` : `reactions for ${selector.dependencyId}`;
    this.#apply(next, () => this.#log("reaction_updated", taskId, `Task "${taskId}" ${which} → ${newState}`));
    return this;
  }

  // --- Logic Gates ---

  addLogicGate(gate: LogicGate): this {
    const next = addLogicGate(this.#project, gate);
    this.#apply(next, () => this.#log("logic_gate_added", gate.id, `Logic gate "${gate.name}" added`));
    return this;
  }

  setLogicGateEnabled(gateId: string, enabled: boolean): this {
    const next = setLogicGateEnabled(this.#project, gateId, enabled);
    this.#apply(next, () =>
      this.#log("logic_gate_updated", gateId, `Logic gate ${enabled ? "enabled" : "disabled"}`),
    );
    return this;
  }

  // --- Shadow Tasks ---

  generateShadowTasks(): this {
    const countReactions = (p: Project) => p.tasks.reduce((n, t) => n + t.reactions.length, 0);
    const next = generateShadowTasks(this.#project);
    const added = countReactions(next) - countReactions(this.#project);
    this.#apply(next, () =>
      this.#log("shadow_task_generated", "project", `${added} shadow reaction(s) generated`),
    );
    return this;
  }

  // --- Gate Evaluation ---

  evaluateEntryGate(): GateResult {
    return evaluateEntryGate(this.#project);
  }

  passEntryGate(): this {
    assertCanTransition(this.#project, "gated");
    const result = evaluateEntryGate(this.#project);
    if (result.blocked) {
      for (const blocker of result.blockers) observeGateBlocked(this.#observer, "entry", blocker);
      throw new GateBlockedError(result.blockers, "entry");
    }
    const from = this.#project.state;
    this.#apply(transitionState(this.#project, "gated"), () => {
      observeGatePassed(this.#observer, "entry");
      observeStateTransition(this.#observer, from, "gated");
    });
    return this;
  }

  evaluateLogicGates(): ValidationResult {
    return evaluateAllGates(this.#project);
  }

  // --- Flight Checks ---

  runPreFlightChecks(): FlightCheckResult {
    return runPreFlightChecks(this.#project);
  }

  runPostFlightChecks(): FlightCheckResult {
    return runPostFlightChecks(this.#project);
  }

  /** Everything that would stop the project leaving the build right now: post-flight failures and blocking logic gates. */
  checkExitCriteria(): ExitCriteria {
    const blockers: string[] = [];
    for (const check of runPostFlightChecks(this.#project).checks) {
      if (!check.passed && check.blocking !== false) {
        blockers.push(check.details ? `${check.message}: ${check.details}` : check.message);
      }
    }
    blockers.push(...evaluateAllGates(this.#project).errors);
    return { passed: blockers.length === 0, blockers };
  }

  // --- State Transitions ---

  startBuilding(): this {
    return this.#transition("building", false);
  }

  /** building → review. Requires exit criteria. */
  submitForReview(): this {
    return this.#transition("review", true);
  }

  /** review → building, for rework after review. */
  requestChanges(): this {
    return this.#transition("building", false);
  }

  /** review → complete. Re-checks exit criteria; state may have changed during review. */
  markComplete(): this {
    return this.#transition("complete", true);
  }

  /** complete → review. */
  reopen(): this {
    return this.#transition("review", false);
  }

  /** complete → deployed (terminal, immutable). Re-checks exit criteria. */
  deploy(): this {
    return this.#transition("deployed", true);
  }

  // --- Complexity ---

  /** Pure query. Crossing the threshold is logged automatically, once per crossing. */
  checkComplexity(): ComplexityResult {
    const score = calculateComplexity(this.#project);
    const threshold = this.#project.complexityThreshold;
    return { exceeded: score > threshold, score, threshold };
  }

  // --- Observer Scans ---

  scanForMissedReactions(): number {
    return scanForMissedReactions(this.#project, this.#observer);
  }

  // --- Internal ---

  #log(type: ObserverEvent["type"], subject: string, details: string, severity: Severity = "info"): void {
    this.#observer.log({ type, subject, details, severity });
  }

  #transition(to: ProjectState, requireExitCriteria: boolean): this {
    assertCanTransition(this.#project, to);
    if (requireExitCriteria) {
      const exit = this.checkExitCriteria();
      if (!exit.passed) {
        for (const blocker of exit.blockers) observeGateBlocked(this.#observer, "exit", blocker);
        throw new GateBlockedError(exit.blockers, "exit");
      }
    }
    const from = this.#project.state;
    this.#apply(transitionState(this.#project, to), () => {
      if (requireExitCriteria) observeGatePassed(this.#observer, "exit");
      observeStateTransition(this.#observer, from, to);
    });
    return this;
  }

  #assertTaskNotBlocked(project: Project, taskId: string): void {
    const blockers = getTaskBlockers(project, taskId);
    if (blockers.length === 0) return;
    for (const b of blockers) observeGateBlocked(this.#observer, `task:${taskId}`, b);
    throw new GateBlockedError(blockers, `task:${taskId}`);
  }

  /** Real-time "action without reaction" detection when a task completes. */
  #flagUnaddressed(taskId: string): void {
    for (const m of findMissingReactions(this.#project)) {
      if (m.task.id === taskId) observeActionWithoutReaction(this.#observer, m.task.name, m.dependency.name);
    }
  }

  /** Commits a new state, logs the triggering action, then reconciles derived state. */
  #apply(next: Project, logAction?: () => void): void {
    const { project, generated, skipped } = applyGeneratedTasks(next);
    this.#project = deepFreeze(project);
    logAction?.();

    for (const g of generated) {
      this.#log("task_generated", g.task.id, `Task "${g.task.name}" generated by logic gate ${g.gateId}`);
    }
    for (const s of skipped) {
      const key = `${s.gateId}\u0000${s.taskId}`;
      if (this.#reportedSkips.has(key)) continue;
      this.#reportedSkips.add(key);
      this.#log("gate_blocked", s.gateId, `Cannot generate task "${s.taskId}": ${s.reason}`, "error");
    }

    this.#reconcileGates();
    this.#reconcileProof();
    this.#reconcileComplexity();
  }

  #reconcileGates(): void {
    const results = new Map(evaluateAllGates(this.#project).results.map((r) => [r.gateId, r]));
    for (const gate of this.#project.logicGates) {
      const r = results.get(gate.id);
      const status = r?.status ?? "idle";
      const key = `${status}\u0000${r?.message ?? ""}`;
      const prev = this.#gateState.get(gate.id) ?? `idle\u0000`;
      if (key === prev) continue;
      this.#gateState.set(gate.id, key);
      if (!r || status === "idle") {
        this.#log("gate_cleared", gate.id, `Logic gate "${gate.name}" no longer triggered`);
      } else {
        this.#log(
          "gate_triggered",
          gate.id,
          r.message ?? `Logic gate "${gate.name}" triggered; requirement satisfied`,
          gateSeverity(r),
        );
      }
    }
  }

  #reconcileProof(): void {
    for (const dep of this.#project.dependencies) {
      if (needsProof(this.#project, dep)) {
        if (this.#proofFlagged.has(dep.id)) continue;
        this.#proofFlagged.add(dep.id);
        this.#log("proof_required", dep.id, `Dependency "${dep.name}" is ${dep.state} but has no proof of work`, "warning");
      } else {
        this.#proofFlagged.delete(dep.id);
      }
    }
  }

  #reconcileComplexity(): void {
    const { exceeded, score, threshold } = this.checkComplexity();
    if (exceeded && !this.#complexityExceeded) observeComplexityExceeded(this.#observer, score, threshold);
    this.#complexityExceeded = exceeded;
  }
}
