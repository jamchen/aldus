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

describe("a stage stuck in running says what it cannot see (#244)", () => {
  // §19.1's concern is two runners executing one side-effecting stage at once, and the refusal
  // stated that worst case every time with nothing an operator could use to tell whether it
  // applied to them. The first adopter's stuck attempt had no cost record and no artifact, and a
  // killed dispatch is the ordinary failure of a long agent stage — three in their repository so
  // far, one of which charged $17.73 for nothing.
  //
  // Their proposal was that the runtime knows at that moment whether the attempt registered an
  // artifact. **It does not**, and the first version of this test is what showed it: artifacts
  // reach the attempt record when a stage *settles*, so a stuck attempt reads as zero however much
  // it recorded. Reporting "nothing to duplicate" from that would claim safety from evidence that
  // cannot exist yet.
  async function stuckRunning(artifacts: number): Promise<void> {
    // The stage never returns, so the attempt stays `running` — which is what a killed process
    // leaves behind and what no completed test can produce.
    //
    // Synchronised on the stage being entered, never on a timer. `#record` for `attempt.started`
    // is awaited before `execute` is called and nothing between them touches the disk, so
    // reaching this resolver proves the event **and** the `stages.json` write it wraps are both
    // durable. A sleep proved neither, and the difference is not academic: `stageExecution`
    // reconciles from the event log, which `#write` appends *before* the cache write it holds the
    // same lock for. On a loaded runner the refusal below was therefore satisfied from the
    // appended event while the cache rename was still in flight, `afterEach` removed the temp
    // root under it, and the run this test deliberately abandons rejected with `ENOENT` after the
    // test had passed. That is the #255 CI failure exactly: 194 assertions green, one unhandled
    // rejection, suite red.
    //
    // The abandoned run is deliberately left unguarded by a `.catch`. Swallowing it would remove
    // the only mechanism that reported this, and a write after cleanup is a real finding whether
    // it comes from a test's synchronisation or from the runner.
    let entered!: () => void;
    const running = new Promise<void>((resolve) => {
      entered = resolve;
    });
    harness.registry.register(
      aStage({
        execute: async (context) => {
          for (let index = 0; index < artifacts; index += 1) {
            context.recordOutput(anArtifact({ artifactId: `artifact-${index}` }) as never);
          }
          entered();
          return await new Promise<never>(() => {});
        },
      }),
    );
    void harness.runner.run(harness.manifest.runId, "stage-a", {});
    await running;
  }

  it("says an empty attempt is not evidence that nothing happened", async () => {
    // The stage recorded two artifacts and the record shows none, which is exactly the gap the
    // sentence now names instead of papering over.
    await stuckRunning(2);

    await expect(harness.runner.run(harness.manifest.runId, "stage-a", {})).rejects.toThrow(
      /not evidence that nothing happened/,
    );
  });

  it("never claims the attempt was uncharged, because it holds no cost store", async () => {
    await stuckRunning(0);

    await expect(harness.runner.run(harness.manifest.runId, "stage-a", {})).rejects.toThrow(
      /holds no cost store/,
    );
  });

  it("points at the command that does know", async () => {
    // `aldus costs` could not show a held reservation until next.35, so this pointer would have
    // been false this morning. It is true now, which is the only reason it is worth writing.
    await stuckRunning(0);

    await expect(harness.runner.run(harness.manifest.runId, "stage-a", {})).rejects.toThrow(
      /aldus costs --run/,
    );
  });

  it("still tells the operator to pass --force, not the runner's parameter", async () => {
    // Anchored on the instruction, not on the string `--force` anywhere in the message. The first
    // version of this asserted `/--force/`, which the example command satisfies on its own — so
    // reverting the instruction to the bare parameter name left it green. An assertion true for
    // another reason, in the test written to stop exactly that.
    await stuckRunning(0);

    await expect(harness.runner.run(harness.manifest.runId, "stage-a", {})).rejects.toThrow(
      /pass `--force` to take over/,
    );
  });
});

