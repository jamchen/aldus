/**
 * Registering an output from inside a stage (contract §8.1, ADR-0027).
 *
 * The behaviour these pin is that a stage states only what it knows, and the runner supplies the
 * rest. §8.1 requires an artifact to record which stage, run, code revision, and configuration
 * produced it — facts the attempt holds and the stage would otherwise have to repeat by hand.
 * Repeating them is where they drift.
 */

import { afterEach, describe, expect, it } from "vitest";

import { AldusError, type ArtifactRef } from "@aldus-runtime/core";

import type {
  ArtifactRecorder,
  ArtifactRecorderRequest,
  StageOutputRegistration,
} from "../src/definition.js";
import { StageRunnerErrorCodes } from "../src/errors.js";

import { aStage, anArtifact, makeTempRun, type TempRun } from "./helpers.js";

let temp: TempRun;

afterEach(async () => {
  await temp?.cleanup();
});

/** A recorder that remembers what it was asked, so a test can inspect the runner's half. */
function recordingRecorder(): ArtifactRecorder & { requests: ArtifactRecorderRequest[] } {
  const requests: ArtifactRecorderRequest[] = [];
  return {
    requests,
    async register(request) {
      requests.push(request);
      // A plausible ArtifactRef, built from what the runner supplied rather than invented, so a
      // test asserting on provenance is asserting on the runner's contribution.
      const artifact: ArtifactRef = anArtifact({
        kind: request.kind,
        mediaType: request.mediaType,
        reconstructability: request.reconstructability,
        producerRunId: request.producerRunId,
        producerStageId: request.producerStageId,
        inputHashes: [...(request.inputHashes ?? [])],
      });
      return artifact;
    },
  };
}

