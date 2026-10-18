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
  createProject,
  evaluateEntryGate,
  findMissingReactions,
  needsProof,
  runPostFlightChecks,
  runPreFlightChecks,
  setLogicGateEnabled,
  updateDependencyState,
  updateReactionState,
  updateTaskState,
} from "./project.js";
import { advanceState, getExitBlockers, isExitTransition } from "./lifecycle.js";
import { applyGeneratedTasks, evaluateAllGates } from "./logic-gate.js";
import { generateShadowTasks } from "./shadow-task.js";
import { calculateComplexity } from "./complexity.js";
import { GateBlockedError, InvalidStateTransitionError, NeverForgetError } from "./errors.js";
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
// Every mutation runs a pure function that returns the next state or throws;
// only then is it committed. After each commit the engine reconciles derived
// state reactively — generated tasks, logic-gate edges, complexity and proof
// warnings — so consumers subscribe to events instead of polling.
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

function countReactions(p: Project): number {
  return p.tasks.reduce((n, t) => n + t.reactions.length, 0);
}

export class ContingencyEngine {
  #project: Project;
  readonly #observer: Observer;
  /** Last seen status per gate, for edge-triggered events. */
  readonly #gateState = new Map<string, string>();
  readonly #proofFlagged = new Set<string>();
  readonly #reportedSkips = new Set<string>();
  #complexityExceeded = false;
  #busy = false;

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

  /** Live event stream. Returns an unsubscribe function. Listeners must not mutate the engine synchronously. */
  subscribe(listener: ObserverListener): () => void {
    return this.#observer.subscribe(listener);
  }

  // --- Dependencies ---

