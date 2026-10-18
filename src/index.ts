// ============================================================================
// Never Forget — Redundancy & Logical Contingency Framework
// ============================================================================

// Types
export type {
  Dependency,
  DependencyState,
  DependencyPriority,
  Task,
  TaskState,
  Reaction,
  ReactionSelector,
  LogicGate,
  LogicCondition,
  LogicOperator,
  EqualityCondition,
  MembershipCondition,
  ExistsCondition,
  NumericCondition,
  LogicAction,
  LogicActionType,
  BlockAction,
  WarnAction,
  NotifyAction,
  RequireStateAction,
  GenerateTaskAction,
  GateEvaluation,
  GateStatus,
  CheckResult,
  PreFlightCheck,
  PostFlightCheck,
  ObserverEvent,
  ObserverEventType,
  ProjectConfig,
  Project,
  ProjectState,
  ValidationResult,
  GateResult,
  FlightCheckResult,
  ComplexityResult,
  Severity,
} from "./types.js";

// Runtime constants
export {
  DEPENDENCY_STATES,
  TASK_STATES,
  PROJECT_STATES,
  DEPENDENCY_PRIORITIES,
  DONE_DEPENDENCY_STATES,
  UNREADY_DEPENDENCY_STATES,
  LOGIC_OPERATORS,
  LOGIC_ACTION_TYPES,
  OBSERVER_EVENT_TYPES,
  PROJECT_SUBJECT,
} from "./types.js";

// Errors
export {
  NeverForgetError,
  GateBlockedError,
  InvalidStateTransitionError,
  DependencyNotMetError,
  ProofRequiredError,
  ValidationError,
  DuplicateIdError,
  NotFoundError,
  ProjectLockedError,
} from "./errors.js";

// Project functions (pure, immutable)
export {
  createProject,
  addDependency,
  updateDependencyState,
  addTask,
  updateTaskState,
  updateReactionState,
  addLogicGate,
  setLogicGateEnabled,
  transitionState,
  canTransition,
  evaluateEntryGate,
  passEntryGate,
  runPreFlightChecks,
  runPostFlightChecks,
  findMissingReactions,
} from "./project.js";

// Guarded lifecycle (pure)
export { advanceState, getExitBlockers, isExitTransition } from "./lifecycle.js";

// Logic gates
export {
  evaluateCondition,
  evaluateGate,
  evaluateGateDetailed,
  evaluateAllGates,
  getTaskBlockers,
  applyGeneratedTasks,
  type GeneratedTasksResult,
} from "./logic-gate.js";

// Shadow tasks
export {
  generateShadowTasks,
  generateShadowTasksForTask,
  getIncompleteReactions,
  getReactionsForDependency,
  shadowReactionId,
} from "./shadow-task.js";

// Complexity
export { calculateComplexity } from "./complexity.js";

// Observer
export {
  createObserver,
  observeActionWithoutReaction,
  observeGateBlocked,
  observeGatePassed,
  observeStateTransition,
  observeComplexityExceeded,
  scanForMissedReactions,
  DEFAULT_MAX_EVENTS,
  type Observer,
  type ObserverListener,
  type ObserverOptions,
} from "./observer.js";

// Engine
export { ContingencyEngine, type EngineOptions, type ExitCriteria } from "./engine.js";
