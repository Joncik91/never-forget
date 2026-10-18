import {
  DONE_DEPENDENCY_STATES,
  PROJECT_SUBJECT,
  TASK_STATES,
  UNREADY_DEPENDENCY_STATES,
  type CheckResult,
  type Dependency,
  type DependencyState,
  type FlightCheckResult,
  type GateResult,
  type LogicGate,
  type Project,
  type ProjectConfig,
  type ProjectState,
  type Reaction,
  type ReactionSelector,
  type Task,
  type TaskState,
} from "./types.js";
import {
  DuplicateIdError,
  GateBlockedError,
  InvalidStateTransitionError,
  NotFoundError,
  ProjectLockedError,
  ValidationError,
} from "./errors.js";
import {
  assertValidConfigShape,
  assertValidDependency,
  assertValidLogicGate,
  assertValidTask,
  dependencyIssues,
} from "./validate.js";

// Pure, immutable core. Every function returns a new Project and never mutates
// its input. Inputs are deep-copied so later caller mutations cannot leak in.

const VALID_TRANSITIONS: Readonly<Record<ProjectState, readonly ProjectState[]>> = {
  defined: ["gated"],
  gated: ["building"],
  building: ["review"],
  review: ["complete", "building"],
  complete: ["deployed", "review"],
  deployed: [],
};

export function canTransition(from: ProjectState, to: ProjectState): boolean {
  return VALID_TRANSITIONS[from].includes(to);
}

export function assertCanTransition(project: Project, to: ProjectState): void {
  if (!canTransition(project.state, to)) {
    const allowed = VALID_TRANSITIONS[project.state];
    throw new InvalidStateTransitionError(
      project.state,
      to,
      allowed.length > 0
        ? `Valid transitions from ${project.state}: ${allowed.join(", ")}`
        : `${project.state} is a terminal state`,
    );
  }
}

function now(): string {
  return new Date().toISOString();
}

function touch(project: Project): Project {
  return { ...project, updatedAt: now() };
}

function assertMutable(project: Project): void {
  if (project.state === "deployed") throw new ProjectLockedError(project.id);
}

/** Dependencies and tasks share one id namespace so logic-gate subjects are unambiguous. */
function assertEntityIdFree(project: Project, kind: string, id: string): void {
  if (id === PROJECT_SUBJECT || id === project.id) {
    throw new DuplicateIdError(kind, id, "clashes with the project subject");
  }
  if (project.dependencies.some((d) => d.id === id)) {
    throw new DuplicateIdError(kind, id, kind === "Dependency" ? "already exists" : "is already used by a dependency");
  }
  if (project.tasks.some((t) => t.id === id)) {
    throw new DuplicateIdError(kind, id, kind === "Task" ? "already exists" : "is already used by a task");
  }
}

