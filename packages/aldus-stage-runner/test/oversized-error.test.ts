/**
 * A failure too large to store is still a failure that happened (#254).
 *
 * The defect these pin: a stage threw with a message longer than `StructuredError.message`
 * allows, the runner's own `stage.attempt.failed` event was refused by schema validation, and the
 * attempt was left in `stages.json` reading `running`. The cost of the attempt was already
 * written down, so the Run record said money had been spent on a stage that was still working —
 * and `retry` saw a running attempt. **A failure to report a failure discarded the outcome and
 * kept the charge.**
 *
 * Two mechanisms, tested separately because either alone leaves the defect reachable:
 * truncation at construction, which is what makes the ordinary oversized message record cleanly;
 * and the reduced record, which is what keeps the terminal state when something else in the event
 * is what the schema refuses.
 */

import { readFile } from "node:fs/promises";

import { AldusError, MAX_ERROR_MESSAGE_LENGTH } from "@aldus-runtime/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { recordingSpendController } from "../src/doubles.js";
import { StageRunnerErrorCodes } from "../src/errors.js";
import { STAGE_EVENT_ACTIONS } from "../src/state.js";
import { WorkerRegistry } from "../src/worker.js";
import { recordingWorker } from "../src/doubles.js";
import { aStage, makeTempRun, type TempRun } from "./helpers.js";

/** The reproduction from #254, verbatim in shape: a stage that throws far past the cap. */
const OVERSIZED = "PROBE ".repeat(1400);

let harness: TempRun;

beforeEach(async () => {
  harness = await makeTempRun();
});

afterEach(async () => {
  await harness.cleanup();
});

/** The stage state as it was persisted, not as the runner remembers it. */
async function persisted(temp: TempRun = harness) {
  const raw = await readFile(temp.stageStatePath(temp.manifest.runId), "utf8");
  return JSON.parse(raw) as {
    stages: {
      execution: {
        status: string;
        attempts: { status: string; error?: { message: string; code: string } }[];
      };
    }[];
  };
}

describe("a stage whose failure exceeds the message cap", () => {
  beforeEach(() => {
    harness.registry.register(
      aStage({
        execute: async () => {
          throw new Error(OVERSIZED);
        },
      }),
    );
  });

  it("reports the attempt as failed rather than refusing to record it", async () => {
    const result = await harness.runner.run(harness.manifest.runId, "stage-a", {});

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe(StageRunnerErrorCodes.STAGE_EXECUTION_FAILED);
  });

  it("truncates the message with a marker naming what was lost", async () => {
    const result = await harness.runner.run(harness.manifest.runId, "stage-a", {});

    const message = result.error?.message ?? "";
    expect(message.length).toBeLessThanOrEqual(MAX_ERROR_MESSAGE_LENGTH);
    // The marker, not merely a shorter string: a silently shortened message reads as the whole
    // message to the person diagnosing the failure.
    expect(message).toContain(`truncated: message was ${String(OVERSIZED.length)} characters`);
    expect(message.startsWith("PROBE PROBE")).toBe(true);
  });

  it("leaves the attempt durably failed, not running", async () => {
    await harness.runner.run(harness.manifest.runId, "stage-a", {});

    const state = await persisted();
    expect(state.stages[0]?.execution.status).toBe("failed");
    expect(state.stages[0]?.execution.attempts.map((attempt) => attempt.status)).toEqual([
      "failed",
    ]);
  });

  it("appends the terminal event, so the log and the cache agree", async () => {
    await harness.runner.run(harness.manifest.runId, "stage-a", {});

    const { events } = await harness.workspace.events.read(harness.manifest.runId);
    expect(events.map((event) => event.action)).toEqual([
      STAGE_EVENT_ACTIONS.attemptQueued,
      STAGE_EVENT_ACTIONS.attemptStarted,
      STAGE_EVENT_ACTIONS.attemptFailed,
    ]);
  });

  it("lets a retry run, because nothing reads as still in flight", async () => {
    await harness.runner.run(harness.manifest.runId, "stage-a", {});

    // The defect's second consequence: `retry` refuses to advance a stage whose latest attempt is
    // running, so an unrecorded terminal state locked the stage out of every subsequent attempt.
    const again = await harness.runner.run(harness.manifest.runId, "stage-a", {});

    expect(again.status).toBe("failed");
    const state = await persisted();
    expect(state.stages[0]?.execution.attempts).toHaveLength(2);
  });
});

