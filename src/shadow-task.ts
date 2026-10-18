import type { Dependency, Project, Reaction, Task } from "./types.js";
import { ProjectLockedError } from "./errors.js";

// --- Shadow Task Generation ---

/**
 * Stable, collision-free id for the auto-generated reaction of (task, dependency).
 * Parts are URI-encoded so the ":" separator can never appear inside them.
 */
export function shadowReactionId(taskId: string, dependencyId: string): string {
  return `shadow-${encodeURIComponent(taskId)}:${encodeURIComponent(dependencyId)}`;
}

function withShadows(task: Task, dependencies: readonly Dependency[]): Task {
  const covered = new Set(task.reactions.map((r) => r.dependencyId));
  const taken = new Set(task.reactions.map((r) => r.id));
  const shadows: Reaction[] = [];
  for (const dep of dependencies) {
    if (covered.has(dep.id)) continue;
    let id = shadowReactionId(task.id, dep.id);
    // A caller-chosen reaction id may already use the canonical id; disambiguate.
    for (let n = 2; taken.has(id); n++) id = `${shadowReactionId(task.id, dep.id)}~${n}`;
    taken.add(id);
    shadows.push({
      id,
      dependencyId: dep.id,
      description: `[Auto-generated] Ensure "${dep.name}" is addressed for task "${task.name}"`,
      state: "pending",
    });
  }
  return shadows.length === 0 ? task : { ...task, reactions: [...task.reactions, ...shadows] };
}

/** Adds a pending reaction for every (task, dependency) pair that has none. Idempotent. */
export function generateShadowTasks(project: Project): Project {
  if (project.state === "deployed") throw new ProjectLockedError(project.id);
  let changed = false;
  const tasks = project.tasks.map((task) => {
    const next = withShadows(task, project.dependencies);
    if (next !== task) changed = true;
    return next;
  });
  return changed ? { ...project, tasks, updatedAt: new Date().toISOString() } : project;
}

/** The given task with shadow reactions added, or null if it does not exist. Does not modify the project. */
export function generateShadowTasksForTask(project: Project, taskId: string): Task | null {
  const task = project.tasks.find((t) => t.id === taskId);
  return task ? withShadows(task, project.dependencies) : null;
}

export function getIncompleteReactions(project: Project): Reaction[] {
  return project.tasks.flatMap((t) => t.reactions.filter((r) => r.state !== "complete"));
}

export function getReactionsForDependency(project: Project, dependencyId: string): Reaction[] {
  return project.tasks.flatMap((t) => t.reactions.filter((r) => r.dependencyId === dependencyId));
}
