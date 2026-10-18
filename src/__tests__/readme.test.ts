import { describe, it, expect, vi } from "vitest";
import readme from "../../README.md?raw";
import * as lib from "../index.js";

// Executes the README Quick Start verbatim (import line swapped for the local
// build), so the documented flow can never silently break again.

function quickStart(): string {
  const section = readme.slice(readme.indexOf("## Quick Start"));
  const match = /```typescript\n([\s\S]*?)```/.exec(section);
  if (!match) throw new Error("Quick Start code block not found");
  return match[1].replace(/^import .* from "never-forget";$/m, "");
}

describe("README", () => {
  it("Quick Start runs end to end and deploys", () => {
    const warn = vi.fn();
    const run = new Function("ContingencyEngine", "console", `${quickStart()}\nreturn engine;`);
    const engine = run(lib.ContingencyEngine, { warn }) as lib.ContingencyEngine;
    expect(engine.getProject().state).toBe("deployed");
  });

  it("documents the real shadow reaction id format", () => {
    expect(readme).toContain(lib.shadowReactionId("deploy", "docs"));
  });
});
