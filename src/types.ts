// ============================================================================
// Never Forget — Core Types
// Redundancy & Logical Contingency Framework
// ============================================================================

// --- States (runtime lists are the source of truth for validation) ---

export const DEPENDENCY_STATES = [
  "undefined",
  "identified",
  "drafted",
  "in_progress",
  "complete",
  "verified",
] as const;
export type DependencyState = (typeof DEPENDENCY_STATES)[number];

export const TASK_STATES = ["pending", "in_progress", "complete", "blocked"] as const;
export type TaskState = (typeof TASK_STATES)[number];

export const PROJECT_STATES = [
  "defined",
  "gated",
  "building",
  "review",
  "complete",
  "deployed",
] as const;
export type ProjectState = (typeof PROJECT_STATES)[number];

export const DEPENDENCY_PRIORITIES = ["required", "recommended", "optional"] as const;
export type DependencyPriority = (typeof DEPENDENCY_PRIORITIES)[number];

export type Severity = "info" | "warning" | "error";

/** Dependency states that count as "done" for post-flight and coverage. */
export const DONE_DEPENDENCY_STATES: readonly DependencyState[] = ["complete", "verified"];

/** Dependency states that are too early to pass the entry gate. */
export const UNREADY_DEPENDENCY_STATES: readonly DependencyState[] = ["undefined", "identified"];

/** Reserved logic-gate subject that always refers to the project itself. */
export const PROJECT_SUBJECT = "project";

// --- Core Entities ---

export interface Dependency {
  id: string;
  name: string;
  priority: DependencyPriority;
  state: DependencyState;
  proofOfWork?: string;
  description?: string;
}

export interface Reaction {
  id: string;
  dependencyId: string;
  description: string;
  state: TaskState;
  proofOfWork?: string;
}

export interface Task {
  id: string;
  name: string;
  description?: string;
  state: TaskState;
  reactions: Reaction[];
}

// --- Logic Gates ---

interface ConditionBase {
  /** "project", the project id, a dependency id, or a task id. */
  subject: string;
  property: string;
}

export interface EqualityCondition extends ConditionBase {
  operator: "eq" | "neq";
  value: string;
}

export interface MembershipCondition extends ConditionBase {
  operator: "in" | "not_in";
  value: string[];
}

export interface ExistsCondition extends ConditionBase {
  operator: "exists";
  /** Ignored. Accepted for backwards compatibility. */
  value?: string;
}

export interface NumericCondition extends ConditionBase {
  operator: "gt" | "gte" | "lt" | "lte";
  value: number;
}

export type LogicCondition =
  | EqualityCondition
  | MembershipCondition
  | ExistsCondition
  | NumericCondition;

export type LogicOperator = LogicCondition["operator"];

export const LOGIC_OPERATORS: readonly LogicOperator[] = [
  "eq",
  "neq",
  "in",
  "not_in",
  "exists",
  "gt",
  "gte",
  "lt",
  "lte",
];

/** Blocks the target. Target "project" (or the project id) blocks exit transitions; a task id blocks completing that task. */
export interface BlockAction {
  type: "block";
  target: string;
  message?: string;
}

/** Records a warning while triggered. Never blocks. */
export interface WarnAction {
  type: "warn";
  target: string;
  message?: string;
}

/** Records an info event when the gate starts triggering. Never blocks. */
export interface NotifyAction {
  type: "notify";
  target: string;
  message?: string;
}

/** While triggered, `target` (dependency or task id) must be in `state`, otherwise project exit is blocked. */
export interface RequireStateAction {
  type: "require_state";
  target: string;
  state: DependencyState | TaskState;
  message?: string;
}

/** While triggered, ensures a task with this id exists (created once, never removed). */
export interface GenerateTaskAction {
  type: "generate_task";
  /** Kept for symmetry with the other actions; defaults to the generated task id. */
  target?: string;
  task: { id: string; name: string; description?: string };
  message?: string;
}

export type LogicAction =
  | BlockAction
  | WarnAction
  | NotifyAction
  | RequireStateAction
  | GenerateTaskAction;

export type LogicActionType = LogicAction["type"];

export const LOGIC_ACTION_TYPES: readonly LogicActionType[] = [
  "block",
  "warn",
  "notify",
  "require_state",
  "generate_task",
];

export interface LogicGate {
  id: string;
  name: string;
  condition: LogicCondition;
  action: LogicAction;
  enabled: boolean;
}

/** Outcome of evaluating one gate against a project. */
export type GateStatus = "idle" | "triggered" | "invalid";

export interface GateEvaluation {
  gateId: string;
  gateName: string;
  status: GateStatus;
  action: LogicAction;
  /** Human-readable explanation; set when triggered or invalid. */
  message?: string;
  /** True when this result must stop the project from leaving the build. */
  blocksProject: boolean;
  /** Task id whose completion this result blocks, if any. */
  blocksTask?: string;
}

// --- Checks ---

export interface CheckResult {
  passed: boolean;
  message: string;
  details?: string;
  /** Stable machine-readable id. */
  id?: string;
  /** Advisory checks (`blocking: false`) never fail `allPassed`. Defaults to blocking. */
  blocking?: boolean;
}

export interface PreFlightCheck {
  id: string;
  name: string;
  validate: (project: Project) => CheckResult;
}

export interface PostFlightCheck {
  id: string;
  name: string;
  validate: (project: Project) => CheckResult;
}

// --- Observer ---

export const OBSERVER_EVENT_TYPES = [
  "action_without_reaction",
  "gate_blocked",
  "gate_passed",
  "gate_triggered",
  "gate_cleared",
  "state_transition",
  "complexity_exceeded",
  "dependency_added",
  "dependency_updated",
  "task_added",
  "task_updated",
  "task_generated",
  "reaction_updated",
  "logic_gate_added",
  "logic_gate_updated",
  "shadow_task_generated",
  "proof_required",
] as const;
export type ObserverEventType = (typeof OBSERVER_EVENT_TYPES)[number];

export interface ObserverEvent {
  /** Monotonic per observer; orders events that share a millisecond. */
  seq: number;
  timestamp: string;
  type: ObserverEventType;
  subject: string;
  details: string;
  severity: Severity;
}

// --- Project ---

export interface ProjectConfig {
  id: string;
  name: string;
  description?: string;
  dependencies?: Dependency[];
  logicGates?: LogicGate[];
  tasks?: Task[];
  complexityThreshold?: number;
  requireProofOfWork?: boolean;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  state: ProjectState;
  dependencies: Dependency[];
  logicGates: LogicGate[];
  tasks: Task[];
  complexityThreshold: number;
  requireProofOfWork: boolean;
  createdAt: string;
  updatedAt: string;
}

// --- Results ---

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  /** Per-gate detail, one entry per enabled gate. */
  results: GateEvaluation[];
}

export interface GateResult {
  passed: boolean;
  blocked: boolean;
  /** Short summary lines. */
  messages: string[];
  /** Full explanation per failed requirement; empty when passed. */
  blockers: string[];
}

export interface FlightCheckResult {
  /** True when every blocking check passed. Advisory failures do not count. */
  allPassed: boolean;
  checks: CheckResult[];
}

export interface ComplexityResult {
  exceeded: boolean;
  score: number;
  threshold: number;
}

/** Selects reactions on one task: a single reaction by id, or every reaction for a dependency. */
export type ReactionSelector = { reactionId: string } | { dependencyId: string };
