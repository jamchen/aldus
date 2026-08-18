/**
 * The Agent Backend boundary (architecture contract §10).
 *
 * §10 opens with "The Runtime MUST NOT equal Claude Code or Codex", so this package defines the
 * seam and implements no backend. What the runner owes §10 and §11 is a capability check *before*
 * execution: a stage that needs filesystem access and is handed a backend without it should fail
 * on the declaration, not halfway through its side effects.
 */

import { afterEach, describe, expect, it } from "vitest";

import { assertCapabilities, backendActor, type AgentCapabilities } from "../src/backend.js";
import { StageRunnerErrorCodes } from "../src/errors.js";
import { aBackend, aStage, makeTempRun, type TempRun } from "./helpers.js";

const capabilities = (offers: string[]): AgentCapabilities => ({
  offers,
  interactive: true,
  resumable: false,
});

describe("assertCapabilities", () => {
  it("passes when every required capability is offered", () => {
    expect(() =>
      assertCapabilities(capabilities(["filesystem", "tools"]), ["filesystem"], {
        stageId: "stage-a",
        backendId: "backend-a",
      }),
    ).not.toThrow();
  });

  it("passes when nothing is required", () => {
    expect(() =>
      assertCapabilities(capabilities([]), [], { stageId: "stage-a", backendId: "backend-a" }),
    ).not.toThrow();
  });

  it("names every missing capability at once", () => {
    try {
      assertCapabilities(capabilities(["tools"]), ["filesystem", "structured-output", "tools"], {
        stageId: "stage-a",
        backendId: "backend-a",
      });
      expect.unreachable("expected a capability failure");
    } catch (error) {
      const failure = error as { code: string; details?: Record<string, unknown> };
      expect(failure.code).toBe(StageRunnerErrorCodes.STAGE_CAPABILITY_UNAVAILABLE);
      // Reporting one per run would make a misconfigured backend take several runs to diagnose.
      expect(failure.details?.missing).toEqual(["filesystem", "structured-output"]);
    }
  });

  it("classifies a missing capability as a policy failure, so it is never retried", () => {
    try {
      assertCapabilities(capabilities([]), ["filesystem"], {
        stageId: "stage-a",
        backendId: "backend-a",
      });
      expect.unreachable("expected a capability failure");
    } catch (error) {
      const failure = error as { category: string; retryable: boolean };
      // Retrying cannot make a backend grow a capability.
      expect(failure.category).toBe("policy");
      expect(failure.retryable).toBe(false);
    }
  });

  it("treats capability names as opaque strings", () => {
    // §10 lists what capabilities describe but names no closed set, and §4.2 keeps Core from
    // enumerating backends. A name this package has never seen must work.
    expect(() =>
      assertCapabilities(
        capabilities(["some-adopter-specific-capability"]),
        ["some-adopter-specific-capability"],
        { stageId: "stage-a", backendId: "backend-a" },
      ),
    ).not.toThrow();
  });
});

describe("backendActor", () => {
  it("describes a backend as an agent actor (§6.4, §19.2)", () => {
    expect(backendActor(aBackend([], "backend-a"), "agent-a")).toEqual({
      kind: "agent",
      id: "agent-a",
      backendId: "backend-a",
    });
  });
});

describe("the runner's capability check", () => {
  let harness: TempRun;

  afterEach(async () => {
    await harness?.cleanup();
  });

  it("refuses to run a stage whose capabilities the backend lacks", async () => {
    harness = await makeTempRun({ backend: aBackend(["tools"]) });
    let ran = false;
    harness.registry.register(
      aStage({
        requiredCapabilities: ["filesystem"],
        execute: async () => {
          ran = true;
          return { kind: "completed", output: undefined };
        },
      }),
    );

    await expect(harness.runner.run(harness.manifest.runId, "stage-a", {})).rejects.toMatchObject({
      code: StageRunnerErrorCodes.STAGE_CAPABILITY_UNAVAILABLE,
    });
    // Checked before execution: §19.1's recovery from partial success is a fallback for failures
    // that could not be predicted, not a substitute for the ones that could.
    expect(ran).toBe(false);
  });

  it("records no attempt for a stage refused on capabilities", async () => {
    harness = await makeTempRun({ backend: aBackend([]) });
    harness.registry.register(aStage({ requiredCapabilities: ["filesystem"] }));

    await harness.runner.run(harness.manifest.runId, "stage-a", {}).catch(() => undefined);
    // Nothing was attempted, so nothing is recorded — an attempt record would imply the stage ran.
    expect(await harness.runner.stageExecution(harness.manifest.runId, "stage-a")).toBeUndefined();
  });

  it("runs when the backend offers what the stage requires", async () => {
    harness = await makeTempRun({ backend: aBackend(["filesystem", "tools"]) });
    harness.registry.register(
      aStage({
        requiredCapabilities: ["filesystem"],
        execute: async () => ({ kind: "completed", output: "done" }),
      }),
    );

    const result = await harness.runner.run(harness.manifest.runId, "stage-a", {});
    expect(result.status).toBe("succeeded");
  });

  it("skips the check when no backend is bound", async () => {
    harness = await makeTempRun();
    harness.registry.register(
      aStage({
        requiredCapabilities: ["filesystem"],
        execute: async () => ({ kind: "completed", output: "done" }),
      }),
    );

    // A stage running in-process has no backend to interrogate. Requiring one would make every
    // deterministic Worker (§3.2) declare a backend it does not use.
    const result = await harness.runner.run(harness.manifest.runId, "stage-a", {});
    expect(result.status).toBe("succeeded");
  });
});