describe("a gate already decided over the same subjects refuses rather than parking (#275)", () => {
  // Reproduced by the first adopter on a real Run. Their refinement stage throws
  // `GateRequiredSignal(gate, { subjectHashes })` whenever its loop journal is not `converged`;
  // the operator approved the gate; the stage ran again, threw the same signal for the same gate
  // over the same hashes, and was parked again — forever. #219 made the runner check that the
  // gate is *known*; nothing checked its *state*, and the stage had no port to ask.
  const GATE = "content-freeze";
  const HASH_A = "a".repeat(64);
  const HASH_B = "b".repeat(64);

  /** A port answering one fixed status, and recording what it was asked. */
  function fixedStatus(
    status: { satisfied: boolean; state: string; subjectHashes?: readonly string[] } | undefined,
  ): {
    port: (gateId: string, runId: string) => Promise<typeof status>;
    asked: { gateId: string; runId: string }[];
  } {
    const asked: { gateId: string; runId: string }[] = [];
    return {
      asked,
      port: async (gateId, runId) => {
        asked.push({ gateId, runId });
        return status;
      },
    };
  }

  function throwingStage(subjectHashes: readonly string[]) {
    return aStage({
      requiredGates: [GATE],
      execute: async () => {
        throw new GateRequiredSignal(GATE, { subjectHashes });
      },
    });
  }

  it("fails the attempt with ALDUS_GATE_ALREADY_DECIDED when the gate is satisfied over the same hashes", async () => {
    await harness.cleanup();
    const { port, asked } = fixedStatus({
      satisfied: true,
      state: "satisfied",
      subjectHashes: [HASH_B, HASH_A],
    });
    harness = await makeTempRun({ gateStatus: port });
    // Listed in the other order, because a stage need not know how the engine sorts.
    harness.registry.register(throwingStage([HASH_A, HASH_B]));

    const result = await harness.runner.run(harness.manifest.runId, "stage-a", {});

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe(StageRunnerErrorCodes.GATE_ALREADY_DECIDED);
    expect(result.error?.category).toBe("conflict");
    expect(result.error?.retryable).toBe(false);
    // Names the gate, says the decision exists and the stage must consume it, and names the stage.
    expect(result.error?.message).toContain(`gate "${GATE}"`);
    expect(result.error?.message).toContain("must consume it");
    expect(result.error?.message).toContain('Stage "stage-a"');
    // Asked about this gate on this Run, not about anything else.
    expect(asked).toEqual([{ gateId: GATE, runId: harness.manifest.runId }]);
  });

  it("refuses on the returned path too, because the runner treats both forms identically", async () => {
    await harness.cleanup();
    harness = await makeTempRun({
      gateStatus: fixedStatus({ satisfied: true, state: "satisfied", subjectHashes: [HASH_A] })
        .port,
    });
    harness.registry.register(
      aStage({
        requiredGates: [GATE],
        execute: async () => ({ kind: "gate_required", gateId: GATE, subjectHashes: [HASH_A] }),
      }),
    );

    const result = await harness.runner.run(harness.manifest.runId, "stage-a", {});

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe(StageRunnerErrorCodes.GATE_ALREADY_DECIDED);
  });

  it("parks when the gate is satisfied over different subjects, because that is a new question", async () => {
    // The negative control for the hash comparison. Without it a check that ignored
    // `subjectHashes` — "satisfied, therefore decided" — would pass the case above and refuse a
    // stage asking about content the operator never saw.
    await harness.cleanup();
    harness = await makeTempRun({
      gateStatus: fixedStatus({ satisfied: true, state: "satisfied", subjectHashes: [HASH_A] })
        .port,
    });
    harness.registry.register(throwingStage([HASH_B]));

    const result = await harness.runner.run(harness.manifest.runId, "stage-a", {});

    expect(result.status).toBe("waiting_for_gate");
    expect(result.gateId).toBe(GATE);
  });

  it("parks when the gate is pending, however its hashes compare", async () => {
    await harness.cleanup();
    harness = await makeTempRun({
      gateStatus: fixedStatus({ satisfied: false, state: "pending" }).port,
    });
    harness.registry.register(throwingStage([HASH_A]));

    const result = await harness.runner.run(harness.manifest.runId, "stage-a", {});

    expect(result.status).toBe("waiting_for_gate");
  });

  it("parks when the gate is decided but not satisfied — rejected, or stale", async () => {
    // `satisfied` is the gate engine's judgement that the approval still binds the current
    // inputs; the runner does not second-guess it from the hashes alone.
    await harness.cleanup();
    harness = await makeTempRun({
      gateStatus: fixedStatus({ satisfied: false, state: "stale", subjectHashes: [HASH_A] }).port,
    });
    harness.registry.register(throwingStage([HASH_A]));

    const result = await harness.runner.run(harness.manifest.runId, "stage-a", {});

    expect(result.status).toBe("waiting_for_gate");
  });

  it("parks when the port cannot answer, which is what an unwired runner has always done", async () => {
    await harness.cleanup();
    harness = await makeTempRun({ gateStatus: fixedStatus(undefined).port });
    harness.registry.register(throwingStage([HASH_A]));

    const result = await harness.runner.run(harness.manifest.runId, "stage-a", {});

    expect(result.status).toBe("waiting_for_gate");
  });

  it("parks when the port throws, because a failed read is not an answer about the gate", async () => {
    // The stage has already settled by the time the runner asks. A throw escaping here would leave
    // the attempt `running` with the stage finished (#254's shape); refusing on it would turn a
    // read failure into a claim that the gate is decided. Parking asserts nothing.
    await harness.cleanup();
    harness = await makeTempRun({
      gateStatus: async () => {
        throw new Error("gate store unreadable");
      },
    });
    harness.registry.register(throwingStage([HASH_A]));

    const result = await harness.runner.run(harness.manifest.runId, "stage-a", {});

    expect(result.status).toBe("waiting_for_gate");
  });

  it("gives the stage the same answer through context.gateStatus", async () => {
    // One port, two consumers: what the stage reads before deciding whether to throw is what the
    // runner would refuse on. The stage here consumes the decision instead of asking again — the
    // shape the adopter's fix takes.
    await harness.cleanup();
    const { port, asked } = fixedStatus({
      satisfied: true,
      state: "satisfied",
      subjectHashes: [HASH_A],
    });
    harness = await makeTempRun({ gateStatus: port });
    harness.registry.register(
      aStage({
        requiredGates: [GATE],
        execute: async (context) => {
          const status = await context.gateStatus?.(GATE);
          if (status?.satisfied === true) return { kind: "completed", output: status };
          throw new GateRequiredSignal(GATE, { subjectHashes: [HASH_A] });
        },
      }),
    );

    const result = await harness.runner.run(harness.manifest.runId, "stage-a", {});

    expect(result.status).toBe("succeeded");
    expect(result.output).toEqual({ satisfied: true, state: "satisfied", subjectHashes: [HASH_A] });
    expect(asked).toEqual([{ gateId: GATE, runId: harness.manifest.runId }]);
  });

  it("answers undefined through context.gateStatus when nothing is wired", async () => {
    // The default harness has no port. `undefined` means "cannot answer", never "undecided", and
    // the stage that then throws is parked exactly as before this existed.
    let seen: unknown = "unset";
    harness.registry.register(
      aStage({
        requiredGates: [GATE],
        execute: async (context) => {
          seen = await context.gateStatus?.(GATE);
          throw new GateRequiredSignal(GATE, { subjectHashes: [HASH_A] });
        },
      }),
    );

    const result = await harness.runner.run(harness.manifest.runId, "stage-a", {});

    expect(seen).toBeUndefined();
    expect(result.status).toBe("waiting_for_gate");
  });
});
