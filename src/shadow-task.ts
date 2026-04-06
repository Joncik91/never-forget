import type { Project, Task, Reaction } from "./types.js";

// --- Shadow Task Generation ---

export function generateShadowTasks(project: Project): Project {
  const updatedTasks = project.tasks.map((task) => {
    const existingDepIds = new Set(task.reactions.map((r) => r.dependencyId));
    const shadowReactions: Reaction[] = [];

    for (const dep of project.dependencies) {
      if (!existingDepIds.has(dep.id)) {
        shadowReactions.push({
          id: `shadow-${task.id}-${dep.id}`,
          dependencyId: dep.id,
          description: `[Auto-generated] Ensure "${dep.name}" is addressed for task "${task.name}"`,
          state: "pending",
        });
      }
    }

    return {
      ...task,
      reactions: [...task.reactions, ...shadowReactions],
    };
  });

  return { ...project, tasks: updatedTasks, updatedAt: new Date().toISOString() };
}

export function generateShadowTasksForTask(
  project: Project,
  taskId: string,
): Task | null {
  const task = project.tasks.find((t) => t.id === taskId);
  if (!task) return null;

  const existingDepIds = new Set(task.reactions.map((r) => r.dependencyId));
  const shadowReactions: Reaction[] = [];

  for (const dep of project.dependencies) {
    if (!existingDepIds.has(dep.id)) {
      shadowReactions.push({
        id: `shadow-${task.id}-${dep.id}`,
        dependencyId: dep.id,
        description: `[Auto-generated] Ensure "${dep.name}" is addressed for task "${task.name}"`,
        state: "pending",
      });
    }
  }

  return {
    ...task,
    reactions: [...task.reactions, ...shadowReactions],
  };
}

export function getIncompleteReactions(
  project: Project,
): Reaction[] {
  return project.tasks.flatMap((t) =>
    t.reactions.filter((r) => r.state !== "complete"),
  );
}

export function getReactionsForDependency(
  project: Project,
  dependencyId: string,
): Reaction[] {
  return project.tasks.flatMap((t) =>
    t.reactions.filter((r) => r.dependencyId === dependencyId),
  );
}
