/**
 * The Worker doubles, exercised through the real seam (ADR-0035).
 *
 * A double nobody drives through the runner is a shape, not a double — so these run each one
 * through `StageContext.runWorker` rather than calling it directly.
 */

import { afterEach, describe, expect, it } from "vitest";

import { cancellableWorker, failingWorker, recordingWorker } from "../src/doubles.js";
import { StageRunnerErrorCodes } from "../src/errors.js";
import { WorkerRegistry } from "../src/worker.js";
import { aStage, makeTempRun, type TempRun } from "./helpers.js";

let harness: TempRun;

afterEach(async () => {
  await harness.cleanup();
});

/** Run one stage that invokes a Worker, and return the run result. */
async function runWith(worker: Parameters<WorkerRegistry["register"]>[0], required: string[] = []) {
  const workers = new WorkerRegistry();
  workers.register(worker);
  harness = await makeTempRun({ workers });
  harness.registry.register(
    aStage({
      execute: async (context) => {
        await context.runWorker({
          workerId: worker.id,
          workerVersion: worker.version,
          input: { probe: true },
          requiredCapabilities: required,
          effect: { kind: "none" },
          spend: { expectation: { kind: "free" } },
        });
        return { kind: "completed", output: undefined };
      },
    }),
  );
  return harness.runner.run(harness.manifest.runId, "stage-a", {});
}

describe("recordingWorker", () => {
  it("records the identity the runtime supplied, not what the Worker claims", async () => {
    const worker = recordingWorker();
    const result = await runWith(worker);

    expect(result.status).toBe("succeeded");
    const call = worker.calls[0];
    expect(call?.runId).toBe(harness.manifest.runId);
    expect(call?.stageId).toBe("stage-a");
    expect(call?.attemptId).toBeTypeOf("string");
    expect(call?.input).toEqual({ probe: true });
  });

  it("offers nothing by default, so a capability check can be observed refusing", async () => {
    // The property that makes the default useful. A double offering everything would make every
    // capability test pass, including the ones written to prove refusal (ADR-0030).
    const worker = recordingWorker();
    const result = await runWith(worker, ["filesystem.read"]);

    expect(result.error?.code).toBe(StageRunnerErrorCodes.WORKER_CAPABILITY_UNAVAILABLE);
    expect(worker.calls).toEqual([]);
    expect(worker.capabilityChecks).toBe(1);
  });
});

describe("failingWorker", () => {
  it("fails the stage rather than returning failure as data", async () => {
    const result = await runWith(failingWorker({ message: "render exploded" }));
    expect(result.status).toBe("failed");
  });
});

describe("cancellableWorker", () => {
  it("observes the signal rather than a timer the test controls", async () => {
    // A double ignoring `request.signal` would let a Stage pass a cancellation test it would fail
    // in production, which is the one thing a cancellation double must not do.
    const workers = new WorkerRegistry();
    const worker = cancellableWorker();
    workers.register(worker);
    harness = await makeTempRun({ workers });
    const controller = new AbortController();
    harness.registry.register(
      aStage({
        execute: async (context) => {
          queueMicrotask(() => controller.abort(new Error("operator cancelled")));
          await context.runWorker({
            workerId: worker.id,
            workerVersion: worker.version,
            input: {},
            effect: { kind: "none" },
            spend: { expectation: { kind: "free" } },
          });
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
  });
});
