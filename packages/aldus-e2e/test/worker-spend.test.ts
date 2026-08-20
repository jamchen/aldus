/**
 * A paid Worker cannot be dispatched without a committed reservation (#107, ADR-0046).
 *
 * These replace a list of surface names. `no-spend-bypass.test.ts` enumerated
 * `["SynthesisGateway", "AgentExecutionService"]` and asserted each was exported with a spend
 * service — which was true, and said nothing about `runWorker`, the third paid path. The list went
 * stale the moment the Worker cost channel landed, and a measurement is what found it:
 *
 * ```
 * STAGE OUTCOME: ok
 * COST REPORT: { "records": [], "summary": { "recordCount": 0, ... } }
 * ```
 *
 * after a Worker reported `actual: 2.00 USD, billingStatus: "charged"`.
 *
 * So these assert behaviour through the composed stack instead. A name list cannot go stale if
 * nothing consults it.
 */

import { afterEach, describe, expect, it } from "vitest";

import type { CostObservation } from "@aldus-runtime/core";
import type { SpendGrant } from "@aldus-runtime/gate-engine";
import { WorkerRegistry } from "@aldus-runtime/stage-runner";

import { makeStack, OPERATOR, SHOW_ID, type Stack } from "../src/index.js";

const anySchema = { safeParse: (value: unknown) => ({ success: true as const, data: value }) };
const RUN_ID = "run-worker-spend";
const OPERATION = "worker.render";

let stack: Stack;

afterEach(async () => {
  await stack?.cleanup();
});

const grant: SpendGrant = {
  grantId: "grant-worker",
  runId: RUN_ID,
  gateId: "worker.spend",
  decisionId: "decision-worker",
  scope: { operations: [OPERATION] },
  maxTotal: { amount: "10.0000", currency: "USD" },
  maxPerRequest: { amount: "2.0000", currency: "USD" },
  // Without this an unestimated request is refused before dispatch, which is the right default and
  // not what the two tests below are about.
  unestimatedExecution: "reserve_max_per_request",
};

/** Records every call, so "was the provider reached" is answerable rather than inferred. */
function payingWorker(options: { costs?: readonly CostObservation[]; throws?: boolean } = {}) {
  const calls: { maxSpend?: unknown }[] = [];
  return {
    calls,
    worker: {
      id: "renderer",
      version: "1",
      capabilities: () => Promise.resolve({ offers: [], enforcesSpendCeiling: true }),
      execute: (request: { maxSpend?: unknown }) => {
        calls.push({ maxSpend: request.maxSpend });
        if (options.throws === true) return Promise.reject(new Error("provider exploded"));
        return Promise.resolve({
          output: { ok: true },
          ...(options.costs === undefined ? {} : { costs: options.costs }),
        });
      },
    },
  };
}

/** A stage whose whole body is one Worker invocation with the spend declaration under test. */
function invokingStage(spend: unknown) {
  return {
    id: "render",
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
        workerId: "renderer",
        workerVersion: "1",
        input: {},
        effect: { kind: "none" },
        spend,
      });
      return { kind: "completed" as const, output: result.output };
    },
  };
}

async function run(options: {
  spend: unknown;
  worker: { id: string; version: string };
  grants?: boolean;
}) {
  const registry = new WorkerRegistry();
  registry.register(options.worker as never);
  stack = await makeStack({
    workers: registry,
    stages: () => [invokingStage(options.spend) as never],
    ...(options.grants === false ? {} : { workerSpendGrants: () => grant }),
  });
  await stack.services.init({ episode: { showId: SHOW_ID, slug: "episode-a" }, actor: OPERATOR });
  await stack.services.startRun({
    workflowId: "workflow-a",
    workflowVersion: "1",
    runId: RUN_ID,
    actor: OPERATOR,
  });
  return stack.services.runStage({ runId: RUN_ID, stageId: "render", actor: OPERATOR });
}

/** Cost records for the Run, through the composed report an operator actually reads. */
async function costRecords() {
  const report = await stack.services.costs(RUN_ID);
  if (report.outcome !== "ok") throw new Error(`cost report was "${report.outcome}"`);
  return report.data.records;
}

const charged: readonly CostObservation[] = [
  {
    provider: "provider-a",
    operation: "render",
    billingStatus: "charged",
    actual: { amount: "1.5000", currency: "USD" },
  },
];

describe("a paid Worker reaches no provider without a reservation", () => {
  it("refuses an invocation that declares nothing about cost", async () => {
    const paying = payingWorker({ costs: charged });
    const result = await run({ spend: undefined, worker: paying.worker });

    expect(result.outcome).not.toBe("ok");
    // The refusal is pre-dispatch. A refusal that arrives after the provider was called is not a
    // refusal, and this is the assertion that says so.
    expect(paying.calls).toHaveLength(0);
  });

  it("refuses a paid invocation when no grant authorizes the operation", async () => {
    const paying = payingWorker({ costs: charged });
    const result = await run({
      spend: {
        expectation: { kind: "estimated", amount: { amount: "1.0000", currency: "USD" } },
        operation: OPERATION,
        billingEffectKey: "render:take-1",
      },
      worker: paying.worker,
      grants: false,
    });

    expect(result.outcome).not.toBe("ok");
    expect(paying.calls).toHaveLength(0);
  });

  it("refuses a paid invocation the grant's scope does not cover", async () => {
    const paying = payingWorker({ costs: charged });
    const result = await run({
      spend: {
        expectation: { kind: "estimated", amount: { amount: "1.0000", currency: "USD" } },
        // The grant authorizes `worker.render` and this asks for something else.
        operation: "worker.transcribe",
        billingEffectKey: "transcribe:take-1",
      },
      worker: paying.worker,
    });

    expect(result.outcome).not.toBe("ok");
    expect(paying.calls).toHaveLength(0);
  });

  it("refuses an estimate the grant's per-request ceiling will not cover", async () => {
    const paying = payingWorker({ costs: charged });
    const result = await run({
      spend: {
        // Ceiling is 2.0000.
        expectation: { kind: "estimated", amount: { amount: "5.0000", currency: "USD" } },
        operation: OPERATION,
        billingEffectKey: "render:take-1",
      },
      worker: paying.worker,
    });

    expect(result.outcome).not.toBe("ok");
    expect(paying.calls).toHaveLength(0);
  });
});

