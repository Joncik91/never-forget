export class NeverForgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NeverForgetError";
  }
}

/** A gate refused to let the project (or a task) move forward. */
export class GateBlockedError extends NeverForgetError {
  public readonly blockers: string[];
  /** Which gate blocked: "entry", "post-flight", "logic-gates", or a task gate like "task:<id>". */
  public readonly gate: string;

  constructor(blockers: string[], gate = "entry") {
    const label = gate.charAt(0).toUpperCase() + gate.slice(1);
    super(`${label} gate blocked: ${blockers.join("; ")}`);
    this.name = "GateBlockedError";
    this.blockers = [...blockers];
    this.gate = gate;
  }
}

export class InvalidStateTransitionError extends NeverForgetError {
  public readonly from: string;
  public readonly to: string;

  constructor(from: string, to: string, reason: string) {
    super(`Cannot transition from ${from} to ${to}: ${reason}`);
    this.name = "InvalidStateTransitionError";
    this.from = from;
    this.to = to;
  }
}

export class DependencyNotMetError extends NeverForgetError {
  public readonly dependencyId: string;

  constructor(dependencyId: string, reason: string) {
    super(`Dependency ${dependencyId} not met: ${reason}`);
    this.name = "DependencyNotMetError";
    this.dependencyId = dependencyId;
  }
}

export class ProofRequiredError extends NeverForgetError {
  public readonly dependencyId: string;

  constructor(dependencyId: string) {
    super(`Proof of work required for dependency: ${dependencyId}`);
    this.name = "ProofRequiredError";
    this.dependencyId = dependencyId;
  }
}

/** Input failed validation. `issues` lists every problem found, not just the first. */
export class ValidationError extends NeverForgetError {
  public readonly issues: string[];

  constructor(what: string, issues: string[]) {
    super(`Invalid ${what}: ${issues.join("; ")}`);
    this.name = "ValidationError";
    this.issues = [...issues];
  }
}

/** An id is already taken by another entity in the same namespace. */
export class DuplicateIdError extends NeverForgetError {
  public readonly id: string;

  constructor(kind: string, id: string, detail = "already exists") {
    super(`${kind} ${id} ${detail}`);
    this.name = "DuplicateIdError";
    this.id = id;
  }
}

/** A referenced entity does not exist. */
export class NotFoundError extends NeverForgetError {
  public readonly id: string;

  constructor(kind: string, id: string) {
    super(`${kind} ${id} not found`);
    this.name = "NotFoundError";
    this.id = id;
  }
}

/** The project is deployed; deployed projects are immutable. */
export class ProjectLockedError extends NeverForgetError {
  public readonly projectId: string;

  constructor(projectId: string) {
    super(`Project ${projectId} is deployed and can no longer be modified`);
    this.name = "ProjectLockedError";
    this.projectId = projectId;
  }
}
