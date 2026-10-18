import {
  DEPENDENCY_STATES,
  PROJECT_SUBJECT,
  TASK_STATES,
  type Dependency,
  type GateEvaluation,
  type LogicAction,
  type LogicCondition,
  type LogicGate,
  type Project,
  type Task,
  type ValidationResult,
} from "./types.js";
import { calculateComplexity } from "./complexity.js";

// --- Subject / property resolution ---

type Scalar = string | number | undefined;

type Subject =
  | { kind: "project"; project: Project }
  | { kind: "dependency"; dependency: Dependency }
  | { kind: "task"; task: Task };

type Resolved = { ok: true; value: Scalar } | { ok: false; reason: string };

function resolveSubject(subject: string, project: Project): Subject | undefined {
  if (subject === PROJECT_SUBJECT || subject === project.id) return { kind: "project", project };
  const dependency = project.dependencies.find((d) => d.id === subject);
  if (dependency) return { kind: "dependency", dependency };
  const task = project.tasks.find((t) => t.id === subject);
  if (task) return { kind: "task", task };
  return undefined;
}

const PROJECT_PROPERTIES: Record<string, (p: Project) => Scalar> = {
  state: (p) => p.state,
  name: (p) => p.name,
  dependencyCount: (p) => p.dependencies.length,
  taskCount: (p) => p.tasks.length,
  logicGateCount: (p) => p.logicGates.length,
  complexity: (p) => calculateComplexity(p),
  complexityThreshold: (p) => p.complexityThreshold,
  requireProofOfWork: (p) => String(p.requireProofOfWork),
};

const DEPENDENCY_PROPERTIES: Record<string, (d: Dependency) => Scalar> = {
  state: (d) => d.state,
  name: (d) => d.name,
  priority: (d) => d.priority,
  hasProof: (d) => (d.proofOfWork ? "true" : "false"),
  proofOfWork: (d) => d.proofOfWork,
};

const TASK_PROPERTIES: Record<string, (t: Task) => Scalar> = {
  state: (t) => t.state,
  name: (t) => t.name,
  reactionCount: (t) => t.reactions.length,
  incompleteReactionCount: (t) => t.reactions.filter((r) => r.state !== "complete").length,
};

function lookup<T>(table: Record<string, (x: T) => Scalar>, property: string, x: T, kind: string): Resolved {
  if (!Object.hasOwn(table, property)) {
    return {
      ok: false,
      reason: `unknown ${kind} property "${property}" (known: ${Object.keys(table).join(", ")})`,
    };
  }
  return { ok: true, value: table[property](x) };
}

function resolve(condition: LogicCondition, project: Project): Resolved {
  const subject = resolveSubject(condition.subject, project);
  if (!subject) return { ok: false, reason: `unknown subject "${condition.subject}"` };
  switch (subject.kind) {
    case "project":
      return lookup(PROJECT_PROPERTIES, condition.property, subject.project, "project");
    case "dependency":
      return lookup(DEPENDENCY_PROPERTIES, condition.property, subject.dependency, "dependency");
    case "task":
      return lookup(TASK_PROPERTIES, condition.property, subject.task, "task");
  }
}

type ConditionOutcome = { ok: true; matched: boolean } | { ok: false; reason: string };

function checkCondition(condition: LogicCondition, project: Project): ConditionOutcome {
  const r = resolve(condition, project);
  if (!r.ok) return r;
  const v = r.value;

  switch (condition.operator) {
    case "eq":
      return { ok: true, matched: v !== undefined && String(v) === condition.value };
    case "neq":
      return { ok: true, matched: v === undefined || String(v) !== condition.value };
    case "in":
    case "not_in": {
      if (!Array.isArray(condition.value)) {
        return { ok: false, reason: `"${condition.operator}" needs an array value` };
      }
      const hit = v !== undefined && condition.value.includes(String(v));
      return { ok: true, matched: condition.operator === "in" ? hit : !hit };
    }
    case "exists":
      return { ok: true, matched: v !== undefined && v !== "" };
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      if (typeof v !== "number") {
        return { ok: false, reason: `property "${condition.property}" is not numeric` };
      }
      if (typeof condition.value !== "number" || !Number.isFinite(condition.value)) {
        return { ok: false, reason: `"${condition.operator}" needs a finite number value` };
      }
      const n = condition.value;
      const matched =
        condition.operator === "gt" ? v > n
        : condition.operator === "gte" ? v >= n
        : condition.operator === "lt" ? v < n
        : v <= n;
      return { ok: true, matched };
    }
    default: {
      const op: unknown = (condition as { operator: unknown }).operator;
      return { ok: false, reason: `unknown operator ${JSON.stringify(op)}` };
    }
  }
}

// --- Public evaluation API ---

/** True when the condition holds. Unresolvable conditions (unknown subject/property, type mismatch) return false. */
export function evaluateCondition(condition: LogicCondition, project: Project): boolean {
  const outcome = checkCondition(condition, project);
  return outcome.ok && outcome.matched;
}

function actionText(gate: LogicGate): string {
  const a = gate.action;
  const target = a.type === "generate_task" ? (a.target ?? a.task.id) : a.target;
  return a.message ?? `Action: ${a.type} on ${target}`;
}

function gateMessage(gate: LogicGate, text: string): string {
  return `Logic gate "${gate.name}": ${text}`;
}

function isProjectTarget(target: string, project: Project): boolean {
  return target === PROJECT_SUBJECT || target === project.id;
}

