/**
 * A Stage invoking a Worker through the composed service stack (#111 acceptance criterion 13).
 *
 * The runner-level tests construct a `StageRunner` directly, which is the composition an adopter
 * never writes. This one goes through `AldusServices` — `init`, `startRun`, `runStage` — so what
 * it proves is that the seam survives the wiring rather than that the class works.
 *
 * That distinction is not academic here. The Worker contract, its registry and the capability
 * check were complete, tested and merged while nobody outside the package could construct a
 * registry (#121), and `loadConfig` refused the config key that would have supplied one (#123).
 * Both were invisible to a test that built the runner itself.
 */

import { afterEach, describe, expect, it } from "vitest";

import { recordingWorker, WorkerRegistry } from "@aldus-runtime/stage-runner";

import { makeStack, type Stack } from "../src/index.js";

/** Accepts anything: the stage's input is not what these tests are about. */
const anySchema = { safeParse: (value: unknown) => ({ success: true as const, data: value }) };

const SHOW_ID = "example-show";
const RUN_ID = "run-composed-worker";
const OPERATOR = { kind: "human", id: "operator-a" } as const;

let stack: Stack;

afterEach(async () => {
  await stack?.cleanup();
});

/** A stage whose whole body is one Worker invocation, so the seam is what is under test. */
function invokingStage(worker: { id: string; version: string }, required: string[] = []) {
  return {
    id: "checksum",
    version: "1",
    inputSchema: anySchema,
    outputSchema: anySchema,
    requiredCapabilities: [],
    artifacts: { produces: "none" },
    retrySafety: { kind: "no_external_effects" as const },
    execute: async (context: {
      runWorker: (request: Record<string, unknown>) => Promise<{ output: unknown }>;
    }) => {
      const result = await context.runWorker({
        workerId: worker.id,
        workerVersion: worker.version,
        input: { path: "take.wav" },
        requiredCapabilities: required,
        effect: { kind: "none" },
      });
      return { kind: "completed" as const, output: result.output };
    },
  };
}

async function stackWith(workers: WorkerRegistry, required: string[] = []) {
  const worker = { id: "checksum", version: "1" };
  stack = await makeStack({
    workers,
    stages: () => [invokingStage(worker, required) as never],
  });
  await stack.services.init({ episode: { showId: SHOW_ID, slug: "episode-a" }, actor: OPERATOR });
  await stack.services.startRun({
    workflowId: "workflow-a",
    workflowVersion: "1",
    runId: RUN_ID,
    actor: OPERATOR,
  });
  return stack;
}

describe("a Worker reached through the composed stack (#111)", () => {
  it("runs, and is handed the identity the composition knows", async () => {
    const worker = recordingWorker({ id: "checksum", version: "1", offers: ["filesystem.read"] });
    const registry = new WorkerRegistry();
    registry.register(worker);
    await stackWith(registry, ["filesystem.read"]);

    const result = await stack.services.runStage({
      runId: RUN_ID,
      stageId: "checksum",
      actor: OPERATOR,
    });

    expect(result.outcome).toBe("ok");
    expect(worker.calls).toHaveLength(1);
    // The identity came from the composed Run, not from anything the stage or Worker asserted.
    expect(worker.calls[0]?.runId).toBe(RUN_ID);
    expect(worker.calls[0]?.stageId).toBe("checksum");
    expect(worker.calls[0]?.episodeId).toContain(SHOW_ID);
  });

  it("refuses through the composition when the capability is missing, without running", async () => {
    const worker = recordingWorker({ id: "checksum", version: "1" });
    const registry = new WorkerRegistry();
    registry.register(worker);
    await stackWith(registry, ["network.write"]);

    const result = await stack.services.runStage({
      runId: RUN_ID,
      stageId: "checksum",
      actor: OPERATOR,
    });

    expect(result.outcome).not.toBe("ok");
    // The load-bearing half, through the real stack this time: the Worker never ran.
    expect(worker.calls).toEqual([]);
  });

  it("refuses when the composition wired no registry at all", async () => {
    // The #67 shape one layer up. An adopter who has not supplied workers gets a refusal rather
    // than a stage that silently does nothing — and this is the arrangement they are actually in
    // before they wire one.
    const worker = { id: "checksum", version: "1" };
    stack = await makeStack({ stages: () => [invokingStage(worker) as never] });
    await stack.services.init({ episode: { showId: SHOW_ID, slug: "episode-a" }, actor: OPERATOR });
    await stack.services.startRun({
      workflowId: "workflow-a",
      workflowVersion: "1",
      runId: RUN_ID,
      actor: OPERATOR,
    });

    const result = await stack.services.runStage({
      runId: RUN_ID,
      stageId: "checksum",
      actor: OPERATOR,
    });

    expect(result.outcome).not.toBe("ok");
  });
});
