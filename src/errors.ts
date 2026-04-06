export class NeverForgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NeverForgetError";
  }
}

export class GateBlockedError extends NeverForgetError {
  public readonly blockers: string[];

  constructor(blockers: string[]) {
    super(`Entry gate blocked: ${blockers.join("; ")}`);
    this.name = "GateBlockedError";
    this.blockers = blockers;
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
    super(
      `Proof of work required for dependency: ${dependencyId}`,
    );
    this.name = "ProofRequiredError";
    this.dependencyId = dependencyId;
  }
}