describe("what a paid Worker reports becomes a CostRecord", () => {
  it("settles the charge and reports it in the composed cost report", async () => {
    const paying = payingWorker({ costs: charged });
    const result = await run({
      spend: {
        expectation: { kind: "estimated", amount: { amount: "1.0000", currency: "USD" } },
        operation: OPERATION,
        billingEffectKey: "render:take-1",
      },
      worker: paying.worker,
    });

    expect(result.outcome).toBe("ok");
    expect(paying.calls).toHaveLength(1);

    // The measurement that opened #107, inverted. This is the assertion the old surface-name list
    // could not make.
    const records = await costRecords();
    expect(records).toHaveLength(1);
    expect(records[0]?.provider).toBe("provider-a");
    expect(records[0]?.actual).toEqual({ amount: "1.5000", currency: "USD" });
    // Attribution is the Runtime's. The Worker stated billing facts and nothing else.
    expect(records[0]?.runId).toBe(RUN_ID);
    expect(records[0]?.stageId).toBe("render");
    expect(records[0]?.authorizationId).toBe(grant.decisionId);
    expect(records[0]?.reservationId).toBeDefined();
  });

  it("hands the Worker the grant's ceiling, not its own claim", async () => {
    const paying = payingWorker({ costs: charged });
    await run({
      spend: {
        expectation: { kind: "estimated", amount: { amount: "1.0000", currency: "USD" } },
        operation: OPERATION,
        billingEffectKey: "render:take-1",
      },
      worker: paying.worker,
    });

    // What the grant authorized for *this* request, which is the estimate it committed — not the
    // grant's maximum, which would let the Worker spend more than was reserved. Either way the
    // number is the Runtime's: the Worker declared that it enforces a ceiling and did not get to
    // say what the ceiling is.
    expect(paying.calls[0]?.maxSpend).toEqual({ amount: "1.0000", currency: "USD" });
  });

  it("passes no ceiling to a Worker that does not enforce one", async () => {
    const paying = payingWorker({ costs: charged });
    paying.worker.capabilities = () => Promise.resolve({ offers: [], enforcesSpendCeiling: false });
    await run({
      spend: {
        expectation: { kind: "estimated", amount: { amount: "1.0000", currency: "USD" } },
        operation: OPERATION,
        billingEffectKey: "render:take-1",
      },
      worker: paying.worker,
    });

    // Absent rather than passed-and-ignored. A number handed to a Worker that ignores it reads,
    // in the trace, like a protection that was applied (ADR-0030).
    expect(paying.calls[0]?.maxSpend).toBeUndefined();
  });
});

describe("a paid Worker that says nothing about billing", () => {
  it("stays unknown and non-retryable rather than being released as free", async () => {
    const paying = payingWorker();
    const result = await run({
      spend: {
        expectation: { kind: "unestimated" },
        operation: OPERATION,
        billingEffectKey: "render:take-1",
      },
      worker: paying.worker,
    });

    expect(result.outcome).not.toBe("ok");
    expect(paying.calls).toHaveLength(1);
    // No record, because there is no billing fact to record — and deliberately not a zero. The
    // reservation stays committed against the grant, so the budget is not silently restored for
    // money that may already be gone (§19.3).
    expect(await costRecords()).toHaveLength(0);
  });

  it("keeps the reservation when the Worker throws after dispatch", async () => {
    const paying = payingWorker({ throws: true });
    const result = await run({
      spend: {
        expectation: { kind: "unestimated" },
        operation: OPERATION,
        billingEffectKey: "render:take-1",
      },
      worker: paying.worker,
    });

    expect(result.outcome).not.toBe("ok");
    expect(paying.calls).toHaveLength(1);
  });
});

describe("a Worker declared free that charges anyway", () => {
  it("records the charge without a grant and fails the stage", async () => {
    const paying = payingWorker({ costs: charged });
    const result = await run({
      spend: { expectation: { kind: "free" } },
      worker: paying.worker,
    });

    expect(result.outcome).not.toBe("ok");

    const records = await costRecords();
    // Durably recorded: §20 must be able to answer what the Run cost, and an unrecorded charge
    // is the state #107 reported.
    expect(records).toHaveLength(1);
    expect(records[0]?.provider).toBe("provider-a");
    // And credited to nothing. Attaching a grant after the fact would invent an approval.
    expect(records[0]?.authorizationId).toBeUndefined();
  });
});
