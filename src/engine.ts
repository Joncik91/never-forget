import type {
  Project,
  ProjectConfig,
  ValidationResult,
  GateResult,
  FlightCheckResult,
  ObserverEvent,
  Dependency,
  DependencyState,
  Task,
  LogicGate,
} from "./types.js";
import { createProject, evaluateEntryGate, passEntryGate, runPreFlightChecks, runPostFlightChecks, transitionState } from "./project.js";
import { evaluateAllGates } from "./logic-gate.js";
import { generateShadowTasks } from "./shadow-task.js";
import {
  createObserver,
  scanForMissedReactions,
  observeStateTransition,
  observeGatePassed,
  observeGateBlocked,
  observeComplexityExceeded,
  type Observer,
} from "./observer.js";

// ============================================================================
// ContingencyEngine — The main orchestrator
// ============================================================================

export class ContingencyEngine {
  private project: Project;
  private observer: Observer;

  constructor(config: ProjectConfig) {
    this.project = createProject(config);
    this.observer = createObserver();
  }

  // --- Read-only access ---

  getProject(): Readonly<Project> {
    return this.project;
  }

  getEvents(): ObserverEvent[] {
    return this.observer.getEvents();
  }

  getErrors(): ObserverEvent[] {
    return this.observer.getEventsBySeverity("error");
  }

  getWarnings(): ObserverEvent[] {
    return this.observer.getEventsBySeverity("warning");
  }

  // --- Dependencies ---

  addDependency(dependency: Dependency): this {
    const existing = this.project.dependencies.find((d) => d.id === dependency.id);
    if (existing) {
      throw new Error(`Dependency ${dependency.id} already exists`);
    }
    this.project = {
      ...this.project,
      dependencies: [...this.project.dependencies, dependency],
      updatedAt: new Date().toISOString(),
    };
    this.observer.log({
      type: "dependency_added",
      subject: dependency.id,
      details: `Dependency "${dependency.name}" added with priority ${dependency.priority}`,
      severity: "info",
    });
    return this;
  }

  updateDependencyState(
    dependencyId: string,
    newState: DependencyState,
    proofOfWork?: string,
  ): this {
    const deps = this.project.dependencies.map((d) =>
      d.id === dependencyId
        ? { ...d, state: newState, proofOfWork: proofOfWork ?? d.proofOfWork }
        : d,
    );
    if (deps.every((d) => d.id !== dependencyId)) {
      throw new Error(`Dependency ${dependencyId} not found`);
    }
    this.project = { ...this.project, dependencies: deps, updatedAt: new Date().toISOString() };
    return this;
  }

  // --- Tasks ---

  addTask(task: Task): this {
    this.project = {
      ...this.project,
      tasks: [...this.project.tasks, task],
      updatedAt: new Date().toISOString(),
    };
    return this;
  }

  updateTaskState(taskId: string, newState: Task["state"]): this {
    const tasks = this.project.tasks.map((t) =>
      t.id === taskId ? { ...t, state: newState } : t,
    );
    if (tasks.every((t) => t.id !== taskId)) {
      throw new Error(`Task ${taskId} not found`);
    }
    this.project = { ...this.project, tasks, updatedAt: new Date().toISOString() };
    return this;
  }

  // --- Logic Gates ---

  addLogicGate(gate: LogicGate): this {
    this.project = {
      ...this.project,
      logicGates: [...this.project.logicGates, gate],
      updatedAt: new Date().toISOString(),
    };
    return this;
  }

  // --- Shadow Tasks ---

  generateShadowTasks(): this {
    this.project = generateShadowTasks(this.project);
    this.observer.log({
      type: "shadow_task_generated",
      subject: "project",
      details: "Shadow tasks generated for all dependencies",
      severity: "info",
    });
    return this;
  }

  // --- Gate Evaluation ---

  evaluateEntryGate(): GateResult {
    return evaluateEntryGate(this.project);
  }

  passEntryGate(): this {
    const result = evaluateEntryGate(this.project);
    if (result.blocked) {
      for (const msg of result.messages) {
        observeGateBlocked(this.observer, "entry", msg);
      }
      throw new Error(`Entry gate blocked: ${result.messages.join("; ")}`);
    }
    observeGatePassed(this.observer, "entry");
    this.project = passEntryGate(this.project);
    observeStateTransition(this.observer, "defined", "gated");
    return this;
  }

  evaluateLogicGates(): ValidationResult {
    return evaluateAllGates(this.project);
  }

  // --- Flight Checks ---

  runPreFlightChecks(): FlightCheckResult {
    return runPreFlightChecks(this.project);
  }

  runPostFlightChecks(): FlightCheckResult {
    return runPostFlightChecks(this.project);
  }

  // --- State Transitions ---

  startBuilding(): this {
    this.project = transitionState(this.project, "building");
    observeStateTransition(this.observer, "gated", "building");
    return this;
  }

  submitForReview(): this {
    const postFlight = runPostFlightChecks(this.project);
    if (!postFlight.allPassed) {
      const failed = postFlight.checks
        .filter((c) => !c.passed)
        .map((c) => c.message);
      throw new Error(`Post-flight checks failed: ${failed.join("; ")}`);
    }
    this.project = transitionState(this.project, "review");
    observeStateTransition(this.observer, "building", "review");
    return this;
  }

  markComplete(): this {
    this.project = transitionState(this.project, "complete");
    observeStateTransition(this.observer, "review", "complete");
    return this;
  }

  deploy(): this {
    this.project = transitionState(this.project, "deployed");
    observeStateTransition(this.observer, "complete", "deployed");
    return this;
  }

  // --- Complexity Check ---

  checkComplexity(): { exceeded: boolean; score: number; threshold: number } {
    const score = this.calculateComplexity();
    const threshold = this.project.complexityThreshold;
    const exceeded = score > threshold;
    if (exceeded) {
      observeComplexityExceeded(this.observer, score, threshold);
    }
    return { exceeded, score, threshold };
  }

  // --- Observer Scans ---

  scanForMissedReactions(): number {
    return scanForMissedReactions(this.project, this.observer);
  }

  // --- Internal ---

  private calculateComplexity(): number {
    return (
      this.project.dependencies.length * 2 +
      this.project.tasks.length +
      this.project.tasks.reduce((sum, t) => sum + t.reactions.length, 0) +
      this.project.logicGates.length
    );
  }
}
