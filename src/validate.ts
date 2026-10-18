import {
  DEPENDENCY_PRIORITIES,
  DEPENDENCY_STATES,
  LOGIC_ACTION_TYPES,
  LOGIC_OPERATORS,
  TASK_STATES,
  type Dependency,
  type LogicGate,
  type ProjectConfig,
  type Reaction,
  type Task,
} from "./types.js";
import { ValidationError } from "./errors.js";

// Runtime validation for everything that crosses the public API boundary.
// TypeScript types vanish at runtime; JSON configs and JS callers do not.

type Issues = string[];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function checkId(obj: Record<string, unknown>, path: string, issues: Issues): void {
  if (!isNonEmptyString(obj.id)) issues.push(`${path}.id must be a non-empty string`);
}

function checkName(obj: Record<string, unknown>, path: string, issues: Issues): void {
  if (!isNonEmptyString(obj.name)) issues.push(`${path}.name must be a non-empty string`);
}

function checkOptionalString(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  issues: Issues,
  nonEmpty = false,
): void {
  const v = obj[key];
  if (v === undefined) return;
  if (typeof v !== "string" || (nonEmpty && v.trim().length === 0)) {
    issues.push(`${path}.${key} must be a ${nonEmpty ? "non-empty " : ""}string when set`);
  }
}

function checkEnum(
  value: unknown,
  allowed: readonly string[],
  label: string,
  issues: Issues,
): void {
  if (typeof value !== "string" || !allowed.includes(value)) {
    issues.push(`${label} must be one of ${allowed.join(", ")} (got ${JSON.stringify(value)})`);
  }
}

function fail(what: string, issues: Issues): void {
  if (issues.length > 0) throw new ValidationError(what, issues);
}

export function dependencyIssues(dep: unknown, path = "dependency"): Issues {
  const issues: Issues = [];
  if (!isRecord(dep)) return [`${path} must be an object`];
  checkId(dep, path, issues);
  checkName(dep, path, issues);
  checkEnum(dep.priority, DEPENDENCY_PRIORITIES, `${path}.priority`, issues);
  checkEnum(dep.state, DEPENDENCY_STATES, `${path}.state`, issues);
  checkOptionalString(dep, "proofOfWork", path, issues, true);
  checkOptionalString(dep, "description", path, issues);
  return issues;
}

export function reactionIssues(
  reaction: unknown,
  path: string,
  dependencyIds: ReadonlySet<string>,
): Issues {
  const issues: Issues = [];
  if (!isRecord(reaction)) return [`${path} must be an object`];
  checkId(reaction, path, issues);
  if (!isNonEmptyString(reaction.dependencyId)) {
    issues.push(`${path}.dependencyId must be a non-empty string`);
  } else if (!dependencyIds.has(reaction.dependencyId)) {
    issues.push(`${path}.dependencyId references unknown dependency "${reaction.dependencyId}"`);
  }
  if (typeof reaction.description !== "string") {
    issues.push(`${path}.description must be a string`);
  }
  checkEnum(reaction.state, TASK_STATES, `${path}.state`, issues);
  checkOptionalString(reaction, "proofOfWork", path, issues, true);
  return issues;
}

export function taskIssues(
  task: unknown,
  dependencyIds: ReadonlySet<string>,
  path = "task",
): Issues {
  const issues: Issues = [];
  if (!isRecord(task)) return [`${path} must be an object`];
  checkId(task, path, issues);
  checkName(task, path, issues);
  checkEnum(task.state, TASK_STATES, `${path}.state`, issues);
  checkOptionalString(task, "description", path, issues);
  if (!Array.isArray(task.reactions)) {
    issues.push(`${path}.reactions must be an array`);
    return issues;
  }
  const seen = new Set<string>();
  task.reactions.forEach((r: unknown, i: number) => {
    const rPath = `${path}.reactions[${i}]`;
    issues.push(...reactionIssues(r, rPath, dependencyIds));
    if (isRecord(r) && typeof r.id === "string") {
      if (seen.has(r.id)) issues.push(`${rPath}.id "${r.id}" is duplicated within the task`);
      seen.add(r.id);
    }
  });
  return issues;
}

