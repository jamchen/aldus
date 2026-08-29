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

import { AldusError, MAX_ERROR_MESSAGE_LENGTH, structuredErrorSchema } from "@aldus-runtime/core";
import type { EventStore } from "@aldus-runtime/file-store";
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
  beforeEach(() => {
    harness.registry.register(
      aStage({
        execute: async () => {
          throw new Error("the lint stage found 3 problems");
        },
      }),
    );
  });

  it("is recorded exactly as thrown", async () => {
    const result = await harness.runner.run(harness.manifest.runId, "stage-a", {});

    expect(result.error?.message).toBe("the lint stage found 3 problems");
    expect(result.error?.message).not.toContain("truncated");
  });

  it("returns the same error it persisted, with nothing reduced", async () => {
    // The other side of the rule: routing the returned error through what was recorded must not
    // change an error that recorded cleanly. No `degraded` marker, no substituted code.
    const result = await harness.runner.run(harness.manifest.runId, "stage-a", {});

    expect(result.error?.code).toBe(StageRunnerErrorCodes.STAGE_EXECUTION_FAILED);
    expect(result.error?.details?.["degraded"]).toBeUndefined();

    const { events } = await harness.workspace.events.read(harness.manifest.runId);
    const failed = events.find((event) => event.action === STAGE_EVENT_ACTIONS.attemptFailed);
    const state = await persisted();

    expect(result.error).toEqual(failed?.error);
    expect(result.error).toEqual(state.stages[0]?.execution.attempts[0]?.error);
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

  it("says the record is reduced, and how much of it was rejected", async () => {
    await harness.runner.run(harness.manifest.runId, "stage-a", {});

    const { events } = await harness.workspace.events.read(harness.manifest.runId);
    const failed = events.find((event) => event.action === STAGE_EVENT_ACTIONS.attemptFailed);

    expect(failed?.error?.code).toBe(StageRunnerErrorCodes.STAGE_TERMINAL_RECORD_DEGRADED);
    expect(failed?.error?.details?.["degraded"]).toBe(true);
    // How much was rejected, never where: the runner cannot prove a path's provenance through
    // the `EventStore` port, so no path is persisted (#255).
    expect(failed?.error?.details?.["rejectedPaths"]).toBeUndefined();
    expect(failed?.error?.details?.["withheldPathCount"]).toBe(1);
    expect(failed?.error?.message).toContain("the stage refused");
  });

  it("returns the error that was written down, not the one the schema refused", async () => {
    // The blocking half of #254 that survived the first fix: the reduced record reached the event
    // log and the cache, and `run` still returned the original — an error carrying a code no
    // schema accepts, handed to services, the CLI and MCP, and disagreeing with the Run record
    // they would read to explain it.
    const result = await harness.runner.run(harness.manifest.runId, "stage-a", {});

    expect(result.status).toBe("failed");
    expect(() => structuredErrorSchema.parse(result.error)).not.toThrow();
    expect(result.error?.code).toBe(StageRunnerErrorCodes.STAGE_TERMINAL_RECORD_DEGRADED);
    expect(result.error?.code).not.toBe(LONG_CODE);

    const { events } = await harness.workspace.events.read(harness.manifest.runId);
    const failed = events.find((event) => event.action === STAGE_EVENT_ACTIONS.attemptFailed);
    const state = await persisted();
    const cached = state.stages[0]?.execution.attempts[0]?.error;

    // Exactly the persisted error, in both places it is persisted — not merely the same code.
    expect(result.error).toEqual(failed?.error);
    expect(result.error).toEqual(cached);
  });

  it("does not inherit a path from the summary it quotes", async () => {
    // The degraded message embeds the refusal's own message verbatim, so Core naming a path there
    // would reach a durable record through this line whatever this function withheld.
    await harness.runner.run(harness.manifest.runId, "stage-a", {});

    const { events } = await harness.workspace.events.read(harness.manifest.runId);
    const failed = events.find((event) => event.action === STAGE_EVENT_ACTIONS.attemptFailed);

    expect(failed?.error?.message).toContain("AldusEvent failed schema validation (1 issue).");
  });

  it("keeps what the attempt reported, quoted inside the bound", async () => {
    await harness.runner.run(harness.manifest.runId, "stage-a", {});

    const state = await persisted();
    const error = state.stages[0]?.execution.attempts[0]?.error;
    expect(error?.code).toBe(StageRunnerErrorCodes.STAGE_TERMINAL_RECORD_DEGRADED);
    expect(error?.message).toContain("ALDUS_XXX");
  });
});

