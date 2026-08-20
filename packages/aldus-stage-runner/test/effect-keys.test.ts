/**
 * The required tests of the #148 and #149 rulings (§19.1; ADR-0036, ADR-0043).
 *
 * Two rulings, one contract change: removing an unsafe fallback and introducing correctly scoped
 * keys are halves of the same thing, so they are covered together and in the rulings' order.
 *
 * The defect being closed is silent and looks like success. A stage performing N external writes
 * handed the platform N requests carrying one key; a platform deduplicating on it drops writes
 * 2..N as repeats of the first. Every call returns successfully and N-1 of them did nothing.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { WorkerRequest } from "../src/worker.js";
import { WorkerRegistry } from "../src/worker.js";

import { aStage, makeTempRun, type TempRun } from "./helpers.js";

let temp: TempRun;
let seen: WorkerRequest[];

/** A Worker that records exactly what the runtime handed it. */
function recordingWorkers(): WorkerRegistry {
  const registry = new WorkerRegistry();
  registry.register({
    id: "probe",
    version: "1",
    capabilities: () => Promise.resolve({ offers: [] }),
    execute: (request) => {
      seen.push(request as WorkerRequest);
      return Promise.resolve({ output: undefined });
    },
  });
  return registry;
}

beforeEach(async () => {
  seen = [];
  temp = await makeTempRun({ workers: recordingWorkers() });
});

afterEach(async () => {
  await temp.cleanup();
});

const call = (effect: unknown) => ({
  workerId: "probe",
  workerVersion: "1",
  input: {},
  effect,
});

describe("#149 — the fallback is gone", () => {
  it("1. a stage with no external-effect declaration gives its Worker no idempotency key", async () => {
    temp.registry.register(
      aStage({
        retrySafety: { kind: "no_external_effects" },
        execute: async (context) => {
          await context.runWorker(call({ kind: "none" }) as never);
          return { kind: "completed", output: undefined };
        },
      }),
    );

    const result = await temp.runner.run(temp.manifest.runId, "stage-a", {});

    expect(result.status).toBe("succeeded");
    // Absent, not empty-string and not a fingerprint. A Worker author checking whether the field
    // is populated used to get `true` in both the real case and the useless one.
    expect(seen[0]).not.toHaveProperty("idempotencyKey");
  });

  it("2. the invocation key is never passed as the Worker's idempotency key", async () => {
    temp.registry.register(
      aStage({
        retrySafety: { kind: "no_external_effects" },
        execute: async (context) => {
          await context.runWorker(call({ kind: "none" }) as never);
          return { kind: "completed", output: undefined };
        },
      }),
    );

    await temp.runner.run(temp.manifest.runId, "stage-a", {});

    const stored = await temp.runner.stageExecution(temp.manifest.runId, "stage-a");
    const attemptId = stored?.execution.attempts.at(-1)?.attemptId ?? "";
    const invocationKey = stored?.metadata[attemptId]?.invocationKey;

    // The fingerprint still exists in the trace — it is a production-trace value, not a credential.
    expect(invocationKey).toBeTruthy();
    expect(seen[0]?.idempotencyKey).toBeUndefined();
    expect(seen[0]?.idempotencyKey).not.toBe(invocationKey);
  });

  it("3. two Workers in one attempt are not automatically given the same key", async () => {
    temp.registry.register(
      aStage({
        retrySafety: {
          kind: "deduplicated_external_effects",
          keyScope: "worker_invocation",
          reason: "each object is addressed by its own content digest",
        },
        execute: async (context) => {
          await context.runWorker(call({ kind: "deduplicated", idempotencyKey: "obj-a" }) as never);
          await context.runWorker(call({ kind: "deduplicated", idempotencyKey: "obj-b" }) as never);
          return { kind: "completed", output: undefined };
        },
      }),
    );

    const result = await temp.runner.run(temp.manifest.runId, "stage-a", {});

    expect(result.status).toBe("succeeded");
    expect(seen.map((request) => request.idempotencyKey)).toEqual(["obj-a", "obj-b"]);
  });

  it("4. an invocation carrying an explicit key receives that exact key", async () => {
    temp.registry.register(
      aStage({
        retrySafety: {
          kind: "deduplicated_external_effects",
          keyScope: "stage",
          effectKey: () => "the-stage-key",
        },
        execute: async (context) => {
          await context.runWorker(
            call({ kind: "deduplicated", idempotencyKey: "the-effect-key" }) as never,
          );
          return { kind: "completed", output: undefined };
        },
      }),
    );

    await temp.runner.run(temp.manifest.runId, "stage-a", {});

    // The invocation's own key, not the stage's. They have different cardinalities and the
    // invocation is the one that identifies this effect.
    expect(seen[0]?.idempotencyKey).toBe("the-effect-key");
  });

  it("5. an empty inputArtifacts set does not manufacture a key", async () => {
    // The measured condition: a stage with an empty input schema and no declared artifacts has
    // `configurationHash = sha256("{}")`, `inputHashes = []`, and an invocation key constant for
    // the life of the stage version. None of those may become a deduplication credential.
    temp.registry.register(
      aStage({
        retrySafety: { kind: "no_external_effects" },
        execute: async (context) => {
          await context.runWorker(call({ kind: "none" }) as never);
          return { kind: "completed", output: undefined };
        },
      }),
    );

    await temp.runner.run(temp.manifest.runId, "stage-a", {});

    expect(seen[0]?.inputHashes).toEqual([]);
    expect(seen[0]?.idempotencyKey).toBeUndefined();
  });
});