export function logicGateIssues(gate: unknown, path = "logicGate"): Issues {
  const issues: Issues = [];
  if (!isRecord(gate)) return [`${path} must be an object`];
  checkId(gate, path, issues);
  checkName(gate, path, issues);
  if (typeof gate.enabled !== "boolean") issues.push(`${path}.enabled must be a boolean`);

  const c = gate.condition;
  if (!isRecord(c)) {
    issues.push(`${path}.condition must be an object`);
  } else {
    if (!isNonEmptyString(c.subject)) issues.push(`${path}.condition.subject must be a non-empty string`);
    if (!isNonEmptyString(c.property)) issues.push(`${path}.condition.property must be a non-empty string`);
    checkEnum(c.operator, LOGIC_OPERATORS, `${path}.condition.operator`, issues);
    switch (c.operator) {
      case "eq":
      case "neq":
        if (typeof c.value !== "string") {
          issues.push(`${path}.condition.value must be a string for "${c.operator}"`);
        }
        break;
      case "in":
      case "not_in":
        if (!Array.isArray(c.value) || !c.value.every((v) => typeof v === "string")) {
          issues.push(`${path}.condition.value must be a string array for "${c.operator}"`);
        }
        break;
      case "gt":
      case "gte":
      case "lt":
      case "lte":
        if (typeof c.value !== "number" || !Number.isFinite(c.value)) {
          issues.push(`${path}.condition.value must be a finite number for "${c.operator}"`);
        }
        break;
    }
  }

  const a = gate.action;
  if (!isRecord(a)) {
    issues.push(`${path}.action must be an object`);
  } else {
    checkEnum(a.type, LOGIC_ACTION_TYPES, `${path}.action.type`, issues);
    checkOptionalString(a, "message", `${path}.action`, issues);
    if (a.type === "generate_task") {
      const t = a.task;
      if (!isRecord(t)) {
        issues.push(`${path}.action.task must be an object`);
      } else {
        checkId(t, `${path}.action.task`, issues);
        checkName(t, `${path}.action.task`, issues);
        checkOptionalString(t, "description", `${path}.action.task`, issues);
      }
      checkOptionalString(a, "target", `${path}.action`, issues);
    } else if (!isNonEmptyString(a.target)) {
      issues.push(`${path}.action.target must be a non-empty string`);
    }
    if (a.type === "require_state") {
      checkEnum(
        a.state,
        [...new Set<string>([...DEPENDENCY_STATES, ...TASK_STATES])],
        `${path}.action.state`,
        issues,
      );
    }
  }
  return issues;
}

export function assertValidDependency(dep: unknown): asserts dep is Dependency {
  fail("dependency", dependencyIssues(dep));
}

export function assertValidTask(
  task: unknown,
  dependencyIds: ReadonlySet<string>,
): asserts task is Task {
  fail("task", taskIssues(task, dependencyIds));
}

export function assertValidReaction(
  reaction: unknown,
  dependencyIds: ReadonlySet<string>,
): asserts reaction is Reaction {
  fail("reaction", reactionIssues(reaction, "reaction", dependencyIds));
}

export function assertValidLogicGate(gate: unknown): asserts gate is LogicGate {
  fail("logic gate", logicGateIssues(gate));
}

/** Validates scalar config fields. Collections are validated entity by entity on insert. */
export function assertValidConfigShape(config: unknown): asserts config is ProjectConfig {
  const issues: Issues = [];
  if (!isRecord(config)) throw new ValidationError("project config", ["config must be an object"]);
  checkId(config, "config", issues);
  checkName(config, "config", issues);
  checkOptionalString(config, "description", "config", issues);
  if (
    config.complexityThreshold !== undefined &&
    (typeof config.complexityThreshold !== "number" ||
      !Number.isFinite(config.complexityThreshold) ||
      config.complexityThreshold < 0)
  ) {
    issues.push("config.complexityThreshold must be a finite number >= 0");
  }
  if (config.requireProofOfWork !== undefined && typeof config.requireProofOfWork !== "boolean") {
    issues.push("config.requireProofOfWork must be a boolean");
  }
  for (const key of ["dependencies", "logicGates", "tasks"] as const) {
    if (config[key] !== undefined && !Array.isArray(config[key])) {
      issues.push(`config.${key} must be an array when set`);
    }
  }
  fail("project config", issues);
}