function dependencyIdSet(project: Project): Set<string> {
  return new Set(project.dependencies.map((d) => d.id));
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

// --- Construction ---

export function createProject(config: ProjectConfig): Project {
  assertValidConfigShape(config);
  const timestamp = now();
  let project: Project = {
    id: config.id,
    name: config.name,
    description: config.description ?? "",
    state: "defined",
    dependencies: [],
    logicGates: [],
    tasks: [],
    complexityThreshold: config.complexityThreshold ?? 10,
    requireProofOfWork: config.requireProofOfWork ?? false,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  // Route collections through the same validated insert path as later edits.
  for (const dep of config.dependencies ?? []) project = addDependency(project, dep);
  for (const task of config.tasks ?? []) project = addTask(project, task);
  for (const gate of config.logicGates ?? []) project = addLogicGate(project, gate);
  return { ...project, updatedAt: timestamp };
}

// --- Dependencies ---

export function addDependency(project: Project, dependency: Dependency): Project {
  assertMutable(project);
  assertValidDependency(dependency);
  assertEntityIdFree(project, "Dependency", dependency.id);
  return touch({ ...project, dependencies: [...project.dependencies, clone(dependency)] });
}

export function updateDependencyState(
  project: Project,
  dependencyId: string,
  newState: DependencyState,
  proofOfWork?: string,
): Project {
  assertMutable(project);
  const index = project.dependencies.findIndex((d) => d.id === dependencyId);
  if (index === -1) throw new NotFoundError("Dependency", dependencyId);
  const next: Dependency = {
    ...project.dependencies[index],
    state: newState,
    ...(proofOfWork !== undefined ? { proofOfWork } : {}),
  };
  const issues = dependencyIssues(next);
  if (issues.length > 0) throw new ValidationError("dependency update", issues);
  const dependencies = project.dependencies.slice();
  dependencies[index] = next;
  return touch({ ...project, dependencies });
}

// --- Tasks & reactions ---

export function addTask(project: Project, task: Task): Project {
  assertMutable(project);
  assertValidTask(task, dependencyIdSet(project));
  assertEntityIdFree(project, "Task", task.id);
  return touch({ ...project, tasks: [...project.tasks, clone(task)] });
}

function assertTaskState(state: unknown, what: string): asserts state is TaskState {
  if (typeof state !== "string" || !(TASK_STATES as readonly string[]).includes(state)) {
    throw new ValidationError(what, [`state must be one of ${TASK_STATES.join(", ")} (got ${JSON.stringify(state)})`]);
  }
}

export function updateTaskState(project: Project, taskId: string, newState: TaskState): Project {
  assertMutable(project);
  assertTaskState(newState, "task update");
  const index = project.tasks.findIndex((t) => t.id === taskId);
  if (index === -1) throw new NotFoundError("Task", taskId);
  const tasks = project.tasks.slice();
  tasks[index] = { ...tasks[index], state: newState };
  return touch({ ...project, tasks });
}

function selectReactions(task: Task, selector: ReactionSelector): Reaction[] {
  if ("reactionId" in selector) {
    const r = task.reactions.find((x) => x.id === selector.reactionId);
    if (!r) throw new NotFoundError(`Reaction on task ${task.id}`, selector.reactionId);
    return [r];
  }
  const matches = task.reactions.filter((x) => x.dependencyId === selector.dependencyId);
  if (matches.length === 0) {
    throw new NotFoundError(`Reaction for dependency on task ${task.id}`, selector.dependencyId);
  }
  return matches;
}

/** Updates one reaction (by id) or every reaction of a task for one dependency. */
export function updateReactionState(
  project: Project,
  taskId: string,
  selector: ReactionSelector,
  newState: TaskState,
  proofOfWork?: string,
): Project {
  assertMutable(project);
  assertTaskState(newState, "reaction update");
  if (proofOfWork !== undefined && (typeof proofOfWork !== "string" || proofOfWork.trim() === "")) {
    throw new ValidationError("reaction update", ["proofOfWork must be a non-empty string when set"]);
  }
  const index = project.tasks.findIndex((t) => t.id === taskId);
  if (index === -1) throw new NotFoundError("Task", taskId);
  const task = project.tasks[index];
  const targets = new Set(selectReactions(task, selector).map((r) => r.id));
  const reactions = task.reactions.map((r) =>
    targets.has(r.id)
      ? { ...r, state: newState, ...(proofOfWork !== undefined ? { proofOfWork } : {}) }
      : r,
  );
  const tasks = project.tasks.slice();
  tasks[index] = { ...task, reactions };
  return touch({ ...project, tasks });
}

// --- Logic gates ---

export function addLogicGate(project: Project, gate: LogicGate): Project {
  assertMutable(project);
  assertValidLogicGate(gate);
  if (project.logicGates.some((g) => g.id === gate.id)) {
    throw new DuplicateIdError("Logic gate", gate.id);
  }
  return touch({ ...project, logicGates: [...project.logicGates, clone(gate)] });
}

export function setLogicGateEnabled(project: Project, gateId: string, enabled: boolean): Project {
  assertMutable(project);
  if (typeof enabled !== "boolean") {
    throw new ValidationError("logic gate update", ["enabled must be a boolean"]);
  }
  const index = project.logicGates.findIndex((g) => g.id === gateId);
  if (index === -1) throw new NotFoundError("Logic gate", gateId);
  const logicGates = project.logicGates.slice();
  logicGates[index] = { ...logicGates[index], enabled };
  return touch({ ...project, logicGates });
}

// --- State machine ---

export function transitionState(project: Project, newState: ProjectState): Project {
  assertCanTransition(project, newState);
  return touch({ ...project, state: newState });
}

// --- Tier 1: Entry Gate (Binary Lock) ---

export function evaluateEntryGate(project: Project): GateResult {
  const blockers: string[] = [];
  const messages: string[] = [];

  if (project.dependencies.length === 0) {
    blockers.push("No dependencies defined — at least one required dependency must exist");
    messages.push("FAIL: No dependencies defined");
  } else if (!project.dependencies.some((d) => d.priority === "required")) {
    blockers.push("No required dependencies defined — mark at least one dependency as required");
    messages.push("FAIL: No required dependencies defined");
  }

  for (const dep of project.dependencies) {
    if (dep.priority !== "required") continue;
    if (UNREADY_DEPENDENCY_STATES.includes(dep.state)) {
      blockers.push(`Required dependency "${dep.name}" (${dep.id}) is not ready (state: ${dep.state})`);
      messages.push(`FAIL: ${dep.name} not ready`);
    }
    if (project.requireProofOfWork && !dep.proofOfWork) {
      blockers.push(`Required dependency "${dep.name}" (${dep.id}) has no proof of work`);
      messages.push(`FAIL: ${dep.name} missing proof of work`);
    }
  }

  const passed = blockers.length === 0;
  return {
    passed,
    blocked: !passed,
    messages: passed ? ["All entry gate checks passed"] : messages,
    blockers,
  };
}

export function passEntryGate(project: Project): Project {
  assertCanTransition(project, "gated");
  const result = evaluateEntryGate(project);
  if (result.blocked) throw new GateBlockedError(result.blockers, "entry");
  return transitionState(project, "gated");
}

// --- Pre-flight & Post-flight checks ---

function summarize(result: CheckResult[]): FlightCheckResult {
  return {
    allPassed: result.every((c) => c.passed || c.blocking === false),
    checks: result,
  };
}

export function runPreFlightChecks(project: Project): FlightCheckResult {
  const checks: CheckResult[] = [];
  const requiredDeps = project.dependencies.filter((d) => d.priority === "required");

  checks.push({
    id: "required-dependencies-defined",
    blocking: true,
    passed: requiredDeps.length > 0,
    message:
      requiredDeps.length > 0
        ? `${requiredDeps.length} required dependencies defined`
        : "No required dependencies defined",
  });

  const unidentified = requiredDeps.filter((d) => d.state === "undefined");
  checks.push({
    id: "required-dependencies-identified",
    blocking: true,
    passed: unidentified.length === 0,
    message:
      unidentified.length === 0
        ? "All required dependencies identified"
        : `Unidentified dependencies: ${unidentified.map((d) => d.name).join(", ")}`,
  });

  checks.push({
    id: "logic-gates-configured",
    blocking: false,
    passed: project.logicGates.length > 0,
    message:
      project.logicGates.length > 0
        ? `${project.logicGates.length} logic gates configured`
        : "No logic gates configured — consider adding conditional rules",
  });

  return summarize(checks);
}

/** Every (task, required dependency) pair without a completed reaction. */
export function findMissingReactions(
  project: Project,
): { task: Task; dependency: Dependency }[] {
  const required = project.dependencies.filter((d) => d.priority === "required");
  const missing: { task: Task; dependency: Dependency }[] = [];
  for (const task of project.tasks) {
    for (const dependency of required) {
      const covered = task.reactions.some(
        (r) => r.dependencyId === dependency.id && r.state === "complete",
      );
      if (!covered) missing.push({ task, dependency });
    }
  }
  return missing;
}

export function runPostFlightChecks(project: Project): FlightCheckResult {
  const checks: CheckResult[] = [];
  const requiredDeps = project.dependencies.filter((d) => d.priority === "required");
  const requiredIds = new Set(requiredDeps.map((d) => d.id));

  const unverified = requiredDeps.filter((d) => !DONE_DEPENDENCY_STATES.includes(d.state));
  checks.push({
    id: "required-dependencies-done",
    blocking: true,
    passed: unverified.length === 0,
    message:
      unverified.length === 0
        ? "All required dependencies verified/complete"
        : `Unverified: ${unverified.map((d) => d.name).join(", ")}`,
  });

  const incompleteTasks = project.tasks.filter((t) => t.state !== "complete");
  checks.push({
    id: "tasks-complete",
    blocking: true,
    passed: incompleteTasks.length === 0,
    message:
      incompleteTasks.length === 0
        ? "All tasks complete"
        : `${incompleteTasks.length} incomplete tasks remain`,
    ...(incompleteTasks.length > 0
      ? { details: incompleteTasks.map((t) => `${t.name} (${t.state})`).join(", ") }
      : {}),
  });

  // The core invariant: no task ships without addressing every required dependency.
  const missing = findMissingReactions(project);
  checks.push({
    id: "required-reactions-complete",
    blocking: true,
    passed: missing.length === 0,
    message:
      missing.length === 0
        ? "All reactions complete"
        : `${missing.length} incomplete reactions for required dependencies`,
    ...(missing.length > 0
      ? { details: missing.map((m) => `${m.task.name} → ${m.dependency.name}`).join(", ") }
      : {}),
  });

  const openOptional = project.tasks
    .flatMap((t) => t.reactions)
    .filter((r) => !requiredIds.has(r.dependencyId) && r.state !== "complete");
  checks.push({
    id: "non-required-reactions-complete",
    blocking: false,
    passed: openOptional.length === 0,
    message:
      openOptional.length === 0
        ? "All reactions for non-required dependencies complete"
        : `${openOptional.length} open reactions for non-required dependencies`,
  });

  if (project.requireProofOfWork) {
    const missingProof = requiredDeps.filter((d) => !d.proofOfWork);
    checks.push({
      id: "proof-of-work",
      blocking: true,
      passed: missingProof.length === 0,
      message:
        missingProof.length === 0
          ? "All proof of work provided"
          : `Missing proof: ${missingProof.map((d) => d.name).join(", ")}`,
    });
  }

  return summarize(checks);
}

/** True when a dependency claims to be done but proof is required and absent. */
export function needsProof(project: Project, dep: Dependency): boolean {
  return (
    project.requireProofOfWork &&
    dep.priority === "required" &&
    DONE_DEPENDENCY_STATES.includes(dep.state) &&
    !dep.proofOfWork
  );
}
