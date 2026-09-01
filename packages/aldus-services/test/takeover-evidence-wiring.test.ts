/**
 * The reported episode, composed end to end (#244).
 *
 * A long agent dispatch was killed by a harness timeout. The record kept `status: "running"`, the
 * stage became unrunnable without `--force`, and the refusal could say nothing about whether the
 * provider had been called — while the reservation store held exactly that fact, durably, the
 * whole time.
 *
 * These drive `AldusContext.runnerFor`, not a runner assembled by the test, because the finding
 * this closes is a **wiring** one: `StageRunner` held no spend port, and a port that exists and is
 * not connected is the defect, not the fix. A test that wired its own would pass over it.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ActorRef, AldusError } from "@aldus-runtime/core";
import { FileSpendReservationStore } from "@aldus-runtime/file-store";
import type { SpendGrant } from "@aldus-runtime/gate-engine";
import { GateRegistry } from "@aldus-runtime/gate-engine";
import { StageRegistry } from "@aldus-runtime/stage-runner";
import { builders, createTestContext } from "@aldus-runtime/testkit";

import { AldusContext } from "../src/context.js";
import { SpendService } from "../src/spend-service.js";
import type { CostRecordStore } from "../src/cost-store.js";
import { fixedClock, makeTempWorkspace, OPERATOR, type TempWorkspace } from "./helpers.js";
import { join } from "node:path";

import type { StageDefinition, StageOutcome } from "@aldus-runtime/stage-runner";

/** Passthrough validation: the stage's shape is not what any of these are about. */
const ANY_SCHEMA = {
  safeParse: (value: unknown) => ({ success: true as const, data: value }),
} as unknown as StageDefinition<unknown, unknown>["inputSchema"];

const STAGE = "outline.draft";
const ACTOR: ActorRef = OPERATOR;

let temp: TempWorkspace;

beforeEach(async () => {
  temp = await makeTempWorkspace();
});

afterEach(async () => {
  await temp.cleanup();
});

/** A stage whose first claim never returns — the killed dispatch — and whose next one completes. */
function killedThenRecovered(entered: () => void): StageDefinition<unknown, unknown> {
  let claims = 0;
  return {
    id: STAGE,
    version: "1",
    inputSchema: ANY_SCHEMA,
    outputSchema: ANY_SCHEMA,
    requiredCapabilities: [],
    artifacts: { produces: "none" },
    retrySafety: { kind: "no_external_effects" },
    execute: async (): Promise<StageOutcome<unknown>> => {
      claims += 1;
      if (claims > 1) return { kind: "completed", output: {} };
      entered();
      return await new Promise<never>(() => {});
    },
  };
}

/**
 * The same reservation store the context composes, at the same root.
 *
 * Written through the real `SpendService` rather than by hand: what the refusal reads has to be
 * what the runtime writes, and a fixture assembling transitions itself would prove only that the
 * test and the rule agree.
 */
function spendAt(root: string): SpendService {
  const costs: CostRecordStore = {
    list: () => Promise.resolve([]),
    append: () => Promise.resolve(),
  };
  return new SpendService({
    store: new FileSpendReservationStore({ root: join(root, "spend", "reservations") }),
    costs,
    now: fixedClock(),
  });
}

function grant(runId: string): SpendGrant {
  return {
    grantId: "grant-agent",
    runId,
    gateId: "agent.spend",
    decisionId: "decision-a",
    scope: { operations: ["agent.execute"] },
    maxTotal: { amount: "100.0000", currency: "USD" },
    maxPerRequest: { amount: "50.0000", currency: "USD" },
  };
}

/** Create a Run, leave `outline.draft` stuck in `running`, and hand back the refusal. */
async function stuckRun(prepare: (runId: string) => Promise<void>): Promise<{
  error: AldusError;
  runId: string;
  context: AldusContext;
}> {
  const stages = new StageRegistry();
  let entered!: () => void;
  const running = new Promise<void>((resolve) => {
    entered = resolve;
  });
  stages.register(killedThenRecovered(() => entered()));

  const context = new AldusContext({
    workspace: temp.workspace,
    gates: GateRegistry.from([]),
    stages,
    actor: ACTOR,
    subjects: () => Promise.resolve({}),
    now: fixedClock(),
  });

  const manifest = builders.RunManifest(undefined, createTestContext());
  await context.workspace.runs.create(manifest);
  const runId = manifest.runId;

  await prepare(runId);

  const runner = context.runnerFor(ACTOR);
  void runner.run(runId, STAGE, {});
  await running;

  try {
    await runner.run(runId, STAGE, {});
  } catch (error) {
    return { error: error as AldusError, runId, context };
  }
  throw new Error("expected the second run to be refused");
}

