/**
 * A stage invoking a registered Worker through the runner (contract §3.2, §4.1; ADR-0035).
 *
 * §3.2 tells adopters to prefer a Worker over an Agent, and until #111 only the Agent half had a
 * seam. These cover the composed path: resolution by exact version, the capability check that runs
 * before `execute`, the refusal when nothing is wired, and the identity the runtime supplies so a
 * Worker cannot state its own provenance.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { StageRunnerErrorCodes } from "../src/errors.js";
import { WorkerRegistry, type Worker, type WorkerRequest } from "../src/worker.js";
import { aStage, makeTempRun, type TempRun } from "./helpers.js";

let harness: TempRun;

beforeEach(async () => {
  harness = await makeTempRun();
});

afterEach(async () => {
  await harness.cleanup();
});

/** A Worker that records what it was handed. */
function recordingWorker(overrides: Partial<Worker> = {}): Worker & { seen: WorkerRequest[] } {
  const seen: WorkerRequest[] = [];
  return {
    id: "checksum",
    version: "1",
    capabilities: () => Promise.resolve({ offers: ["filesystem.read"] }),
    execute: (request) => {
      seen.push(request);
      return Promise.resolve({ output: { ok: true } });
    },
    seen,
    ...overrides,
  } as Worker & { seen: WorkerRequest[] };
}

describe("a stage invoking a Worker through the runner", () => {
  it("refuses when the composition wired no registry", async () => {
    harness.registry.register(
      aStage({
        execute: async (context) => {
          await context.runWorker({
            workerId: "checksum",
            workerVersion: "1",
            input: {},
            effect: { kind: "none" },
          });
          return { kind: "completed", output: undefined };
        },
      }),
    );

    const result = await harness.runner.run(harness.manifest.runId, "stage-a", {});

    // Refused, not silently skipped. A capability reachable on the context and unusable from every
    // stage is #67, and a Worker seam nothing wired would be the same defect one layer up.
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe(StageRunnerErrorCodes.WORKER_REGISTRY_UNAVAILABLE);
  });

  it("supplies the attempt's identity, so a Worker cannot state its own", async () => {
    const worker = recordingWorker();
    const workers = new WorkerRegistry();
    workers.register(worker);
    const temp = await makeTempRun({ workers });
    temp.registry.register(
      aStage({
        execute: async (context) => {
          await context.runWorker({
            workerId: "checksum",
            workerVersion: "1",
            input: { path: "a.wav" },
            requiredCapabilities: ["filesystem.read"],
            effect: { kind: "none" },
          });
          return { kind: "completed", output: undefined };
        },
      }),
    );

    await temp.runner.run(temp.manifest.runId, "stage-a", {});

    const request = worker.seen[0];
    expect(request?.runId).toBe(temp.manifest.runId);
    expect(request?.episodeId).toBe(temp.manifest.episode.episodeId);
    expect(request?.stageId).toBe("stage-a");
    expect(request?.attemptId).toBeTypeOf("string");
    expect(request?.signal).toBeInstanceOf(AbortSignal);
    // The input it was given, and nothing letting it claim a different one.
    expect(request?.input).toEqual({ path: "a.wav" });
    await temp.cleanup();
  });

  it("checks capabilities before execute, not after", async () => {
    const worker = recordingWorker({
      capabilities: () => Promise.resolve({ offers: [] }),
    });
    const workers = new WorkerRegistry();
    workers.register(worker);
    const temp = await makeTempRun({ workers });
    temp.registry.register(
      aStage({
        execute: async (context) => {
          await context.runWorker({
            workerId: "checksum",
            workerVersion: "1",
            input: {},
            requiredCapabilities: ["network.write"],
            effect: { kind: "none" },
          });
          return { kind: "completed", output: undefined };
        },
      }),
    );

    const result = await temp.runner.run(temp.manifest.runId, "stage-a", {});

    expect(result.error?.code).toBe(StageRunnerErrorCodes.WORKER_CAPABILITY_UNAVAILABLE);
    // The load-bearing half: it never ran. A capability check after the side effect is decoration.
    expect(worker.seen).toEqual([]);
    await temp.cleanup();
  });

  it("resolves an exact version and refuses a near one", async () => {
    const workers = new WorkerRegistry();
    workers.register(recordingWorker({ version: "2" }));
    const temp = await makeTempRun({ workers });
    temp.registry.register(
      aStage({
        execute: async (context) => {
          await context.runWorker({
            workerId: "checksum",
            workerVersion: "1",
            input: {},
            effect: { kind: "none" },
          });
          return { kind: "completed", output: undefined };
        },
      }),
    );

    const result = await temp.runner.run(temp.manifest.runId, "stage-a", {});

    // §20: a Run that invoked `1` must stay readable after `2` is registered, so nothing selects a
    // nearest or latest version on the caller's behalf.
    expect(result.error?.code).toBe(StageRunnerErrorCodes.WORKER_NOT_REGISTERED);
    await temp.cleanup();
  });

  it("records which Worker ran, in the trace", async () => {
    const workers = new WorkerRegistry();
    workers.register(recordingWorker());
    const temp = await makeTempRun({ workers });
    temp.registry.register(
      aStage({
        execute: async (context) => {
          await context.runWorker({
            workerId: "checksum",
            workerVersion: "1",
            input: {},
            requiredCapabilities: ["filesystem.read"],
            effect: { kind: "none" },
          });
          return { kind: "completed", output: undefined };
        },
      }),
    );

    await temp.runner.run(temp.manifest.runId, "stage-a", {});

    const stored = await temp.runner.stageExecution(temp.manifest.runId, "stage-a");
    const attemptId = stored?.execution.attempts.at(-1)?.attemptId ?? "";
    const notes = stored?.metadata[attemptId]?.notes ?? [];
    expect(notes.some((note) => note.includes("checksum@1"))).toBe(true);
    // What was checked of it, not only that it ran.
    expect(notes.some((note) => note.includes("filesystem.read"))).toBe(true);
    await temp.cleanup();
  });
});