  addDependency(dependency: Dependency): this {
    return this.#mutate(
      (p) => addDependency(p, dependency),
      (next) => {
        const d = next.dependencies[next.dependencies.length - 1];
        this.#log("dependency_added", d.id, `Dependency "${d.name}" added with priority ${d.priority}`);
      },
    );
  }

  updateDependencyState(dependencyId: string, newState: DependencyState, proofOfWork?: string): this {
    const before = this.#project.dependencies.find((d) => d.id === dependencyId)?.state;
    return this.#mutate(
      (p) => updateDependencyState(p, dependencyId, newState, proofOfWork),
      () =>
        this.#log(
          "dependency_updated",
          dependencyId,
          `Dependency state ${before} → ${newState}${proofOfWork !== undefined ? " (proof attached)" : ""}`,
        ),
    );
  }

  // --- Tasks ---

  /** A task added as complete faces the same task-blocking gates as completing it later. */
  addTask(task: Task): this {
    return this.#mutate(
      (p) => addTask(p, task),
      (next) => {
        const t = next.tasks[next.tasks.length - 1];
        this.#log("task_added", t.id, `Task "${t.name}" added (${t.state})`);
        if (t.state === "complete") this.#flagUnaddressed(t.id);
      },
    );
  }

  /** Completing a task is refused while a triggered `block` gate targets it. */
  updateTaskState(taskId: string, newState: TaskState): this {
    const before = this.#project.tasks.find((t) => t.id === taskId)?.state;
    return this.#mutate(
      (p) => updateTaskState(p, taskId, newState),
      () => {
        this.#log("task_updated", taskId, `Task state ${before} → ${newState}`);
        if (newState === "complete") this.#flagUnaddressed(taskId);
      },
    );
  }

  /** Update one reaction (`{ reactionId }`) or all of a task's reactions for a dependency (`{ dependencyId }`). */
  updateReactionState(
    taskId: string,
    selector: ReactionSelector,
    newState: TaskState,
    proofOfWork?: string,
  ): this {
    return this.#mutate(
      (p) => updateReactionState(p, taskId, selector, newState, proofOfWork),
      () => {
        const which =
          "reactionId" in selector ? `reaction ${selector.reactionId}` : `reactions for ${selector.dependencyId}`;
        this.#log("reaction_updated", taskId, `Task "${taskId}" ${which} → ${newState}`);
      },
    );
  }

  // --- Logic Gates ---

  addLogicGate(gate: LogicGate): this {
    return this.#mutate(
      (p) => addLogicGate(p, gate),
      (next) => {
        const g = next.logicGates[next.logicGates.length - 1];
        this.#log("logic_gate_added", g.id, `Logic gate "${g.name}" added`);
      },
    );
  }

  setLogicGateEnabled(gateId: string, enabled: boolean): this {
    return this.#mutate(
      (p) => setLogicGateEnabled(p, gateId, enabled),
      () => this.#log("logic_gate_updated", gateId, `Logic gate ${enabled ? "enabled" : "disabled"}`),
    );
  }

  // --- Shadow Tasks ---

  generateShadowTasks(): this {
    const before = countReactions(this.#project);
    return this.#mutate(
      (p) => generateShadowTasks(p),
      (next) =>
        this.#log("shadow_task_generated", "project", `${countReactions(next) - before} shadow reaction(s) generated`),
    );
  }

  // --- Gate Evaluation ---

  evaluateEntryGate(): GateResult {
    return evaluateEntryGate(this.#project);
  }

  passEntryGate(): this {
    return this.#transition("defined", "gated");
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

  /**
   * What would stop the project leaving the build in its current state. Exit
   * transitions re-run this on the resulting state, so gates keyed on the
   * target state (e.g. `project.state eq "review"`) are enforced too.
   */
  checkExitCriteria(): ExitCriteria {
    const blockers = getExitBlockers(this.#project);
    return { passed: blockers.length === 0, blockers };
  }

  // --- State Transitions ---

  startBuilding(): this {
    return this.#transition("gated", "building");
  }

  /** building → review. Requires exit criteria. */
  submitForReview(): this {
    return this.#transition("building", "review");
  }

  /** review → building, for rework after review. */
  requestChanges(): this {
    return this.#transition("review", "building");
  }

  /** review → complete. Re-checks exit criteria; state may have changed during review. */
  markComplete(): this {
    return this.#transition("review", "complete");
  }

  /** complete → review. */
  reopen(): this {
    return this.#transition("complete", "review");
  }

  /** complete → deployed (terminal, immutable). Re-checks exit criteria. */
  deploy(): this {
    return this.#transition("complete", "deployed");
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

  /** Each named transition is bound to one source state, so e.g. submitForReview() can never act as reopen(). */
  #transition(from: ProjectState, to: ProjectState): this {
    if (this.#project.state !== from) {
      throw new InvalidStateTransitionError(this.#project.state, to, `this operation requires state ${from}`);
    }
    const gate = to === "gated" ? "entry" : isExitTransition(from, to) ? "exit" : undefined;
    return this.#mutate(
      (p) => advanceState(p, to),
      () => {
        if (gate) observeGatePassed(this.#observer, gate);
        observeStateTransition(this.#observer, from, to);
      },
    );
  }

  /**
   * Runs a pure update and commits it. A refused update logs its blockers as
   * `gate_blocked` audit events, then rethrows; project state is untouched.
   * An update that changes nothing is neither committed nor logged.
   */
  #mutate(update: (p: Project) => Project, logAction: (next: Project) => void): this {
    if (this.#busy) {
      throw new NeverForgetError("Re-entrant engine update: listeners must not mutate the engine synchronously");
    }
    this.#busy = true;
    try {
      let next: Project;
      try {
        next = update(this.#project);
      } catch (err) {
        if (err instanceof GateBlockedError) {
          for (const b of err.blockers) observeGateBlocked(this.#observer, err.gate, b);
        }
        throw err;
      }
      if (next !== this.#project) this.#apply(next, logAction);
      return this;
    } finally {
      this.#busy = false;
    }
  }

  /** Real-time "action without reaction" detection when a task completes. */
  #flagUnaddressed(taskId: string): void {
    for (const m of findMissingReactions(this.#project)) {
      if (m.task.id === taskId) observeActionWithoutReaction(this.#observer, m.task.name, m.dependency.name);
    }
  }

  /** Commits a new state, logs the triggering action, then reconciles derived state. */
  #apply(next: Project, logAction?: (next: Project) => void): void {
    const { project, generated, skipped } = applyGeneratedTasks(next);
    this.#project = deepFreeze(project);
    logAction?.(this.#project);

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