const ESTIMATED = { kind: "estimated", amount: { amount: "12.0000", currency: "USD" } } as const;

describe("the reported episode, with the reservation store consulted", () => {
  it("tells the operator no provider call was begun when the reservation was never dispatched", async () => {
    // Row 2 of §5: authorization committed, dispatch not begun. This is the window the whole
    // change exists for, and until now it read identically to the window where money may be gone.
    const { error } = await stuckRun(async (runId) => {
      const outcome = await spendAt(temp.root).reserve({
        grant: grant(runId),
        operation: "agent.execute",
        runId,
        stageId: STAGE,
        attemptId: "att-1",
        effectKey: "effect-a",
        expectation: ESTIMATED,
      });
      expect(outcome.reserved).toBe(true);
    });

    expect(error.message).toContain("none records a dispatch");
    expect(error.details).toMatchObject({ dispatchEvidence: "reserved_never_dispatched" });
  });

  it("warns that a paid call may have gone out once `dispatch_prepared` is on the stream", async () => {
    // The reported episode itself is this row, not the safe one: the dispatch was killed *during*
    // the provider call. The change does not make that operator's takeover easier — it stops the
    // two situations being reported identically, which is what was asked for.
    const { error } = await stuckRun(async (runId) => {
      const spend = spendAt(temp.root);
      const outcome = await spend.reserve({
        grant: grant(runId),
        operation: "agent.execute",
        runId,
        stageId: STAGE,
        attemptId: "att-1",
        effectKey: "effect-a",
        expectation: ESTIMATED,
      });
      if (!outcome.reserved) throw new Error("expected a reservation");
      await spend.prepareDispatch(outcome.reservation, {
        backendId: "backend-a",
        backendVersion: "1.0.0",
        ceilingEnforced: false,
      });
    });

    expect(error.message).toContain("Taking over may repeat a paid call");
    expect(error.details).toMatchObject({ dispatchEvidence: "dispatch_possible" });
  });

  it("keeps today's message for a stage that reserved nothing", async () => {
    // A free stage and an empty store are indistinguishable from here, so neither may be reported
    // as the safe row. The refusal is exactly what it was before the port existed.
    const { error } = await stuckRun(() => Promise.resolve());

    expect(error.message).toContain("an empty attempt is not evidence that nothing happened");
    expect(error.message).not.toContain("none records a dispatch");
    expect(error.details).toMatchObject({ dispatchEvidence: "indeterminate" });
  });

  it("keeps today's message when the reservation store cannot be read", async () => {
    // The composition seam's `try`/`catch`: could not look is never reported as nothing was spent.
    // Before the `FileSpendReservationStore` fix this path did not even throw — an unreadable
    // grant read as an empty one, and the safe row would have been claimed from a failed read.
    const { writeFile, mkdir } = await import("node:fs/promises");
    const { error } = await stuckRun(async (runId) => {
      const spend = spendAt(temp.root);
      await spend.reserve({
        grant: grant(runId),
        operation: "agent.execute",
        runId,
        stageId: STAGE,
        attemptId: "att-1",
        effectKey: "effect-a",
        expectation: ESTIMATED,
      });
      const broken = join(temp.root, "spend", "reservations", "grant-broken");
      await mkdir(broken, { recursive: true });
      await writeFile(join(broken, "commits"), "not a directory", "utf8");
    });

    expect(error.details).toMatchObject({ dispatchEvidence: "indeterminate" });
    expect(error.message).not.toContain("none records a dispatch");
  });

  it("still refuses without --force, and still takes over with it", async () => {
    // The friction is unchanged in the row where softening it would be most tempting.
    const { error, runId, context } = await stuckRun(async (rid) => {
      await spendAt(temp.root).reserve({
        grant: grant(rid),
        operation: "agent.execute",
        runId: rid,
        stageId: STAGE,
        attemptId: "att-1",
        effectKey: "effect-a",
        expectation: ESTIMATED,
      });
    });
    expect(error.message).toContain("pass `--force` to take over");

    const result = await context.runnerFor(ACTOR).run(runId, STAGE, {}, { force: true });
    expect(result.status).toBe("succeeded");
  });
});