describe("registerOutput", () => {
  it("attributes the artifact to the attempt, without the stage naming it", async () => {
    const artifacts = recordingRecorder();
    temp = await makeTempRun({ artifacts });

    temp.registry.register(
      aStage({
        id: "stage-a",
        artifacts: {
          produces: "declared",
          resolve: () => [{ kind: "ApprovedAudio", minCount: 1, maxCount: 1 }],
        },
        execute: async (context) => {
          // Note what is *not* passed: no run id, no stage id, no code revision, no config hash.
          await context.registerOutput({
            path: "/tmp/does-not-need-to-exist.wav",
            kind: "ApprovedAudio",
            mediaType: "audio/wav",
            reconstructability: "irreplaceable",
          });
          return { kind: "completed", output: undefined };
        },
      }),
    );

    const result = await temp.runner.run(temp.manifest.runId, "stage-a", undefined);
    expect(result.status).toBe("succeeded");

    const request = artifacts.requests[0];
    expect(request).toBeDefined();
    expect(request?.producerRunId).toBe(temp.manifest.runId);
    expect(request?.producerStageId).toBe("stage-a");
    // §11, §20: the configuration digest is the attempt's, so trace can answer which
    // configuration produced the bytes.
    expect(request?.configHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("carries the Run's code revision, which the stage never sees", async () => {
    const artifacts = recordingRecorder();
    temp = await makeTempRun({ artifacts });

    // §8.1 lists code revision among what an artifact MUST record. It lives on the Run manifest,
    // not on the stage, so only the runner can supply it.
    const withRevision = { ...temp.manifest, codeRevision: "rev-abc123" };
    await temp.workspace.runs.update(withRevision.runId, () => withRevision);

    temp.registry.register(
      aStage({
        id: "stage-a",
        artifacts: {
          produces: "declared",
          resolve: () => [{ kind: "RenderManifest", minCount: 1, maxCount: 1 }],
        },
        execute: async (context) => {
          await context.registerOutput({
            path: "/tmp/out.bin",
            kind: "RenderManifest",
            mediaType: "application/json",
            reconstructability: "reproducible",
          });
          return { kind: "completed", output: undefined };
        },
      }),
    );

    await temp.runner.run(temp.manifest.runId, "stage-a", undefined);
    expect(artifacts.requests[0]?.codeRevision).toBe("rev-abc123");
  });

  it("records the artifact on the attempt, so it is not lost", async () => {
    const artifacts = recordingRecorder();
    temp = await makeTempRun({ artifacts });

    temp.registry.register(
      aStage({
        id: "stage-a",
        artifacts: {
          produces: "declared",
          resolve: () => [{ kind: "ApprovedAudio", minCount: 1, maxCount: 1 }],
        },
        execute: async (context) => {
          await context.registerOutput({
            path: "/tmp/out.bin",
            kind: "ApprovedAudio",
            mediaType: "audio/wav",
            reconstructability: "irreplaceable",
          });
          return { kind: "completed", output: undefined };
        },
      }),
    );

    const result = await temp.runner.run(temp.manifest.runId, "stage-a", undefined);
    // One call, not two: registering also records, so a stage never has to do both for one file
    // and cannot half-do it.
    expect(result.outputArtifacts).toHaveLength(1);
    expect(result.outputArtifacts[0]?.kind).toBe("ApprovedAudio");
  });

  it("keeps outputs registered before a later failure (contract §19.1)", async () => {
    const artifacts = recordingRecorder();
    temp = await makeTempRun({ artifacts });

    temp.registry.register(
      aStage({
        id: "stage-a",
        idempotency: { kind: "not_idempotent", reason: "writes a file" },
        execute: async (context) => {
          await context.registerOutput({
            path: "/tmp/first.bin",
            kind: "HostNarration",
            mediaType: "text/plain",
            reconstructability: "reproducible",
          });
          throw new Error("failed after producing one artifact");
        },
      }),
    );

    const result = await temp.runner.run(temp.manifest.runId, "stage-a", undefined);
    expect(result.status).toBe("failed");
    // §19.1 "recovery from partial success": the next attempt must not re-do work whose result
    // already exists.
    expect(result.outputArtifacts).toHaveLength(1);
  });

  it("refuses when no recorder is wired, rather than silently doing nothing", async () => {
    temp = await makeTempRun(); // deliberately no `artifacts`

    let thrown: unknown;
    temp.registry.register(
      aStage({
        id: "stage-a",
        artifacts: {
          produces: "declared",
          resolve: () => [{ kind: "ApprovedAudio", minCount: 1, maxCount: 1 }],
        },
        execute: async (context) => {
          try {
            await context.registerOutput({
              path: "/tmp/out.bin",
              kind: "ApprovedAudio",
              mediaType: "audio/wav",
              reconstructability: "irreplaceable",
            });
          } catch (error) {
            thrown = error;
            throw error;
          }
          return { kind: "completed", output: undefined };
        },
      }),
    );

    const result = await temp.runner.run(temp.manifest.runId, "stage-a", undefined);
    expect(result.status).toBe("failed");
    expect(thrown).toBeInstanceOf(AldusError);
    const error = thrown as AldusError;
    expect(error.code).toBe(StageRunnerErrorCodes.ARTIFACT_RECORDER_UNAVAILABLE);
    // Not retryable: no approval an operator could grant makes a recorder appear.
    expect(error.retryable).toBe(false);
  });
});

describe("recordOutput is unchanged", () => {
  it("still accepts an artifact the stage obtained for itself", async () => {
    temp = await makeTempRun();
    const artifact = anArtifact();

    temp.registry.register(
      aStage({
        id: "stage-a",
        artifacts: {
          produces: "declared",
          resolve: () => [{ kind: "CanonicalScript", minCount: 1, maxCount: 1 }],
        },
        execute: async (context) => {
          context.recordOutput(artifact);
          return { kind: "completed", output: undefined };
        },
      }),
    );

    const result = await temp.runner.run(temp.manifest.runId, "stage-a", undefined);
    expect(result.status).toBe("succeeded");
    expect(result.outputArtifacts).toEqual([artifact]);
  });

  it("works without a recorder wired, as it always has", async () => {
    // The 0.1.0 shape: a stage closed over its own registry and called recordOutput. Adopters
    // doing that must keep working untouched.
    temp = await makeTempRun();
    temp.registry.register(
      aStage({
        id: "stage-a",
        artifacts: {
          produces: "declared",
          resolve: () => [{ kind: "CanonicalScript", minCount: 1, maxCount: 1 }],
        },
        execute: async (context) => {
          context.recordOutput(anArtifact());
          return { kind: "completed", output: undefined };
        },
      }),
    );
    const result = await temp.runner.run(temp.manifest.runId, "stage-a", undefined);
    expect(result.status).toBe("succeeded");
  });
});

describe("a stage cannot contradict the attempt", () => {
  it("has no field in which to state provenance the runner owns", () => {
    // The strongest available answer to "what if a stage lies about provenance?": it has nowhere
    // to write the lie. These are compile-time assertions, and `typecheck:test` enforces them
    // both ways — an unused @ts-expect-error is itself an error, so if any of these fields ever
    // becomes settable this stops compiling.
    const base: StageOutputRegistration = {
      path: "/tmp/out.bin",
      kind: "ApprovedAudio",
      mediaType: "audio/wav",
      reconstructability: "irreplaceable",
    };

    const withRun: StageOutputRegistration = {
      ...base,
      // @ts-expect-error producerRunId comes from the attempt, never from the stage (§8.1).
      producerRunId: "run-somewhere-else",
    };
    const withStage: StageOutputRegistration = {
      ...base,
      // @ts-expect-error producerStageId comes from the attempt (§8.1).
      producerStageId: "a-different-stage",
    };
    const withDigest: StageOutputRegistration = {
      ...base,
      // @ts-expect-error the digest is computed from the bytes, never supplied (§8.1, §13).
      sha256: "0".repeat(64),
    };
    const withConfigHash: StageOutputRegistration = {
      ...base,
      // @ts-expect-error the configuration digest is the attempt's (§11, §20).
      configHash: "0".repeat(64),
    };

    for (const registration of [withRun, withStage, withDigest, withConfigHash]) {
      expect(registration.path).toBe("/tmp/out.bin");
    }
  });
});
