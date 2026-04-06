import { describe, it, expect } from "vitest";
import {
  generateShadowTasks,
  generateShadowTasksForTask,
  getIncompleteReactions,
  getReactionsForDependency,
} from "../shadow-task.js";
import type { Project } from "../types.js";

function makeProject(): Project {
  return {
    id: "proj-1",
    name: "Test",
    description: "",
    state: "building",
    dependencies: [
      { id: "dep-1", name: "Docs", priority: "required", state: "complete" },
      { id: "dep-2", name: "Tests", priority: "required", state: "identified" },
    ],
    logicGates: [],
    tasks: [
      {
        id: "task-1",
        name: "Update DB",
        state: "in_progress",
        reactions: [
          { id: "r1", dependencyId: "dep-1", description: "Update docs", state: "complete" },
        ],
      },
      {
        id: "task-2",
        name: "Deploy",
        state: "pending",
        reactions: [],
      },
    ],
    complexityThreshold: 10,
    requireProofOfWork: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

// --- generateShadowTasks ---

describe("generateShadowTasks", () => {
  it("generates shadow reactions for missing dependencies", () => {
    const project = makeProject();
    const result = generateShadowTasks(project);

    // task-1 has reaction for dep-1 but not dep-2 -> 1 shadow
    const task1 = result.tasks.find((t) => t.id === "task-1")!;
    expect(task1.reactions).toHaveLength(2); // original + 1 shadow
    expect(task1.reactions.some((r) => r.dependencyId === "dep-2")).toBe(true);

    // task-2 has no reactions -> 2 shadows
    const task2 = result.tasks.find((t) => t.id === "task-2")!;
    expect(task2.reactions).toHaveLength(2);
  });

  it("does not duplicate existing reactions", () => {
    const project = makeProject();
    const once = generateShadowTasks(project);
    const twice = generateShadowTasks(once);

    const task1 = twice.tasks.find((t) => t.id === "task-1")!;
    const dep1Reactions = task1.reactions.filter((r) => r.dependencyId === "dep-1");
    expect(dep1Reactions).toHaveLength(1); // only the original, no shadow duplicate
  });

  it("marks shadow reactions as pending", () => {
    const project = makeProject();
    const result = generateShadowTasks(project);
    const shadows = result.tasks.flatMap((t) =>
      t.reactions.filter((r) => r.id.startsWith("shadow-")),
    );
    shadows.forEach((s) => expect(s.state).toBe("pending"));
  });
});

// --- generateShadowTasksForTask ---

describe("generateShadowTasksForTask", () => {
  it("generates shadows for a single task", () => {
    const project = makeProject();
    const result = generateShadowTasksForTask(project, "task-2");
    expect(result).not.toBeNull();
    expect(result!.reactions).toHaveLength(2);
  });

  it("returns null for unknown task", () => {
    const project = makeProject();
    const result = generateShadowTasksForTask(project, "unknown");
    expect(result).toBeNull();
  });
});

// --- getIncompleteReactions ---

describe("getIncompleteReactions", () => {
  it("returns only incomplete reactions", () => {
    const project = makeProject();
    // Original project has no incomplete reactions (task-1.r1 is complete, task-2 has none)
    // After shadow generation, new shadow reactions will be pending
    const withShadows = generateShadowTasks(project);
    const incompleteShadows = getIncompleteReactions(withShadows);
    expect(incompleteShadows.length).toBeGreaterThan(0);
    incompleteShadows.forEach((r) => expect(r.state).not.toBe("complete"));
  });
});

// --- getReactionsForDependency ---

describe("getReactionsForDependency", () => {
  it("returns reactions for a specific dependency", () => {
    const project = makeProject();
    const reactions = getReactionsForDependency(project, "dep-1");
    expect(reactions).toHaveLength(1);
    expect(reactions[0].id).toBe("r1");
  });

  it("returns empty for unknown dependency", () => {
    const project = makeProject();
    const reactions = getReactionsForDependency(project, "unknown");
    expect(reactions).toHaveLength(0);
  });
});