/** Full evaluation of one gate, including what (if anything) it blocks. */
export function evaluateGateDetailed(gate: LogicGate, project: Project): GateEvaluation {
  const base = { gateId: gate.id, gateName: gate.name, action: gate.action };
  if (!gate.enabled) return { ...base, status: "idle", blocksProject: false };

  const outcome = checkCondition(gate.condition, project);
  if (!outcome.ok) {
    // Fail closed: a misconfigured gate must never silently stop guarding.
    return {
      ...base,
      status: "invalid",
      message: gateMessage(gate, `misconfigured condition: ${outcome.reason}`),
      blocksProject: true,
    };
  }
  if (!outcome.matched) return { ...base, status: "idle", blocksProject: false };

  const action: LogicAction = gate.action;
  switch (action.type) {
    case "block": {
      if (isProjectTarget(action.target, project)) {
        return { ...base, status: "triggered", message: gateMessage(gate, actionText(gate)), blocksProject: true };
      }
      if (project.tasks.some((t) => t.id === action.target)) {
        return {
          ...base,
          status: "triggered",
          message: gateMessage(gate, actionText(gate)),
          blocksProject: false,
          blocksTask: action.target,
        };
      }
      return {
        ...base,
        status: "invalid",
        message: gateMessage(gate, `block target "${action.target}" is neither the project nor a task`),
        blocksProject: true,
      };
    }
    case "require_state": {
      const dep = project.dependencies.find((d) => d.id === action.target);
      const task = dep ? undefined : project.tasks.find((t) => t.id === action.target);
      const allowed: readonly string[] = dep ? DEPENDENCY_STATES : TASK_STATES;
      if (!dep && !task) {
        return {
          ...base,
          status: "invalid",
          message: gateMessage(gate, `require_state target "${action.target}" is not a dependency or task`),
          blocksProject: true,
        };
      }
      if (!allowed.includes(action.state)) {
        return {
          ...base,
          status: "invalid",
          message: gateMessage(gate, `state "${action.state}" is not valid for ${dep ? "dependency" : "task"} "${action.target}"`),
          blocksProject: true,
        };
      }
      const current = (dep ?? task)!.state;
      if (current === action.state) {
        return { ...base, status: "triggered", blocksProject: false };
      }
      return {
        ...base,
        status: "triggered",
        message: gateMessage(
          gate,
          action.message ?? `"${action.target}" must be ${action.state} (is ${current})`,
        ),
        blocksProject: true,
      };
    }
    case "warn":
    case "notify":
    case "generate_task":
      return { ...base, status: "triggered", message: gateMessage(gate, actionText(gate)), blocksProject: false };
  }
}

/** Backwards-compatible single-gate evaluation. */
export function evaluateGate(
  gate: LogicGate,
  project: Project,
): { triggered: boolean; action: LogicGate["action"] } {
  const r = evaluateGateDetailed(gate, project);
  return { triggered: r.status === "triggered", action: gate.action };
}

export function evaluateAllGates(project: Project): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const results: GateEvaluation[] = [];

  for (const gate of project.logicGates) {
    if (!gate.enabled) continue;
    const r = evaluateGateDetailed(gate, project);
    results.push(r);
    if (!r.message) continue;
    if (r.blocksProject) errors.push(r.message);
    else if (r.blocksTask) warnings.push(`${r.message} (blocks completion of task "${r.blocksTask}")`);
    else warnings.push(r.message);
  }

  return { valid: errors.length === 0, errors, warnings, results };
}

/** Messages of triggered gates that block completing the given task. */
export function getTaskBlockers(project: Project, taskId: string): string[] {
  return evaluateAllGates(project)
    .results.filter((r) => r.blocksTask === taskId && r.message)
    .map((r) => r.message!);
}

export interface GeneratedTasksResult {
  project: Project;
  generated: { gateId: string; task: Task }[];
  skipped: { gateId: string; taskId: string; reason: string }[];
}

/**
 * Applies `generate_task` actions until nothing changes. Each generated task is
 * created once (pending, no reactions) and never removed. Generation can
 * re-trigger other gates (e.g. on taskCount), so this runs to a fixpoint; it
 * terminates because each gate can add at most one task.
 */
export function applyGeneratedTasks(project: Project): GeneratedTasksResult {
  const generated: GeneratedTasksResult["generated"] = [];
  const skipped: GeneratedTasksResult["skipped"] = [];
  if (project.state === "deployed") return { project, generated, skipped };

  const handled = new Set<string>();
  let current = project;
  for (let pass = 0; pass <= project.logicGates.length; pass++) {
    let changed = false;
    for (const gate of current.logicGates) {
      if (handled.has(gate.id) || gate.action.type !== "generate_task") continue;
      if (evaluateGateDetailed(gate, current).status !== "triggered") continue;
      handled.add(gate.id);
      const spec = gate.action.task;
      if (current.tasks.some((t) => t.id === spec.id)) continue;
      if (
        current.dependencies.some((d) => d.id === spec.id) ||
        spec.id === PROJECT_SUBJECT ||
        spec.id === current.id
      ) {
        skipped.push({ gateId: gate.id, taskId: spec.id, reason: "id is taken by a dependency or the project" });
        continue;
      }
      const task: Task = {
        id: spec.id,
        name: spec.name,
        ...(spec.description !== undefined ? { description: spec.description } : {}),
        state: "pending",
        reactions: [],
      };
      current = { ...current, tasks: [...current.tasks, task] };
      generated.push({ gateId: gate.id, task });
      changed = true;
    }
    if (!changed) break;
  }
  return { project: current, generated, skipped };
}