describe("#148 — keys are scoped to the effect", () => {
  it("6. a pure stage is refused when it asks a Worker for an external effect", async () => {
    temp.registry.register(
      aStage({
        retrySafety: { kind: "no_external_effects" },
        execute: async (context) => {
          await context.runWorker(call({ kind: "deduplicated", idempotencyKey: "k" }) as never);
          return { kind: "completed", output: undefined };
        },
      }),
    );

    const result = await temp.runner.run(temp.manifest.runId, "stage-a", {});

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("ALDUS_STAGE_EFFECT_UNDECLARED");
    // Refused before the Worker ran, not reported after it wrote somewhere.
    expect(seen).toHaveLength(0);
  });

  it("7. one stage may make N Worker calls with N independent keys", async () => {
    const keys = ["sha-1", "sha-2", "sha-3"];
    temp.registry.register(
      aStage({
        retrySafety: {
          kind: "deduplicated_external_effects",
          keyScope: "worker_invocation",
          reason: "content-addressed objects, no update and no delete at the destination",
        },
        execute: async (context) => {
          for (const key of keys) {
            await context.runWorker(call({ kind: "deduplicated", idempotencyKey: key }) as never);
          }
          return { kind: "completed", output: undefined };
        },
      }),
    );

    const result = await temp.runner.run(temp.manifest.runId, "stage-a", {});

    expect(result.status).toBe("succeeded");
    expect(seen.map((request) => request.idempotencyKey)).toEqual(keys);
  });

  it("8. a stage-scoped key is refused the moment it would cover a second effect", async () => {
    temp.registry.register(
      aStage({
        retrySafety: {
          kind: "deduplicated_external_effects",
          keyScope: "stage",
          effectKey: () => "one-effect",
        },
        execute: async (context) => {
          await context.runWorker(call({ kind: "deduplicated", idempotencyKey: "a" }) as never);
          await context.runWorker(call({ kind: "deduplicated", idempotencyKey: "b" }) as never);
          return { kind: "completed", output: undefined };
        },
      }),
    );

    const result = await temp.runner.run(temp.manifest.runId, "stage-a", {});

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("ALDUS_STAGE_EFFECT_SCOPE_EXCEEDED");
    // The first effect was performed — it was legitimate — and the second was refused.
    expect(seen).toHaveLength(1);
  });

  it("9. a not_idempotent stage stays non-retryable even when a Worker call carries a key", async () => {
    let attempts = 0;
    temp.registry.register(
      aStage({
        retrySafety: { kind: "not_idempotent", reason: "the destination cannot deduplicate" },
        retryPolicy: { maxAttempts: 3 },
        execute: async (context) => {
          attempts += 1;
          await context.runWorker(call({ kind: "deduplicated", idempotencyKey: "k" }) as never);
          throw new Error("fails every time");
        },
      }),
    );

    const result = await temp.runner.run(temp.manifest.runId, "stage-a", {});

    expect(result.status).toBe("failed");
    // A keyed call inside an unkeyed whole is still an unkeyed whole.
    expect(attempts).toBe(1);
  });

  it("10. an undeclared effect is refused rather than crashing on a missing field", async () => {
    // The request that did not come through the type: built from configuration, or written by a
    // JavaScript adopter. Without this the field reads throw a TypeError the runner reports as an
    // ordinary stage failure, which tells the author nothing about what they left out.
    temp.registry.register(
      aStage({
        retrySafety: { kind: "no_external_effects" },
        execute: async (context) => {
          await context.runWorker({
            workerId: "probe",
            workerVersion: "1",
            input: {},
          } as never);
          return { kind: "completed", output: undefined };
        },
      }),
    );

    const result = await temp.runner.run(temp.manifest.runId, "stage-a", {});

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("ALDUS_STAGE_EFFECT_UNDECLARED");
  });

  it("11. the retry decision reads the declaration and its reason", async () => {
    // The ruling is explicit that recording for a later audit is insufficient. This asserts the
    // declaration and reason are on the attempt where a retry decision can read them.
    temp.registry.register(
      aStage({
        retrySafety: {
          kind: "deduplicated_external_effects",
          keyScope: "worker_invocation",
          reason: "each object is addressed by its own content digest",
        },
        execute: async () => ({ kind: "completed", output: undefined }),
      }),
    );

    await temp.runner.run(temp.manifest.runId, "stage-a", {});

    const stored = await temp.runner.stageExecution(temp.manifest.runId, "stage-a");
    const attemptId = stored?.execution.attempts.at(-1)?.attemptId ?? "";
    const metadata = stored?.metadata[attemptId];

    expect(metadata?.retrySafety).toBe("deduplicated_external_effects");
    expect(metadata?.effectKeyScope).toBe("worker_invocation");
    expect(metadata?.retrySafetyReason).toBe("each object is addressed by its own content digest");
  });

  it("12. a content-addressed archive uses each artifact digest as its own key", async () => {
    // The case that motivated both rulings: N uploads, each deduplicated individually at the
    // destination. Per-invocation keys are what make it expressible.
    const digests = ["a".repeat(64), "b".repeat(64)];
    temp.registry.register(
      aStage({
        retrySafety: {
          kind: "deduplicated_external_effects",
          keyScope: "worker_invocation",
          reason: "objects are addressed by digest and the seam has no update or delete",
        },
        execute: async (context) => {
          for (const digest of digests) {
            await context.runWorker(
              call({ kind: "deduplicated", idempotencyKey: `archive-${digest}` }) as never,
            );
          }
          return { kind: "completed", output: undefined };
        },
      }),
    );

    await temp.runner.run(temp.manifest.runId, "stage-a", {});

    expect(seen.map((request) => request.idempotencyKey)).toEqual(
      digests.map((digest) => `archive-${digest}`),
    );
    // No Run-enclosure digest anywhere: each key names its own object's content, and adding an
    // unrelated artifact to the Run would move none of them.
    for (const request of seen) {
      expect(request.idempotencyKey).not.toContain(temp.manifest.runId);
    }
  });
});
