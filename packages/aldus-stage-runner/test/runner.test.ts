/**
 * The stage lifecycle (architecture contract §6.3, §11, §19.1).
 *
 * These tests pin the §11 obligations the runner is responsible for. Each is written so that
 * removing the rule from `runner.ts` fails it — an assertion that passes whether or not the rule
 * exists is a comment with a test framework around it.
 */

import { readFile, rm } from "node:fs/promises";

import { assertValid, type AldusError } from "@aldus-runtime/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { GateRequiredSignal, type StageOutcome } from "../src/definition.js";
import { StageRunnerErrorCodes } from "../src/errors.js";
import { STAGE_EVENT_ACTIONS, rebuildStageState, writeStageState } from "../src/state.js";
import { aStage, anArtifact, makeTempRun, type TempRun } from "./helpers.js";

let harness: TempRun;

beforeEach(async () => {
  harness = await makeTempRun();
});

afterEach(async () => {
  await harness.cleanup();
});

/** Every event recorded against the Run, in log order. */
async function events() {
  const { events: log } = await harness.workspace.events.read(harness.manifest.runId);
  return log;
}

describe("a successful run", () => {
  beforeEach(() => {
    harness.registry.register(
      aStage<{ topic: string }, { words: number }>({
        inputSchema: z.object({ topic: z.string() }),
        outputSchema: z.object({ words: z.number() }),
        execute: async () => ({ kind: "completed", output: { words: 42 } }),
      }),
    );
  });

  it("returns the validated output", async () => {
    const result = await harness.runner.run(harness.manifest.runId, "stage-a", { topic: "t" });
    expect(result.status).toBe("succeeded");
    expect(result.output).toEqual({ words: 42 });
    expect(result.attempt).toBe(1);
  });

  it("records a StageExecution that validates against the Core schema", async () => {
    await harness.runner.run(harness.manifest.runId, "stage-a", { topic: "t" });
    const stored = await harness.runner.stageExecution(harness.manifest.runId, "stage-a");
    expect(stored).toBeDefined();
    // The cache holds a real Core record, not a lookalike.
    expect(() => assertValid("StageExecution", stored?.execution)).not.toThrow();
    expect(stored?.execution.status).toBe("succeeded");
  });

  it("emits an event for every state transition, not just the interesting ones", async () => {
    await harness.runner.run(harness.manifest.runId, "stage-a", { topic: "t" });
    // §6.4: "Every state mutation MUST emit an immutable event." Queued and started are mutations.
    expect((await events()).map((event) => event.action)).toEqual([
      STAGE_EVENT_ACTIONS.attemptQueued,
      STAGE_EVENT_ACTIONS.attemptStarted,
      STAGE_EVENT_ACTIONS.attemptSucceeded,
    ]);
  });

  it("records the state it moved from and to", async () => {
    await harness.runner.run(harness.manifest.runId, "stage-a", { topic: "t" });
    const log = await events();
    expect(log.at(-1)).toMatchObject({ previousState: "running", resultingState: "succeeded" });
  });
});

describe("§11 — declared inputs are validated", () => {
  it("refuses input that does not satisfy the declared schema", async () => {
    harness.registry.register(aStage({ inputSchema: z.object({ topic: z.string() }) as never }));
    await expect(
      harness.runner.run(harness.manifest.runId, "stage-a", { topic: 7 }),
    ).rejects.toMatchObject({ code: StageRunnerErrorCodes.STAGE_INPUT_INVALID });
  });

  it("does not run the stage when its input is invalid", async () => {
    let ran = false;
    harness.registry.register(
      aStage({
        inputSchema: z.object({ topic: z.string() }) as never,
        execute: async () => {
          ran = true;
          return { kind: "completed", output: undefined };
        },
      }),
    );
    await harness.runner
      .run(harness.manifest.runId, "stage-a", { topic: 7 })
      .catch(() => undefined);
    expect(ran).toBe(false);
  });

  it("never echoes the rejected input into the error", async () => {
    harness.registry.register(aStage({ inputSchema: z.object({ token: z.number() }) as never }));
    const secret = "sk-not-a-real-credential-000000000000";
    let thrown: unknown;
    try {
      await harness.runner.run(harness.manifest.runId, "stage-a", { token: secret });
    } catch (error) {
      thrown = error;
    }
    // §19.2: a validation failure must carry the path and code, never the received value.
    expect(JSON.stringify((thrown as AldusError).toStructuredError())).not.toContain(secret);
  });
});

