import { describe, it, expect } from "vitest";
import {
  ContingencyEngine,
  NeverForgetError,
  findMissingReactions,
  type DependencyState,
  type LogicGate,
  type TaskState,
} from "../index.js";

// Seeded random operation sequences against the engine. After every step the
// engine must either have thrown a library error with state untouched, or hold
// every invariant below.

function rng(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const IDS = ["a", "b", "c", "t1", "t2", "t3", "project", "p", ""];
const DEP_STATES: DependencyState[] = ["undefined", "identified", "drafted", "in_progress", "complete", "verified"];
const TASK_STATES: TaskState[] = ["pending", "in_progress", "complete", "blocked"];

function randomGate(r: () => number, pick: <T>(xs: readonly T[]) => T, n: number): LogicGate {
  const kinds: LogicGate["action"][] = [
    { type: "block", target: pick(["project", "t1", "t2", "zzz"]) },
    { type: "warn", target: "project" },
    { type: "notify", target: "project" },
    { type: "require_state", target: pick(["a", "b", "t1"]), state: pick(["complete", "verified", "pending"]) },
    { type: "generate_task", task: { id: pick(["t3", "gen", "a"]), name: "Generated" } },
  ];
  const conditions: LogicGate["condition"][] = [
    { subject: pick(IDS), property: "state", operator: "neq", value: pick(DEP_STATES) },
    { subject: pick(IDS), property: "state", operator: "in", value: [pick(DEP_STATES), pick(TASK_STATES)] },
    { subject: "project", property: "taskCount", operator: "gte", value: Math.floor(r() * 4) },
    { subject: pick(IDS), property: "hasProof", operator: "eq", value: "false" },
  ];
  return { id: `g${n}`, name: `Gate ${n}`, enabled: r() > 0.2, condition: pick(conditions), action: pick(kinds) };
}

function assertFrozen(value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const v of Object.values(value)) assertFrozen(v);
}

describe("fuzz: random operation sequences preserve invariants", () => {
  for (let seed = 1; seed <= 300; seed++) {
    it(`seed ${seed}`, () => {
      const r = rng(seed);
      const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
      const e = new ContingencyEngine({ id: "p", name: "P", requireProofOfWork: r() > 0.7, complexityThreshold: 8 });
      let gateN = 0;

      const ops: (() => void)[] = [
        () => e.addDependency({ id: pick(IDS), name: "D", priority: pick(["required", "recommended", "optional"] as const), state: pick(DEP_STATES), ...(r() > 0.5 ? { proofOfWork: "u" } : {}) }),
        () => e.updateDependencyState(pick(IDS), pick(DEP_STATES), r() > 0.5 ? "proof" : undefined),
        () => e.addTask({ id: pick(IDS), name: "T", state: pick(TASK_STATES), reactions: [] }),
        () => e.updateTaskState(pick(IDS), pick(TASK_STATES)),
        () => e.updateReactionState(pick(IDS), { dependencyId: pick(IDS) }, pick(TASK_STATES)),
        () => e.generateShadowTasks(),
        () => e.addLogicGate(randomGate(r, pick, gateN++)),
        () => e.setLogicGateEnabled(`g${Math.floor(r() * (gateN + 1))}`, r() > 0.5),
        () => e.passEntryGate(),
        () => e.startBuilding(),
        () => e.submitForReview(),
        () => e.requestChanges(),
        () => e.markComplete(),
        () => e.reopen(),
        () => e.deploy(),
        // Progress op: address every reaction and finish every task, so the
        // guarded transitions are actually reached, not just attempted.
        () => {
          e.generateShadowTasks();
          for (const t of e.getProject().tasks) {
            e.updateReactionState(t.id, { dependencyId: t.reactions[0]?.dependencyId ?? "" }, "complete");
          }
        },
        () => {
          for (const t of e.getProject().tasks) e.updateTaskState(t.id, "complete");
        },
        () => {
          for (const d of e.getProject().dependencies) e.updateDependencyState(d.id, "verified", "proof");
        },
      ];
      const guarded = new Set([10, 12, 14]);
      // Ops 15+ make several engine calls; earlier calls may commit before a later one throws.
      const compound = (i: number) => i >= 15;

      let lastSeq = 0;
      for (let step = 0; step < 150; step++) {
        const i = Math.floor(r() * ops.length);
        const before = e.getProject();
        try {
          ops[i]();
        } catch (err) {
          expect(err).toBeInstanceOf(NeverForgetError);
          if (!compound(i)) expect(e.getProject()).toBe(before);
          continue;
        }

        const p = e.getProject();
        assertFrozen(p);

        const entityIds = [...p.dependencies.map((d) => d.id), ...p.tasks.map((t) => t.id)];
        expect(new Set(entityIds).size).toBe(entityIds.length);
        expect(entityIds).not.toContain("project");
        expect(entityIds).not.toContain(p.id);
        for (const t of p.tasks) {
          const rIds = t.reactions.map((x) => x.id);
          expect(new Set(rIds).size).toBe(rIds.length);
        }

        if (guarded.has(i)) {
          expect(e.runPostFlightChecks().allPassed).toBe(true);
          expect(e.evaluateLogicGates().valid).toBe(true);
          expect(findMissingReactions(p)).toHaveLength(0);
        }

        for (const ev of e.getEvents()) {
          if (ev.seq <= lastSeq) continue;
          expect(ev.seq).toBe(lastSeq + 1);
          lastSeq = ev.seq;
        }
      }

      if (e.getProject().state === "deployed") {
        const frozen = e.getProject();
        for (const op of ops) {
          try {
            op();
          } catch {
            /* expected */
          }
        }
        expect(e.getProject()).toBe(frozen);
      }
    });
  }
});
