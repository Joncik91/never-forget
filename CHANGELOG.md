# Changelog

## 2.0.0

Hardening release. The 1.x engine could ship a project that had forgotten
its dependencies — the one thing it exists to prevent. Each fix below has a
regression test in `src/__tests__/hardening.test.ts`; a 300-seed fuzz test
(`fuzz.test.ts`) checks the invariants after every random operation; the
README Quick Start runs as a test (`readme.test.ts`).

### Critical bugs fixed

- **Tasks could ship without addressing required dependencies.** Post-flight
  only checked that *existing* reactions were complete; a task with no
  reactions (or added after `generateShadowTasks()`) passed. Post-flight now
  requires a completed reaction for every (task, required dependency) pair.
- **Logic gates never blocked anything.** `block` gates were only reported by
  `evaluateLogicGates()`. They now block `submitForReview`, `markComplete`
  and `deploy` (target `project`) or completing a task (target = task id).
- **README Quick Start always threw.** Shadow reactions could never be
  completed: there was no API to update a reaction. Added
  `updateReactionState()`.
- **Exit checks ran only once.** A dependency could regress during review
  and the project still completed and deployed. All three exit transitions
  now re-check post-flight checks and logic gates.
- **Caller mutation leaked into engine state.** Inputs were stored by
  reference and `getProject()` returned mutable internals. Inputs are now
  deep-copied; snapshots are deep-frozen.
- **Duplicate ids accepted.** Duplicate tasks or gates silently coexisted
  (and `updateTaskState` updated both). Dependencies and tasks now share one
  validated id namespace; `"project"` and the project id are reserved, so
  gate subjects are unambiguous.
- **Shadow reaction id collisions.** `shadow-${task}-${dep}` collided for
  ids containing `-` (task `a-b` + dep `c` vs task `a` + dep `b-c`). Ids are
  now URI-encoded around a `:` separator and never clobber caller ids.
- **Misused operators failed silently.** `in` with a string, `eq` with an
  array, or a typo in a gate subject made a gate never fire (or always fire
  for `neq`). Gates are validated on insert; anything unresolvable at
  evaluation time fails closed and blocks exit with an explicit message.
- **Bogus audit entries.** `passEntryGate()` logged `gate_passed` before
  checking the transition was legal; transitions logged hard-coded
  from-states. Transitions are checked first and log the real from-state.
- **Wrong error types.** The engine threw plain `Error` where the pure API
  threw `GateBlockedError`. Every library error now extends
  `NeverForgetError`.
- **Advisory pre-flight check failed the run.** "No logic gates — consider
  adding" made `allPassed` false. Checks now carry `blocking`.
- **Timestamps.** `createdAt` and `updatedAt` came from two clock reads.

### Latent features realized

- `require_state`, `generate_task` and `notify` actions were declared but
  silently treated as warnings. All are implemented (see README table).
- Numeric project/task properties were exposed as strings with no way to
  compare them. Added `gt`, `gte`, `lt`, `lte`.
- `review → building` and `complete → review` transitions existed with no
  engine method: added `requestChanges()` and `reopen()`. Removed the
  meaningless `building → building` self-transition.
- `"proof_required"` event type was never emitted: now fires once when a
  required dependency claims done without proof under `requireProofOfWork`.
- "Catches action without reaction automatically" required a manual scan:
  now logged the moment a task completes.
- Gates had an `enabled` flag with no way to toggle: `setLogicGateEnabled()`.
- `ProofRequiredError` and `DependencyNotMetError` remain exported for
  compatibility; the engine does not throw them.

### Structural upgrades

- Reactive engine: every mutation is atomic (compute, then commit); derived
  state (generated tasks, gate edges, complexity, proof) reconciles after each
  commit. Events are edge-triggered, so warnings fire once per crossing
  instead of on every call. `subscribe()` replaces polling `getEvents()`.
- Engine delegates to the pure core instead of duplicating it.
- Runtime validation (`validate.ts`) for every public input, reporting all
  issues at once (`ValidationError.issues`).
- Deployed projects are immutable (`ProjectLockedError`).
- Observer: O(1) ring buffer, `droppedCount()`, frozen events with a
  monotonic `seq`, listener errors isolated, configurable capacity and clock,
  injectable into the engine.
- Packaging: `exports`, `files`, `engines`, `sideEffects: false`; tests no
  longer compiled into `dist/`; vitest no longer picks up stale `dist` tests;
  `npm run check`; CI on Node 20/22/24.

### Breaking changes

- Post-flight (and therefore `submitForReview`) requires every task to have
  a completed reaction for every required dependency.
- The entry gate requires at least one `required` dependency.
- Block / require_state / misconfigured gates now stop exit transitions.
- Duplicate or reserved ids, malformed entities, and reactions referring to
  unknown dependencies throw on insert. Declare dependencies before tasks
  whose reactions reference them.
- Open reactions for non-required dependencies no longer block (advisory).
- `LogicCondition` / `LogicAction` are discriminated unions; `value` types
  must match the operator.
- `ObserverEvent` gained `seq`; `Observer` gained `subscribe` and
  `droppedCount`; `log()` returns the stored event.
- `checkComplexity()` no longer logs; crossing the threshold is logged
  automatically once per crossing.
- `GateResult` gained `blockers`; `ValidationResult` gained `results`.
- Errors for duplicates / missing entities are `DuplicateIdError` /
  `NotFoundError` (messages unchanged: "already exists" / "not found").
- `evaluateCondition` returns `false` for unknown subjects for every
  operator (`neq` used to return `true`).
