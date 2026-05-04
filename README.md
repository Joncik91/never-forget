# Never Forget

[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License: ISC](https://img.shields.io/badge/license-ISC-E8954A.svg)](LICENSE)
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

// Add tasks — shadow tasks auto-generate for each dependency
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

// Complete work
engine.updateTaskState("migrate", "complete");
engine.updateTaskState("deploy", "complete");

// Post-flight checks enforce everything was done
engine.submitForReview();
engine.markComplete();
engine.deploy();
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

### Entry Gate

Blocks the project from starting until all **required** dependencies are ready. If `requireProofOfWork` is on, each dep needs evidence.

### Logic Gates

If/then rules that block or warn during the build:

```typescript
engine.addLogicGate({
  id: "notify-check",
  name: "Stakeholders notified?",
  condition: { subject: "notify", property: "state", operator: "neq", value: "complete" },
  action: { type: "warn", target: "project", message: "Stakeholders not yet notified" },
  enabled: true,
});
```

Operators: `eq`, `neq`, `in`, `not_in`, `exists`

### Shadow Tasks

Auto-generates sub-tasks for every dependency on every task. No dependency gets silently skipped.

### Observer Protocol

Audit log that records every missed reaction, blocked gate, and state transition. Catches "action without reaction" automatically.

## API

| Export | Description |
|--------|-------------|
| `ContingencyEngine` | Main orchestrator — start here |
| `createProject()` | Create a raw project object |
| `evaluateEntryGate()` | Check if gate passes |
| `runPreFlightChecks()` | Station check at 0% |
| `runPostFlightChecks()` | Station check at 100% |
| `generateShadowTasks()` | Auto-create dependency reactions |
| `createObserver()` | Standalone audit logger |
| `evaluateAllGates()` | Evaluate all logic gates |

## Develop

```bash
npm test          # run tests (vitest)
npm run lint      # eslint
npm run build     # compile to dist/
```

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

ISC — see [LICENSE](LICENSE).
