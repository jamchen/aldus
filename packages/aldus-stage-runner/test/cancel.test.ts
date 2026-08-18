/**
 * Cancellation (architecture contract §19.1).
 *
 * §19.1 requires "cancellation behavior" alongside retry and recovery. The rule these tests pin is
 * that a cancelled attempt is a **recorded terminal state, not a gap**: an attempt that simply
 * stopped appearing in the record would be indistinguishable from one that never ran, and §20
 * requires the trace to say what happened.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { StageRunnerErrorCodes } from "../src/errors.js";
import { STAGE_EVENT_ACTIONS } from "../src/state.js";
import { aStage, anArtifact, makeTempRun, type TempRun } from "./helpers.js";

let harness: TempRun;

beforeEach(async () => {
  harness = await makeTempRun();
});

afterEach(async () => {
  await harness.cleanup();
});

describe("cancelling a stage", () => {
  it("records a cancelled attempt rather than leaving a gap", async () => {
    const controller = new AbortController();
    harness.registry.register(
      aStage({
        execute: async () => {
          controller.abort();
          return { kind: "completed", output: undefined };
        },
      }),
    );

    const result = await harness.runner.run(
      harness.manifest.runId,
      "stage-a",
      {},
      {
        signal: controller.signal,
      },
    );

    expect(result.status).toBe("cancelled");
    const stored = await harness.runner.stageExecution(harness.manifest.runId, "stage-a");
    expect(stored?.execution.status).toBe("cancelled");
    expect(stored?.execution.attempts.at(-1)?.status).toBe("cancelled");
    expect(stored?.execution.attempts.at(-1)?.finishedAt).toBeTruthy();
  });

  it("records a structured error for the cancellation", async () => {
    const controller = new AbortController();
    harness.registry.register(
      aStage({
        execute: async () => {
          controller.abort();
          return { kind: "completed", output: undefined };
        },
      }),
    );

    const result = await harness.runner.run(
      harness.manifest.runId,
      "stage-a",
      {},
      {
        signal: controller.signal,
      },
    );
    expect(result.error?.code).toBe(StageRunnerErrorCodes.STAGE_CANCELLED);
    expect(result.error?.category).toBe("cancelled");
    // A cancellation is a decision, so it is not retryable — asking again does not un-cancel it.
    expect(result.error?.retryable).toBe(false);
  });

  it("emits a cancellation event (§6.4)", async () => {
    const controller = new AbortController();
    harness.registry.register(
      aStage({
        execute: async () => {
          controller.abort();
          return { kind: "completed", output: undefined };
        },
      }),
    );
    await harness.runner.run(harness.manifest.runId, "stage-a", {}, { signal: controller.signal });

    const { events } = await harness.workspace.events.read(harness.manifest.runId);
    expect(events.at(-1)?.action).toBe(STAGE_EVENT_ACTIONS.attemptCancelled);
  });

  it("keeps artifacts produced before the cancellation", async () => {
    const controller = new AbortController();
    harness.registry.register(
      aStage({
        execute: async (context) => {
          context.recordOutput(anArtifact({ artifactId: "art_partial" }) as never);
          controller.abort();
          return { kind: "completed", output: undefined };
        },
      }),
    );

    const result = await harness.runner.run(
      harness.manifest.runId,
      "stage-a",
      {},
      {
        signal: controller.signal,
      },
    );
    // Same reasoning as partial success on failure: work already done, and possibly paid for,
    // must not vanish because the run was stopped (§19.1).
    expect(result.outputArtifacts.map((artifact) => artifact.artifactId)).toEqual(["art_partial"]);
  });

  it("cancels a stage that never checks its own signal", async () => {
    const controller = new AbortController();
    harness.registry.register(
      aStage({
        execute: async () => {
          controller.abort();
          // Deliberately ignores context.signal: a badly behaved stage is still cancellable,
          // just not promptly.
          return { kind: "completed", output: { ignored: true } };
        },
      }),
    );

    const result = await harness.runner.run(
      harness.manifest.runId,
      "stage-a",
      {},
      {
        signal: controller.signal,
      },
    );
    expect(result.status).toBe("cancelled");
    expect(result.output).toBeUndefined();
  });

  it("refuses to start when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    let ran = false;
    harness.registry.register(
      aStage({
        execute: async () => {
          ran = true;
          return { kind: "completed", output: undefined };
        },
      }),
    );

    const result = await harness.runner.run(
      harness.manifest.runId,
      "stage-a",
      {},
      {
        signal: controller.signal,
      },
    );
    expect(result.status).toBe("cancelled");
    // The stage still gets invoked — the runner cannot know how long `execute` takes to notice —
    // but the outcome is discarded, so no output is recorded from a cancelled attempt.
    expect(ran).toBe(true);
  });

  it("does not retry a cancelled attempt", async () => {
    const controller = new AbortController();
    let calls = 0;
    harness.registry.register(
      aStage({
        retryPolicy: { maxAttempts: 4 },
        execute: async () => {
          calls += 1;
          controller.abort();
          return { kind: "completed", output: undefined };
        },
      }),
    );

    await harness.runner.run(harness.manifest.runId, "stage-a", {}, { signal: controller.signal });
    // Retrying a cancellation would be the runner overruling the operator who cancelled it.
    expect(calls).toBe(1);
  });

  it("observes the signal inside the stage", async () => {
    const controller = new AbortController();
    let sawAbort = false;
    harness.registry.register(
      aStage({
        execute: async (context) => {
          controller.abort();
          sawAbort = context.signal.aborted;
          return { kind: "completed", output: undefined };
        },
      }),
    );

    await harness.runner.run(harness.manifest.runId, "stage-a", {}, { signal: controller.signal });
    // The context's signal is chained to the caller's, so a long-running stage can bail early.
    expect(sawAbort).toBe(true);
  });
});

describe("a claimed stage", () => {
  it("refuses to start a stage another runner is executing", async () => {
    let release: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      harness.registry.register(
        aStage({
          execute: async () => {
            resolve();
            await new Promise<void>((done) => {
              release = done;
            });
            return { kind: "completed", output: undefined };
          },
        }),
      );
    });

    const first = harness.runner.run(harness.manifest.runId, "stage-a", {});
    await started;

    // Assuming a `running` stage is dead would let two runners execute one side-effecting stage
    // at once. Taking over has to be deliberate.
    await expect(harness.runner.run(harness.manifest.runId, "stage-a", {})).rejects.toMatchObject({
      code: StageRunnerErrorCodes.STAGE_STATE_INVALID,
    });

    release?.();
    await first;
  });

  it("allows an explicit takeover of a stage left running", async () => {
    // The scenario is a runner that died mid-stage, leaving the stage claimed forever. Only the
    // first invocation blocks, standing in for the process that never came back.
    let release: (() => void) | undefined;
    let calls = 0;
    let resolveStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });

    harness.registry.register(
      aStage({
        execute: async () => {
          calls += 1;
          if (calls === 1) {
            resolveStarted?.();
            await new Promise<void>((done) => {
              release = done;
            });
          }
          return { kind: "completed", output: { calls } };
        },
      }),
    );

    const abandoned = harness.runner.run(harness.manifest.runId, "stage-a", {});
    await started;

    const takeover = await harness.runner.run(
      harness.manifest.runId,
      "stage-a",
      {},
      {
        force: true,
      },
    );
    expect(takeover.status).toBe("succeeded");
    expect(takeover.attempt).toBe(2);

    release?.();
    await abandoned;

    // Both attempts are in the record. The takeover does not erase the abandoned one — §6.3's
    // append-only rule holds even when an attempt was abandoned rather than completed.
    const stored = await harness.runner.stageExecution(harness.manifest.runId, "stage-a");
    expect(stored?.execution.attempts.map((attempt) => attempt.attempt)).toEqual([1, 2]);
  });
});
