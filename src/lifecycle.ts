import type { Project, ProjectState } from "./types.js";
import { GateBlockedError } from "./errors.js";
import { assertCanTransition, evaluateEntryGate, runPostFlightChecks, transitionState } from "./project.js";
import { applyGeneratedTasks, evaluateAllGates } from "./logic-gate.js";

// Guarded lifecycle for the pure API. The engine uses the same functions, so
// both entry points enforce identical rules.

/** Transitions that leave the build and therefore require exit criteria. */
const EXIT_TRANSITIONS: ReadonlySet<string> = new Set([
  "building>review",
  "review>complete",
  "complete>deployed",
]);

export function isExitTransition(from: ProjectState, to: ProjectState): boolean {
  return EXIT_TRANSITIONS.has(`${from}>${to}`);
}

/**
 * Everything that stops the project leaving the build: failed blocking
 * post-flight checks, project-blocking logic gates, and task-blocking gates
 * whose task is already complete.
 */
export function getExitBlockers(project: Project): string[] {
  const blockers: string[] = [];
  for (const check of runPostFlightChecks(project).checks) {
    if (!check.passed && check.blocking !== false) {
      blockers.push(check.details ? `${check.message}: ${check.details}` : check.message);
    }
  }
  const gates = evaluateAllGates(project);
  blockers.push(...gates.errors);
  for (const r of gates.results) {
    if (!r.blocksTask || !r.message) continue;
    const task = project.tasks.find((t) => t.id === r.blocksTask);
    if (task?.state === "complete") {
      blockers.push(`${r.message} (task "${task.id}" is complete while blocked)`);
    }
  }
  return blockers;
}

/**
 * Moves the project to `to`, enforcing the entry gate (→ gated) and exit
 * criteria (→ review/complete/deployed). Exit criteria must hold both before
 * and after the move, including tasks that logic gates generate because of
 * the transition itself. Throws GateBlockedError / InvalidStateTransitionError.
 */
export function advanceState(project: Project, to: ProjectState): Project {
  assertCanTransition(project, to);
  if (to === "gated") {
    const entry = evaluateEntryGate(project);
    if (entry.blocked) throw new GateBlockedError(entry.blockers, "entry");
  }
  const moved = transitionState(project, to);
  if (isExitTransition(project.state, to)) {
    // Judge the state as it will be once logic gates generate their tasks.
    const candidate = applyGeneratedTasks(moved).project;
    // Check both sides: gates about the state being left ("while building…")
    // and gates about the state being entered ("on review…").
    const blockers = [...new Set([...getExitBlockers(project), ...getExitBlockers(candidate)])];
    if (blockers.length > 0) throw new GateBlockedError(blockers, "exit");
  }
  // Like every pure mutator, this does not apply generate_task gates itself;
  // call applyGeneratedTasks() (the engine does so after every change).
  return moved;
}
