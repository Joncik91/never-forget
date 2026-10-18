import type { Project } from "./types.js";

/**
 * Complexity score: each dependency weighs 2 (it fans out to every task),
 * each task, reaction and logic gate weighs 1.
 */
export function calculateComplexity(project: Project): number {
  let reactions = 0;
  for (const t of project.tasks) reactions += t.reactions.length;
  return (
    project.dependencies.length * 2 +
    project.tasks.length +
    reactions +
    project.logicGates.length
  );
}
