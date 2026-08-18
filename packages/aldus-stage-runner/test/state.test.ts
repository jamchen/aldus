/**
 * Stage state as a projection of the event log (ADR-0008, contract §6.3, §6.4, §19.1).
 *
 * The claim these tests defend is that `stages.json` is a **cache, not a source of truth**. §6.4
 * makes the event log the record of every mutation and §6.3 makes the materialized summary
 * optional, so the log must be sufficient to rebuild the cache exactly. If that ever stops being
 * true, the cache has quietly become a second source of truth that can disagree with the first.
 */

import { writeFile } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { StageRunnerErrorCodes } from "../src/errors.js";
import {
  STAGE_STATE_FORMAT_VERSION,
  applyLifecycleEvent,
  canonicalJson,
  digestJson,
  emptyStageState,
  isTerminal,
  outputsOf,
  readStageState,
  rebuildStageState,
  reconcileStageState,
  writeStageState,
} from "../src/state.js";
import { aStage, anArtifact, makeTempRun, type TempRun } from "./helpers.js";

let harness: TempRun;

beforeEach(async () => {
  harness = await makeTempRun();
});

afterEach(async () => {
  await harness.cleanup();
});

describe("canonicalJson", () => {
  it("orders object keys at every depth", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it("preserves array order, which is meaningful", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
  });

  it("drops undefined properties rather than emitting them", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it("handles primitives and null", () => {
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson("x")).toBe('"x"');
    expect(canonicalJson(7)).toBe("7");
  });

  it("gives structurally identical values the same digest", () => {
    expect(digestJson({ a: 1, b: 2 })).toBe(digestJson({ b: 2, a: 1 }));
    expect(digestJson({ a: 1 })).not.toBe(digestJson({ a: 2 }));
  });

  it("produces a well-formed sha256 digest", () => {
    expect(digestJson({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("isTerminal", () => {
  it("treats waiting_for_gate as terminal for the attempt", () => {
    // The attempt did its work and stopped; a decision produces a *new* attempt, because a
    // JavaScript call stack cannot be resumed after a process restart (§5.1 makes long pauses
    // normal, so resumption across restarts is the ordinary case).
    expect(isTerminal("waiting_for_gate")).toBe(true);
    expect(isTerminal("succeeded")).toBe(true);
    expect(isTerminal("failed")).toBe(true);
    expect(isTerminal("cancelled")).toBe(true);
  });

  it("does not treat in-flight statuses as terminal", () => {
    expect(isTerminal("queued")).toBe(false);
    expect(isTerminal("running")).toBe(false);
  });
});

describe("reading the cache", () => {
  it("reads an absent file as empty state", async () => {
    // A Run that has not run a stage yet is ordinary (§6.2 `created`), not a missing record.
    expect(await readStageState(harness.stageStatePath("run-nonexistent"))).toEqual(
      emptyStageState(),
    );
  });

  it("reads an empty file as empty state", async () => {
    const path = harness.stageStatePath(harness.manifest.runId);
    await writeFile(path, "   ", "utf8");
    expect(await readStageState(path)).toEqual(emptyStageState());
  });

  it("rejects a file that is not JSON", async () => {
    const path = harness.stageStatePath(harness.manifest.runId);
    await writeFile(path, "{not json", "utf8");
    await expect(readStageState(path)).rejects.toMatchObject({
      code: StageRunnerErrorCodes.STAGE_STATE_MALFORMED,
    });
  });

  it("rejects a file whose shape is wrong", async () => {
    const path = harness.stageStatePath(harness.manifest.runId);
    await writeFile(path, JSON.stringify({ formatVersion: "one" }), "utf8");
    await expect(readStageState(path)).rejects.toMatchObject({
      code: StageRunnerErrorCodes.STAGE_STATE_MALFORMED,
    });
  });

  it("discards a cache written by a newer format rather than guessing", async () => {
    const path = harness.stageStatePath(harness.manifest.runId);
    await writeFile(
      path,
      JSON.stringify({
        formatVersion: STAGE_STATE_FORMAT_VERSION + 1,
        lastEventSequence: 9,
        stages: [],
      }),
      "utf8",
    );
    // Guessing at a newer shape would corrupt the cache on the next write, and rebuilding from
    // the log is always available and always correct.
    expect(await readStageState(path)).toEqual(emptyStageState());
  });
});

describe("the log is sufficient (ADR-0008)", () => {
  it("rebuilds state across a failure, a retry, and a success", async () => {
    let calls = 0;
    harness.registry.register(
      aStage({
        retryPolicy: { maxAttempts: 3 },
        execute: async (context) => {
          calls += 1;
          context.recordOutput(anArtifact({ artifactId: `art_${calls}` }) as never);
          if (calls < 3) {
            const { AldusError } = await import("@aldus/core");
            throw new AldusError("ALDUS_EXAMPLE_STAGE_FAILURE", "transient", {
              category: "provider",
              retryable: true,
            });
          }
          return { kind: "completed", output: { calls } };
        },
      }),
    );
    await harness.runner.run(
      harness.manifest.runId,
      "stage-a",
      {},
      {
        configuration: { passes: 2 },
      },
    );

    const live = await harness.runner.stageState(harness.manifest.runId);
    const rebuilt = await rebuildStageState(harness.workspace.events, harness.manifest.runId);
    expect(rebuilt).toEqual(live);
    expect(rebuilt.stages[0]?.execution.attempts).toHaveLength(3);
  });

  it("rebuilds several stages independently", async () => {
    harness.registry.register(aStage({ id: "stage-a" }));
    harness.registry.register(aStage({ id: "stage-b" }));
    await harness.runner.run(harness.manifest.runId, "stage-a", {});
    await harness.runner.run(harness.manifest.runId, "stage-b", {});

    const rebuilt = await rebuildStageState(harness.workspace.events, harness.manifest.runId);
    expect(rebuilt.stages.map((stage) => stage.execution.stageId)).toEqual(["stage-a", "stage-b"]);
  });

  it("ignores events that are not stage lifecycle events", async () => {
    const before = emptyStageState();
    const after = applyLifecycleEvent(before, {
      schemaVersion: "1.2",
      eventId: "evt_x",
      occurredAt: "2026-01-01T00:00:00.000Z",
      episodeId: "show:example-show:episode:episode-a",
      runId: harness.manifest.runId,
      action: "release.upload.succeeded",
      actor: { kind: "human", id: "operator-a" },
      inputRefs: [],
      outputRefs: [],
      sequence: 1,
    });
    // Another package's events share the log; folding them in would invent stage state.
    expect(after).toEqual(before);
  });
});

describe("reconciliation after a crash (§19.1)", () => {
  it("reports that nothing needed repair when the cache is current", async () => {
    harness.registry.register(aStage());
    await harness.runner.run(harness.manifest.runId, "stage-a", {});

    const cached = await readStageState(harness.stageStatePath(harness.manifest.runId));
    const { repaired } = await reconcileStageState(
      harness.workspace.events,
      harness.manifest.runId,
      cached,
    );
    expect(repaired).toBe(false);
  });

  it("replays only the events after the watermark", async () => {
    harness.registry.register(aStage());
    await harness.runner.run(harness.manifest.runId, "stage-a", {});
    const complete = await readStageState(harness.stageStatePath(harness.manifest.runId));

    const stale = { ...complete, lastEventSequence: 1, stages: [] };
    const { state, repaired } = await reconcileStageState(
      harness.workspace.events,
      harness.manifest.runId,
      stale,
    );
    expect(repaired).toBe(true);
    expect(state.stages[0]?.execution.status).toBe("succeeded");
    expect(state.lastEventSequence).toBe(complete.lastEventSequence);
  });

  it("survives a cache that is behind by an entire stage", async () => {
    harness.registry.register(aStage({ id: "stage-a" }));
    harness.registry.register(aStage({ id: "stage-b" }));
    await harness.runner.run(harness.manifest.runId, "stage-a", {});
    await harness.runner.run(harness.manifest.runId, "stage-b", {});

    const path = harness.stageStatePath(harness.manifest.runId);
    await writeStageState(path, emptyStageState());

    const repaired = await harness.runner.stageState(harness.manifest.runId);
    expect(repaired.stages).toHaveLength(2);
  });
});

describe("outputsOf", () => {
  it("returns an empty list for a missing attempt", () => {
    expect(outputsOf(undefined)).toEqual([]);
  });

  it("copies rather than aliasing the stored array", () => {
    const artifact = anArtifact();
    const attempt = {
      attemptId: "att_1",
      stageId: "stage-a",
      attempt: 1,
      status: "succeeded" as const,
      actor: { kind: "human" as const, id: "operator-a" },
      inputArtifacts: [],
      outputArtifacts: [artifact],
    };
    const copy = outputsOf(attempt);
    copy.push(artifact);
    expect(attempt.outputArtifacts).toHaveLength(1);
  });
});