describe("a rejected path the runner cannot prove came from a schema (#255)", () => {
  /**
   * The blocker this pins. `StageRunnerOptions.events` is the `EventStore` port
   * (`packages/aldus-file-store/src/ports.ts:115`), not `FileEventStore`, and the port says
   * nothing about where a refusal's `details.issues[].path` comes from. So a conforming store may
   * reject with a path lifted from a key its *caller* supplied — a stage's `error.details` bag is
   * caller-keyed and unvalidated — and an identifier-shaped key is indistinguishable from a
   * schema field by shape. An earlier fix filtered by shape plus an argument about Core's schema
   * topology; neither is a fact about the port, so this store defeats both.
   */
  const CALLER_KEY = "AKIAABCDEFGHIJKLMNOP";

  /** The refusal message a store may emit, generic in the way Core's summary now is (#255). */
  const REFUSAL_MESSAGE = "AldusEvent failed schema validation (1 issue).";

  /**
   * A store that refuses the first event carrying an error, naming a path it took from that
   * error's own caller-supplied `details` bag, and then accepts the reduced event.
   *
   * Conforming on both counts: `append` stores an `AldusEvent` and returns it with a sequence,
   * and it rejects with a Core `StructuredError` of category `validation` in the documented
   * `details.issues[].path` shape. Nothing in the port forbids the path it chooses.
   */
  function rejectingStore(real: EventStore): EventStore {
    let refused = false;
    return {
      async append(runId, event) {
        if (!refused && event.error !== undefined) {
          refused = true;
          const key = Object.keys(event.error.details ?? {}).find((name) => name !== "degraded");
          throw new AldusError("ALDUS_EVENT_INVALID", REFUSAL_MESSAGE, {
            category: "validation",
            details: { issues: [{ path: key ?? CALLER_KEY, code: "too_big" }] },
          });
        }
        return real.append(runId, event);
      },
      read: (runId, options) => real.read(runId, options),
      nextSequence: (runId) => real.nextSequence(runId),
    };
  }

  let temp: TempRun;
  let spend: ReturnType<typeof recordingSpendController>;

  beforeEach(async () => {
    spend = recordingSpendController();
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
    temp = await makeTempRun({ workers, paidDispatch: spend, events: rejectingStore });
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
          throw new AldusError("ALDUS_STAGE_REFUSED", "the stage refused", {
            category: "policy",
            details: { [CALLER_KEY]: "y".repeat(6000) },
          });
        },
      }),
    );
  });

  afterEach(async () => {
    await temp.cleanup();
  });

  it("persists no rejected path at all, only a count of what it withheld", async () => {
    await temp.runner.run(temp.manifest.runId, "stage-a", {});

    const { events } = await temp.workspace.events.read(temp.manifest.runId);
    const failed = events.find((event) => event.action === STAGE_EVENT_ACTIONS.attemptFailed);

    expect(failed?.error?.code).toBe(StageRunnerErrorCodes.STAGE_TERMINAL_RECORD_DEGRADED);
    expect(failed?.error?.details?.["degraded"]).toBe(true);
    expect(failed?.error?.details?.["rejectedPaths"]).toBeUndefined();
    expect(failed?.error?.details?.["withheldPathCount"]).toBe(1);
    expect(failed?.error?.message).toContain(REFUSAL_MESSAGE);
    expect(failed?.error?.message).toContain("1 rejected path withheld.");
  });

  it("lets the caller's key reach neither the message nor the details, anywhere durable", async () => {
    const result = await temp.runner.run(temp.manifest.runId, "stage-a", {});

    // Whole records, not the two fields a fix happened to touch: the key was in the attempt's own
    // `error.details`, which the reduced record replaces, and a leak that reappeared through the
    // embedded attempt or the cache would still be a leak.
    const { events } = await temp.workspace.events.read(temp.manifest.runId);
    const raw = await readFile(temp.stageStatePath(temp.manifest.runId), "utf8");

    expect(JSON.stringify(events)).not.toContain(CALLER_KEY);
    expect(raw).not.toContain(CALLER_KEY);
    expect(JSON.stringify(result.error)).not.toContain(CALLER_KEY);
  });

  it("still reports the attempt as terminally failed, with its charge intact", async () => {
    const result = await temp.runner.run(temp.manifest.runId, "stage-a", {});

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe(StageRunnerErrorCodes.STAGE_TERMINAL_RECORD_DEGRADED);
    expect(() => structuredErrorSchema.parse(result.error)).not.toThrow();
    // The charge that made #254 costly: money recorded against a stage the record left running.
    expect(spend.written.map((record) => record.actual?.amount)).toEqual(["1.0931"]);

    const state = await persisted(temp);
    expect(state.stages[0]?.execution.status).toBe("failed");
    expect(state.stages[0]?.execution.attempts[0]?.status).toBe("failed");
  });

  it("returns exactly the error it persisted, in both places it persisted one", async () => {
    const result = await temp.runner.run(temp.manifest.runId, "stage-a", {});

    const { events } = await temp.workspace.events.read(temp.manifest.runId);
    const failed = events.find((event) => event.action === STAGE_EVENT_ACTIONS.attemptFailed);
    const state = await persisted(temp);

    expect(result.error).toEqual(failed?.error);
    expect(result.error).toEqual(state.stages[0]?.execution.attempts[0]?.error);
  });
});