describe("§11 — declared outputs, or a structured failure", () => {
  it("records a stage that returns an invalid output as a stage failure, not a crash", async () => {
    harness.registry.register(
      aStage({
        outputSchema: z.object({ words: z.number() }) as never,
        execute: async () => ({ kind: "completed", output: { words: "many" } }) as never,
      }),
    );
    const result = await harness.runner.run(harness.manifest.runId, "stage-a", {});
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe(StageRunnerErrorCodes.STAGE_OUTPUT_INVALID);
    // And it is in the durable record, not only in the return value.
    const stored = await harness.runner.stageExecution(harness.manifest.runId, "stage-a");
    expect(stored?.execution.attempts.at(-1)?.error?.code).toBe(
      StageRunnerErrorCodes.STAGE_OUTPUT_INVALID,
    );
  });

  it("turns a thrown error into a structured failure", async () => {
    harness.registry.register(
      aStage({
        execute: async () => {
          throw new Error("the renderer exited non-zero");
        },
      }),
    );
    const result = await harness.runner.run(harness.manifest.runId, "stage-a", {});
    expect(result.status).toBe("failed");
    expect(result.error?.message).toContain("renderer exited");
  });
});

describe("§19.1 — recovery from partial success", () => {
  it("keeps artifacts a failing stage had already produced", async () => {
    const produced = [anArtifact({ artifactId: "art_a" }), anArtifact({ artifactId: "art_b" })];
    harness.registry.register(
      aStage({
        execute: async (context) => {
          context.recordOutput(produced[0] as never);
          context.recordOutput(produced[1] as never);
          throw new Error("failed after producing two artifacts");
        },
      }),
    );

    const result = await harness.runner.run(harness.manifest.runId, "stage-a", {});
    expect(result.status).toBe("failed");
    // Losing these would make the next attempt redo work whose results already exist — and for a
    // paid stage, pay for them twice (§15.1).
    expect(result.outputArtifacts.map((artifact) => artifact.artifactId)).toEqual([
      "art_a",
      "art_b",
    ]);
    const stored = await harness.runner.stageExecution(harness.manifest.runId, "stage-a");
    expect(stored?.execution.attempts.at(-1)?.outputArtifacts).toHaveLength(2);
  });

  it("refuses an output that is not a valid ArtifactRef", async () => {
    harness.registry.register(
      aStage({
        execute: async (context) => {
          context.recordOutput({ artifactId: "nope" } as never);
          return { kind: "completed", output: undefined };
        },
      }),
    );
    const result = await harness.runner.run(harness.manifest.runId, "stage-a", {});
    expect(result.status).toBe("failed");
  });
});

