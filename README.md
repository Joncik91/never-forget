# Never Forget

[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-E8954A.svg)](LICENSE)
[![Tested with Vitest](https://img.shields.io/badge/tested%20with-vitest-6E9F18?logo=vitest&logoColor=white)](https://vitest.dev/)
[![Zero deps](https://img.shields.io/badge/zero%20deps-✓-E8954A)]()
[![ESM](https://img.shields.io/badge/format-ESM-E8954A)]()

**A TypeScript library for tracking critical dependencies and enforcing "if this, then that" logic during complex project builds.**

When you're building **C**, dependencies **A** and **B** are essential. But in the momentum of building, they get forgotten. This library makes that impossible — the engine enforces dependency state, blocks transitions through logic gates, auto-generates shadow tasks for every dependency, and audits the whole thing through an observer protocol.

## Table of Contents

- [The Problem](#the-problem)
- [Quick Start](#quick-start)
- [Core Concepts](#core-concepts)
- [API](#api)
- [Develop](#develop)
- [Security](#security)
- [License](#license)

## The Problem

You know that when building **C**, dependencies **A** and **B** are essential. But in the momentum of building, they get forgotten. This library makes that impossible.

## Quick Start

```typescript
import { ContingencyEngine } from "never-forget";

const engine = new ContingencyEngine({
  id: "deploy-api-v2",
  name: "Deploy API v2",
  requireProofOfWork: true,
});

// React to everything the engine notices, as it happens
const unsubscribe = engine.subscribe((event) => {
  if (event.severity !== "info") console.warn(`[${event.type}] ${event.details}`);
});

// Define what must not be forgotten (A and B)
engine.addDependency({
  id: "docs",
  name: "API Documentation",
  priority: "required",
  state: "complete",
  proofOfWork: "https://confluence.example.com/api-v2-docs",
});

engine.addDependency({
  id: "tests",
  name: "Integration Tests",
  priority: "required",
  state: "complete",
  proofOfWork: "https://ci.example.com/run/4821",
});

// Gate blocks until all required deps are met
engine.passEntryGate();
engine.startBuilding();

// Add tasks — shadow tasks give every task one reaction per dependency
engine.addTask({ id: "migrate", name: "Run Migration", state: "pending", reactions: [] });
engine.addTask({ id: "deploy", name: "Deploy", state: "pending", reactions: [] });
engine.generateShadowTasks();

// Add conditional logic
engine.addLogicGate({
  id: "block-without-tests",
  name: "Tests must pass",
  condition: { subject: "tests", property: "state", operator: "neq", value: "complete" },
  action: { type: "block", target: "project", message: "Integration tests not complete" },
  enabled: true,
});

// Do the work: address each dependency for each task, then finish the task
for (const task of ["migrate", "deploy"]) {
  engine.updateReactionState(task, { dependencyId: "docs" }, "complete");
  engine.updateReactionState(task, { dependencyId: "tests" }, "complete");
  engine.updateTaskState(task, "complete");
}

// Exit transitions re-check post-flight checks and logic gates every time
engine.submitForReview();
engine.markComplete();
engine.deploy(); // deployed projects are immutable

unsubscribe();
```

Anything missing throws a typed error that says exactly what is missing:

```text
GateBlockedError: Exit gate blocked: 1 incomplete reactions for required dependencies: Deploy → Integration Tests
```

## Core Concepts

### Dependencies (A, B, ...)

Things that must exist or be done before the main work (C) can proceed.

```typescript
engine.addDependency({
  id: "security-review",
  name: "Security Review",
  priority: "required",   // "required" | "recommended" | "optional"
  state: "complete",       // "undefined" → "identified" → "drafted" → "in_progress" → "complete" → "verified"
});
```

Dependencies and tasks share one id namespace (so logic gates can refer to
either unambiguously). `"project"` and the project id are reserved.

### Entry Gate

Blocks the project from starting until at least one dependency is
**required** and every required dependency is past `identified`. If
`requireProofOfWork` is on, each required dependency also needs evidence.

### Shadow Tasks and the coverage invariant

Every task must have a **completed reaction for every required
dependency** before the project can leave the build. This holds for tasks
added at any time, not just those present when shadows were generated.

`generateShadowTasks()` creates the missing reactions (idempotent).
Complete them by dependency or by reaction id:

```typescript
engine.updateReactionState("deploy", { dependencyId: "docs" }, "complete", "https://link/to/proof");
engine.updateReactionState("deploy", { reactionId: "shadow-deploy:docs" }, "complete");
```

Open reactions for `recommended`/`optional` dependencies are reported as an
advisory post-flight check; they do not block.

### Logic Gates

If/then rules evaluated reactively after every change:

```typescript
engine.addLogicGate({
  id: "notify-check",
  name: "Stakeholders notified?",
  condition: { subject: "notify", property: "state", operator: "neq", value: "complete" },
  action: { type: "warn", target: "project", message: "Stakeholders not yet notified" },
  enabled: true,
});
```

**Subjects:** `"project"` (or the project id), a dependency id, or a task id.

| Subject | Properties |
|---|---|
| project | `state`, `name`, `dependencyCount`, `taskCount`, `logicGateCount`, `complexity`, `complexityThreshold`, `requireProofOfWork` |
| dependency | `state`, `name`, `priority`, `hasProof`, `proofOfWork` |
| task | `state`, `name`, `reactionCount`, `incompleteReactionCount` |

**Operators:** `eq`, `neq` (string), `in`, `not_in` (string array),
`exists`, `gt`, `gte`, `lt`, `lte` (number, numeric properties only).

**Actions:**

| Action | Effect while the condition holds |
|---|---|
| `block` → `target: "project"` | Blocks `submitForReview`, `markComplete`, `deploy` |
| `block` → `target: "<task id>"` | Blocks completing that task |
| `require_state` → `target`, `state` | Blocks exit unless the target dependency/task is in `state` |
| `warn` | Logs a warning when it starts triggering |
| `notify` | Logs an info event when it starts triggering |
| `generate_task` → `task: { id, name }` | Creates the task once (pending) |

A gate that refers to an unknown subject or property, or compares a
non-numeric property with `gt`, **fails closed**: it blocks exit with a
"misconfigured" message instead of silently never firing. Toggle gates with
`setLogicGateEnabled(id, enabled)`.

### Lifecycle

```text
defined → gated → building ⇄ review ⇄ complete → deployed
```

`passEntryGate`, `startBuilding`, `submitForReview`, `requestChanges`
(review → building), `markComplete`, `reopen` (complete → review), `deploy`.
The three forward exits (`submitForReview`, `markComplete`, `deploy`) all
re-run `checkExitCriteria()`, because state can change during review.

### Observer Protocol

An audit log of every change, gate decision and missed reaction. Events are
frozen, carry a monotonic `seq`, and stream live via `subscribe()`. Derived
warnings (`gate_triggered`, `proof_required`, `complexity_exceeded`) fire
once per crossing, not on every call. `action_without_reaction` fires the
moment a task completes without addressing a required dependency.

```typescript
import { createObserver, ContingencyEngine } from "never-forget";

const observer = createObserver({ maxEvents: 5000 }); // ring buffer; oldest evicted
const engine = new ContingencyEngine({ id: "p", name: "P" }, { observer });
observer.droppedCount(); // events evicted so far
```

A throwing listener never breaks the engine; errors go to
`onListenerError` (default `console.error`).

### Errors

All errors extend `NeverForgetError`: `GateBlockedError` (with `gate` and
`blockers`), `InvalidStateTransitionError`, `ValidationError` (with every
`issue`), `DuplicateIdError`, `NotFoundError`, `ProjectLockedError`. A call
that throws leaves the engine state unchanged.

## API

| Export | Description |
|--------|-------------|
| `ContingencyEngine` | Main orchestrator — start here |
| `createProject()` | Create a validated, immutable project object |
| `addDependency()`, `addTask()`, `addLogicGate()`, `update*State()` | Pure, immutable project edits |
| `evaluateEntryGate()` | Check if gate passes |
| `runPreFlightChecks()` | Station check at 0% (advisory checks have `blocking: false`) |
| `runPostFlightChecks()` | Station check at 100% |
| `findMissingReactions()` | Every (task, required dependency) pair not yet addressed |
| `generateShadowTasks()` | Auto-create dependency reactions |
| `evaluateAllGates()`, `evaluateGateDetailed()` | Evaluate logic gates |
| `createObserver()` | Standalone audit logger |

## Develop

```bash
npm run check     # typecheck + lint + tests (incl. 300-seed fuzz)
npm run build     # compile to dist/ (tests excluded)
```

Requires Node 18+ (or any runtime with `structuredClone`).

## Security

The library is **pure-logic in-process**. No I/O, no network, no
filesystem access — `ContingencyEngine` operates entirely on objects
in memory. Two practical implications:

- **Audit surface is small.** `find src/ -name '*.ts' | xargs wc -l`
  reads end-to-end in one sitting. Read it before adopting in
  load-bearing pipelines.
- **`proofOfWork` URLs are caller-supplied strings.** The engine
  stores them verbatim and surfaces them in observer events; it
  never fetches them. If you log observer output, treat
  `proofOfWork` strings the same way you treat user input — they
  could carry whatever the caller put there.

The library has zero runtime dependencies and ships ESM-only.
Everything you bring into your project is what you read in `src/`.

## License

MIT — see [LICENSE](LICENSE).
