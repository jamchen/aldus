/**
 * The stage-runner adapter (contract §8.1, ADR-0027).
 *
 * Two things worth pinning. First, that provenance the runner supplies actually lands on the
 * record — §8.1 requires an artifact to state which stage, run, code revision, and configuration
 * produced it, and an adapter that dropped any of those would leave the field silently empty.
 * Second, that this package's request shape stays assignable to the port it exists to satisfy:
 * the two are structurally coupled and deliberately not linked by an import, so nothing but a
 * test would notice them drifting apart.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ArtifactRecorder, ArtifactRecorderRequest } from "@aldus-runtime/stage-runner";

import { digestFile } from "../src/digest.js";
import { ArtifactRegistry } from "../src/registry.js";
import {
  stageArtifactRecorder,
  type StageArtifactRecorder,
  type StageArtifactRequest,
} from "../src/stage-recorder.js";

import {
  makeRegistry,
  makeTempWorkspace,
  writeWorkingFile,
  type TempWorkspace,
} from "./helpers.js";

let workspace: TempWorkspace;
let registry: ArtifactRegistry;
let recorder: StageArtifactRecorder;

beforeEach(async () => {
  workspace = await makeTempWorkspace();
  registry = makeRegistry(workspace);
  recorder = stageArtifactRecorder(registry);
});

afterEach(async () => {
  await workspace.cleanup();
});

/** A request as the stage runner would build it: stage facts plus attempt facts. */
function request(
  path: string,
  overrides: Partial<StageArtifactRequest> = {},
): StageArtifactRequest {
  return {
    path,
    kind: "kind-a",
    mediaType: "application/octet-stream",
    reconstructability: "reproducible",
    producerRunId: "run-a",
    producerStageId: "stage-a",
    configHash: "a".repeat(64),
    ...overrides,
  };
}

describe("stageArtifactRecorder", () => {
  it("records the attempt's provenance, not the stage's word for it", async () => {
    const path = await writeWorkingFile(workspace, "working/out.bin", "bytes");

    const artifact = await recorder.register(
      request(path, {
        producerRunId: "run-b",
        producerStageId: "stage-b",
        codeRevision: "rev-abc123",
        configHash: "b".repeat(64),
        configuration: { redacted: true },
      }),
    );

    expect(artifact.producerRunId).toBe("run-b");
    expect(artifact.producerStageId).toBe("stage-b");

    // §8.1 names code revision and configuration explicitly. ArtifactRef has no field for either,
    // so they live on the registry record's provenance — and an adapter that dropped them would
    // leave §20 unable to answer "which code and configuration produced this".
    const record = await registry.require(artifact.artifactId);
    expect(record.provenance.codeRevision).toBe("rev-abc123");
    expect(record.provenance.configHash).toBe("b".repeat(64));
    expect(record.provenance.configuration).toEqual({ redacted: true });
  });

  it("computes the digest from the bytes (contract §8.1)", async () => {
    const path = await writeWorkingFile(workspace, "working/out.bin", "known contents");
    const expected = await digestFile(path);

    const artifact = await recorder.register(request(path));

    // §13 binds approvals to this digest, so it must describe the bytes rather than anything a
    // caller asserted. `StageArtifactRequest` has no field to assert it in.
    expect(artifact.sha256).toBe(expected.sha256);
    expect(artifact.sizeBytes).toBe(expected.sizeBytes);
  });

  it("carries the provenance only a stage knows", async () => {
    const path = await writeWorkingFile(workspace, "working/out.wav", "audio");

    const artifact = await recorder.register(
      request(path, {
        reconstructability: "irreplaceable",
        provenance: {
          providerSeed: "seed-a",
          knowledgePackIds: ["pack-a", "pack-b"],
          note: "second take",
        },
      }),
    );

    const record = await registry.require(artifact.artifactId);
    expect(record.provenance.providerSeed).toBe("seed-a");
    expect(record.provenance.knowledgePackIds).toEqual(["pack-a", "pack-b"]);
    expect(record.provenance.note).toBe("second take");
    // §8.1: this classification is what stops a cleanup removing bytes a human accepted.
    expect(artifact.reconstructability).toBe("irreplaceable");
  });

  it("defaults input hashes to none rather than treating them as missing", async () => {
    const path = await writeWorkingFile(workspace, "working/brief.json", "{}");
    const artifact = await recorder.register(request(path));
    // An empty list is a real state — an EpisodeBrief is derived from nothing inside the runtime.
    expect(artifact.inputHashes).toEqual([]);
  });

  it("registers the artifact, so it is findable afterwards", async () => {
    const path = await writeWorkingFile(workspace, "working/out.bin", "bytes");
    const artifact = await recorder.register(request(path));

    const found = await registry.get(artifact.artifactId);
    expect(found?.artifact.artifactId).toBe(artifact.artifactId);
  });
});

describe("port compatibility with @aldus-runtime/stage-runner", () => {
  // The adapter satisfies the runner's port structurally and deliberately does not import it:
  // the registry is the lower layer, and importing upward would invert the layering (ADR-0027).
  // Structural coupling with no import is invisible to the compiler at the definition site, so
  // it is asserted here instead — this file is the only place the two shapes meet.
  it("satisfies ArtifactRecorder", () => {
    const asPort: ArtifactRecorder = recorder;
    expect(typeof asPort.register).toBe("function");
  });

  it("accepts every request the runner can build", () => {
    // If the runner gains a required field this adapter does not model, this stops compiling.
    const fromRunner: ArtifactRecorderRequest = {
      path: "/tmp/out.bin",
      kind: "kind-a",
      mediaType: "application/octet-stream",
      reconstructability: "reproducible",
      producerRunId: "run-a",
      producerStageId: "stage-a",
      configHash: "a".repeat(64),
    };
    const asLocal: StageArtifactRequest = fromRunner;
    expect(asLocal.producerRunId).toBe("run-a");
  });
});