describe("§11, §20 — the exact configuration used is recorded", () => {
  it("records a digest and a copy of the configuration", async () => {
    harness.registry.register(aStage());
    await harness.runner.run(
      harness.manifest.runId,
      "stage-a",
      {},
      {
        configuration: { quality: "high", passes: 2 },
      },
    );
    const stored = await harness.runner.stageExecution(harness.manifest.runId, "stage-a");
    const attemptId = stored?.execution.attempts.at(-1)?.attemptId ?? "";
    expect(stored?.metadata[attemptId]?.configuration).toEqual({ quality: "high", passes: 2 });
    expect(stored?.metadata[attemptId]?.configurationHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hashes the same configuration identically regardless of key order", async () => {
    harness.registry.register(aStage());
    harness.registry.register(aStage({ id: "stage-b" }));
    await harness.runner.run(
      harness.manifest.runId,
      "stage-a",
      {},
      {
        configuration: { a: 1, b: 2 },
      },
    );
    await harness.runner.run(
      harness.manifest.runId,
      "stage-b",
      {},
      {
        configuration: { b: 2, a: 1 },
      },
    );
    const a = await harness.runner.stageExecution(harness.manifest.runId, "stage-a");
    const b = await harness.runner.stageExecution(harness.manifest.runId, "stage-b");
    const hashOf = (stored: typeof a) =>
      stored?.metadata[stored.execution.attempts[0]?.attemptId ?? ""]?.configurationHash;
    // Otherwise §20's "which configuration produced this" answers differently for one
    // configuration, purely because of how the object was built.
    expect(hashOf(a)).toBe(hashOf(b));
  });

  it("redacts a credential in the configuration before storing it", async () => {
    harness.registry.register(aStage());
    await harness.runner.run(
      harness.manifest.runId,
      "stage-a",
      {},
      {
        configuration: { apiKey: "not-a-real-key-000000", region: "region-a" },
      },
    );
    const raw = await readFile(harness.stageStatePath(harness.manifest.runId), "utf8");
    // §19.2: an attempt record is durable, so a secret written here once is leaked permanently.
    expect(raw).not.toContain("not-a-real-key-000000");
    expect(raw).toContain("region-a");
  });
});

describe("§6.3 — attempts are append-only", () => {
  it("never rewrites a line in the event log", async () => {
    harness.registry.register(aStage());
    await harness.runner.run(harness.manifest.runId, "stage-a", {});
    const before = await readFile(
      harness.workspace.layout.runFilePath(harness.manifest.runId, "events"),
      "utf8",
    );
    harness.registry.register(aStage({ id: "stage-b" }));
    await harness.runner.run(harness.manifest.runId, "stage-b", {});
    const after = await readFile(
      harness.workspace.layout.runFilePath(harness.manifest.runId, "events"),
      "utf8",
    );
    // The audit record grows; it does not change.
    expect(after.startsWith(before)).toBe(true);
  });
});

describe("the cache is disposable (ADR-0008)", () => {
  it("rebuilds identical state from the event log alone", async () => {
    harness.registry.register(
      aStage({
        execute: async (context) => {
          context.recordOutput(anArtifact({ artifactId: "art_x" }) as never);
          context.note("halfway");
          return { kind: "completed", output: { ok: true } } as StageOutcome<unknown>;
        },
      }),
    );
    await harness.runner.run(
      harness.manifest.runId,
      "stage-a",
      {},
      {
        configuration: { passes: 3 },
      },
    );

    const live = await harness.runner.stageState(harness.manifest.runId);
    const rebuilt = await rebuildStageState(harness.workspace.events, harness.manifest.runId);
    // The same fold is used by both paths, so a cache built by replay cannot drift from one built
    // incrementally. If these ever disagree, one of them is lying about what happened.
    expect(rebuilt).toEqual(live);
  });

  it("recovers everything after the cache file is deleted", async () => {
    harness.registry.register(aStage());
    await harness.runner.run(harness.manifest.runId, "stage-a", {});
    const before = await harness.runner.stageState(harness.manifest.runId);

    await rm(harness.stageStatePath(harness.manifest.runId));

    const after = await harness.runner.stageState(harness.manifest.runId);
    expect(after).toEqual(before);
  });

  it("repairs a cache left behind by a crash between the event and the write", async () => {
    harness.registry.register(aStage());
    await harness.runner.run(harness.manifest.runId, "stage-a", {});
    const complete = await harness.runner.stageState(harness.manifest.runId);

    // Exactly what a kill between `events.append` and `writeStageState` leaves: the log is
    // complete, the cache is behind. The reverse — a state change with no event — is what the
    // write order makes impossible (§6.4).
    const stale = { ...complete, lastEventSequence: 0, stages: [] };
    await writeStageState(harness.stageStatePath(harness.manifest.runId), stale);

    const repaired = await harness.runner.stageState(harness.manifest.runId);
    expect(repaired.stages).toEqual(complete.stages);
    // And the repair is persisted, so the next read costs nothing extra.
    expect(await harness.runner.stageState(harness.manifest.runId)).toEqual(repaired);
  });
});

describe("gate halts (§11, §13)", () => {
  it("records waiting_for_gate when a stage returns a gate requirement", async () => {
    harness.registry.register(
      aStage({
        execute: async () => ({
          kind: "gate_required",
          gateId: "content-freeze",
          subjectHashes: ["a".repeat(64)],
        }),
      }),
    );
    const result = await harness.runner.run(harness.manifest.runId, "stage-a", {});
    expect(result.status).toBe("waiting_for_gate");
    expect(result.gateId).toBe("content-freeze");

    const stored = await harness.runner.stageExecution(harness.manifest.runId, "stage-a");
    const attemptId = stored?.execution.attempts.at(-1)?.attemptId ?? "";
    expect(stored?.execution.status).toBe("waiting_for_gate");
    expect(stored?.metadata[attemptId]?.subjectHashes).toEqual(["a".repeat(64)]);
  });

  it("refuses a gate the stage cannot wait on, rather than waiting on it forever", async () => {
    // An escalation that cannot be decided is worse than no escalation: `waiting_for_gate` on an
    // unresolvable id is a permanent silent stop that reads as having halted safely, and every
    // automatic escalation path terminates at this signal (#220).
    harness.registry.register(
      aStage({
        requiredGates: ["content-freeze"],
        execute: async () => ({
          kind: "gate_required",
          gateId: "conten-freeze",
          subjectHashes: ["a".repeat(64)],
        }),
      }),
    );
    const result = await harness.runner.run(harness.manifest.runId, "stage-a", {});

    expect(result.status).toBe("failed");
    expect(JSON.stringify(result)).toContain("ALDUS_GATE_REQUIRED_UNKNOWN_GATE");
  });

  it("refuses it on the thrown path too, which a returned-only fix would have missed", async () => {
    harness.registry.register(
      aStage({
        requiredGates: ["content-freeze"],
        execute: async () => {
          throw new GateRequiredSignal("performance-freeze", { subjectHashes: ["b".repeat(64)] });
        },
      }),
    );
    const result = await harness.runner.run(harness.manifest.runId, "stage-a", {});

    expect(result.status).toBe("failed");
  });

  it("still waits on a gate the stage declared, so the rule did not widen", async () => {
    // The control. Refusing an unknown id must not refuse a known one.
    harness.registry.register(
      aStage({
        requiredGates: ["content-freeze"],
        execute: async () => ({
          kind: "gate_required",
          gateId: "content-freeze",
          subjectHashes: ["a".repeat(64)],
        }),
      }),
    );
    const result = await harness.runner.run(harness.manifest.runId, "stage-a", {});

    expect(result.status).toBe("waiting_for_gate");
  });

  it("treats a thrown GateRequiredSignal the same as a returned one", async () => {
    harness.registry.register(
      aStage({
        execute: async () => {
          throw new GateRequiredSignal("performance-freeze", { subjectHashes: ["b".repeat(64)] });
        },
      }),
    );
    const result = await harness.runner.run(harness.manifest.runId, "stage-a", {});
    expect(result.status).toBe("waiting_for_gate");
    expect(result.gateId).toBe("performance-freeze");
  });

  it("refuses to run a stage again while it waits for a decision", async () => {
    harness.registry.register(
      aStage({ execute: async () => ({ kind: "gate_required", gateId: "content-freeze" }) }),
    );
    await harness.runner.run(harness.manifest.runId, "stage-a", {});
    // §13 makes human review first-class. Running anyway would step past a decision that has not
    // been made — the runner halts at gates, it does not decide them.
    await expect(harness.runner.run(harness.manifest.runId, "stage-a", {})).rejects.toMatchObject({
      code: StageRunnerErrorCodes.STAGE_STATE_INVALID,
    });
  });

  it("does not evaluate the gate", async () => {
    harness.registry.register(
      aStage({ execute: async () => ({ kind: "gate_required", gateId: "content-freeze" }) }),
    );
    await harness.runner.run(harness.manifest.runId, "stage-a", {});
    // No approval record is written: deciding is WP-05's, and a runner that recorded its own
    // approval would make §3.6's durable GateDecision a formality.
    const approvals = await harness.workspace.runs.listRecords(harness.manifest.runId, "approvals");
    expect(approvals).toEqual([]);
  });
});

describe("unregistered stages", () => {
  it("refuses a stage id that was never registered", async () => {
    await expect(
      harness.runner.run(harness.manifest.runId, "stage-missing", {}),
    ).rejects.toMatchObject({ code: StageRunnerErrorCodes.STAGE_NOT_REGISTERED });
  });

  it("refuses to guess when several versions are registered", async () => {
    harness.registry.register(aStage({ version: "1.0.0" }));
    harness.registry.register(aStage({ version: "2.0.0" }));
    // Picking one would make §20 unable to say which definition ran.
    await expect(harness.runner.run(harness.manifest.runId, "stage-a", {})).rejects.toMatchObject({
      code: StageRunnerErrorCodes.STAGE_NOT_REGISTERED,
    });
  });

  it("runs the named version when several are registered", async () => {
    harness.registry.register(
      aStage({ version: "1.0.0", execute: async () => ({ kind: "completed", output: "v1" }) }),
    );
    harness.registry.register(
      aStage({ version: "2.0.0", execute: async () => ({ kind: "completed", output: "v2" }) }),
    );
    const result = await harness.runner.run(
      harness.manifest.runId,
      "stage-a",
      {},
      {
        stageVersion: "2.0.0",
      },
    );
    expect(result.output).toBe("v2");
  });

  it("refuses a Run that does not exist", async () => {
    harness.registry.register(aStage());
    await expect(harness.runner.run("run_missing", "stage-a", {})).rejects.toMatchObject({
      code: StageRunnerErrorCodes.STAGE_STATE_INVALID,
    });
  });
});