describe("an ordinary failure", () => {
  it("is recorded exactly as thrown", async () => {
    harness.registry.register(
      aStage({
        execute: async () => {
          throw new Error("the lint stage found 3 problems");
        },
      }),
    );

    const result = await harness.runner.run(harness.manifest.runId, "stage-a", {});

    expect(result.error?.message).toBe("the lint stage found 3 problems");
    expect(result.error?.message).not.toContain("truncated");
  });
});

describe("a charge already recorded when the failure will not fit", () => {
  it("keeps both the cost record and the terminal state", async () => {
    // The shape the issue was filed on: the dispatch completed and USD was recorded as charged,
    // and then the stage's own refusal could not be written down. Money spent, outcome lost, and
    // from the Run record alone indistinguishable from a stage still working.
    const spend = recordingSpendController();
    const workers = new WorkerRegistry();
    workers.register(
      recordingWorker({
        execute: () =>
          Promise.resolve({
            output: { ok: true },
            costs: [
              {
                provider: "provider-a",
                operation: "render",
                billingStatus: "charged" as const,
                actual: { amount: "1.0931", currency: "USD" },
              },
            ],
          }),
      }),
    );
    const temp = await makeTempRun({ workers, paidDispatch: spend });
    temp.registry.register(
      aStage({
        execute: async (context) => {
          await context.runWorker({
            workerId: "worker-a",
            workerVersion: "1",
            input: {},
            effect: { kind: "none" },
            spend: {
              expectation: { kind: "estimated", amount: { amount: "2.0000", currency: "USD" } },
            },
          } as never);
          throw new Error(OVERSIZED);
        },
      }),
    );

    const result = await temp.runner.run(temp.manifest.runId, "stage-a", {});

    expect(result.status).toBe("failed");
    expect(spend.written.map((record) => record.actual?.amount)).toEqual(["1.0931"]);

    const state = await persisted(temp);
    expect(state.stages[0]?.execution.status).toBe("failed");

    await temp.cleanup();
  });
});

describe("an event the schema refuses for a reason truncation cannot repair", () => {
  /**
   * A code past `MAX_ERROR_CODE_LENGTH`, which is deliberately *not* truncated at construction:
   * consumers branch on a code, and a shortened one is a different code no branch matches. So
   * this is a real event that will not validate, reached without a mock — the second mechanism's
   * only honest test.
   */
  const LONG_CODE = `ALDUS_${"X".repeat(300)}`;

  beforeEach(() => {
    harness.registry.register(
      aStage({
        execute: async () => {
          throw new AldusError(LONG_CODE, "the stage refused", { category: "policy" });
        },
      }),
    );
  });

  it("still records the attempt as failed", async () => {
    await harness.runner.run(harness.manifest.runId, "stage-a", {});

    const state = await persisted();
    expect(state.stages[0]?.execution.status).toBe("failed");
    expect(state.stages[0]?.execution.attempts[0]?.status).toBe("failed");
  });

  it("says the record is reduced, and where the full one was rejected", async () => {
    await harness.runner.run(harness.manifest.runId, "stage-a", {});

    const { events } = await harness.workspace.events.read(harness.manifest.runId);
    const failed = events.find((event) => event.action === STAGE_EVENT_ACTIONS.attemptFailed);

    expect(failed?.error?.code).toBe(StageRunnerErrorCodes.STAGE_TERMINAL_RECORD_DEGRADED);
    expect(failed?.error?.details?.["degraded"]).toBe(true);
    // §19.2's field path, which is the part a reader cannot reconstruct — `(1 issue)` with no
    // path is what made the original defect cost a reproduction to identify.
    expect(failed?.error?.details?.["rejectedPaths"]).toEqual(["error.code"]);
    expect(failed?.error?.message).toContain("the stage refused");
  });

  it("keeps what the attempt reported, quoted inside the bound", async () => {
    await harness.runner.run(harness.manifest.runId, "stage-a", {});

    const state = await persisted();
    const error = state.stages[0]?.execution.attempts[0]?.error;
    expect(error?.code).toBe(StageRunnerErrorCodes.STAGE_TERMINAL_RECORD_DEGRADED);
    expect(error?.message).toContain("ALDUS_XXX");
  });
});
