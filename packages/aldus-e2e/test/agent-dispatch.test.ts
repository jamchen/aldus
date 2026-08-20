/**
 * A Stage dispatches an agent execution explicitly, and the Runtime owns everything else (#107).
 *
 * The gap this closes: `AldusConfig.agentBackend` reached `StageRunner`, which called
 * `assertCapabilities` on it and never `execute`. `AgentExecutionService` was the only caller of
 * `AgentBackend.execute()` and no composition constructed one, so an adopter who configured a
 * backend could not dispatch it even deliberately.
 *
 * The fix is not to dispatch because a backend is configured. These assert both halves: the stage
 * has to ask, and when it does, identity, cancellation, ceiling, grant and attribution are the
 * Runtime's.
 */

import { afterEach, describe, expect, it } from "vitest";

import type { CostObservation } from "@aldus-runtime/core";
import type { SpendGrant } from "@aldus-runtime/gate-engine";
import type { AgentBackend, AgentRequest } from "@aldus-runtime/stage-runner";

import { makeStack, OPERATOR, SHOW_ID, type Stack } from "../src/index.js";

const anySchema = { safeParse: (value: unknown) => ({ success: true as const, data: value }) };
const RUN_ID = "run-agent-dispatch";
const OPERATION = "agent.execute";

let stack: Stack;

afterEach(async () => {
  await stack?.cleanup();
});

const grant: SpendGrant = {
  grantId: "grant-agent",
  runId: RUN_ID,
  gateId: "agent.spend",
  decisionId: "decision-agent",
  scope: { operations: [OPERATION] },
  maxTotal: { amount: "10.0000", currency: "USD" },
  maxPerRequest: { amount: "2.0000", currency: "USD" },
};

const charged: readonly CostObservation[] = [
  {
    provider: "provider-a",
    operation: "completion",
    billingStatus: "charged",
    actual: { amount: "1.5000", currency: "USD" },
  },
];

/** A backend that records what it was handed. */
function recordingBackend(
  options: { costs?: readonly CostObservation[]; pauses?: boolean; enforces?: boolean } = {},
) {
  const seen: AgentRequest[] = [];
  const backend: AgentBackend = {
    id: "backend-a",
    version: "1.0.0",
    capabilities: () =>
      Promise.resolve({
        offers: [],
        interactive: false,
        resumable: options.pauses === true,
        enforcesSpendCeiling: options.enforces ?? true,
      }),
    execute: (request) => {
      seen.push(request);
      return Promise.resolve({
        ok: true,
        ...(options.pauses === true
          ? { session: { sessionId: "session-1", backendId: "backend-a" } }
          : {}),
        ...(options.costs === undefined ? {} : { costs: options.costs }),
      });
    },
  };
  return { seen, backend };
}

/** A stage whose whole body is one `runAgent` call. */
function invokingStage(spend: unknown, capture?: { outcome?: unknown }) {
  return {
    id: "draft",
    version: "1",
    inputSchema: anySchema,
    outputSchema: anySchema,
    requiredCapabilities: [],
    artifacts: { produces: "none" },
    retrySafety: { kind: "no_external_effects" as const },
    execute: async (context: {
      runAgent: (request: Record<string, unknown>) => Promise<{ kind: string }>;
    }) => {
      const outcome = await context.runAgent({
        request: { instructions: "draft the outline" },
        effect: { kind: "none" },
        spend,
      });
      if (capture !== undefined) capture.outcome = outcome;
      return { kind: "completed" as const, output: { agent: outcome.kind } };
    },
  };
}

async function run(options: {
  spend: unknown;
  backend?: AgentBackend;
  grants?: boolean;
  capture?: { outcome?: unknown };
}) {
  stack = await makeStack({
    stages: () => [invokingStage(options.spend, options.capture) as never],
    ...(options.backend === undefined ? {} : { agentBackend: options.backend }),
    ...(options.grants === false ? {} : { dispatchSpendGrants: () => grant }),
  });
  await stack.services.init({ episode: { showId: SHOW_ID, slug: "episode-a" }, actor: OPERATOR });
  await stack.services.startRun({
    workflowId: "workflow-a",
    workflowVersion: "1",
    runId: RUN_ID,
    actor: OPERATOR,
  });
  return stack.services.runStage({ runId: RUN_ID, stageId: "draft", actor: OPERATOR });
}

async function costRecords() {
  const report = await stack.services.costs(RUN_ID);
  if (report.outcome !== "ok") throw new Error(`cost report was "${report.outcome}"`);
  return report.data.records;
}

const paidSpend = {
  expectation: { kind: "estimated", amount: { amount: "1.0000", currency: "USD" } },
  operation: OPERATION,
  billingEffectKey: "draft:take-1",
};

describe("a configured backend is a capability source, not an instruction", () => {
  it("dispatches nothing when the stage does not ask", async () => {
    // The constraint the ruling made binding. A stage that never calls `runAgent` must not reach
    // the backend merely because one is wired.
    const recording = recordingBackend({ costs: charged });
    stack = await makeStack({
      agentBackend: recording.backend,
      dispatchSpendGrants: () => grant,
      stages: () => [
        {
          id: "quiet",
          version: "1",
          inputSchema: anySchema,
          outputSchema: anySchema,
          requiredCapabilities: [],
          artifacts: { produces: "none" },
          retrySafety: { kind: "no_external_effects" as const },
          execute: () => Promise.resolve({ kind: "completed" as const, output: {} }),
        } as never,
      ],
    });
    await stack.services.init({ episode: { showId: SHOW_ID, slug: "episode-a" }, actor: OPERATOR });
    await stack.services.startRun({
      workflowId: "workflow-a",
      workflowVersion: "1",
      runId: RUN_ID,
      actor: OPERATOR,
    });

    const result = await stack.services.runStage({
      runId: RUN_ID,
      stageId: "quiet",
      actor: OPERATOR,
    });

    expect(result.outcome).toBe("ok");
    expect(recording.seen).toHaveLength(0);
  });

  it("refuses runAgent when no backend is configured", async () => {
    // Refused rather than silently doing nothing — the composed path an adopter has before they
    // wire a backend.
    const result = await run({ spend: paidSpend });
    expect(result.outcome).not.toBe("ok");
  });
});

describe("the Runtime owns the request fields a Stage must not set", () => {
  it("mints the execution id and passes its own cancellation signal", async () => {
    const recording = recordingBackend({ costs: charged });
    const result = await run({ spend: paidSpend, backend: recording.backend });

    expect(result.outcome).toBe("ok");
    expect(recording.seen).toHaveLength(1);
    // The Stage's type cannot carry these, and the Runtime supplies both.
    expect(recording.seen[0]?.executionId).toBeTruthy();
    expect(recording.seen[0]?.signal).toBeInstanceOf(AbortSignal);
    // The Stage's own half survived unchanged.
    expect(recording.seen[0]?.instructions).toBe("draft the outline");
  });

  it("applies the reserved ceiling, from the grant rather than the backend", async () => {
    const recording = recordingBackend({ costs: charged });
    await run({ spend: paidSpend, backend: recording.backend });

    // What the grant authorized for this request. A backend saying it enforces a ceiling does not
    // get to say what the ceiling is.
    expect(recording.seen[0]?.maxSpend).toEqual({ amount: "1.0000", currency: "USD" });
  });

  it("passes no ceiling to a backend that does not enforce one", async () => {
    const recording = recordingBackend({ costs: charged, enforces: false });
    await run({ spend: paidSpend, backend: recording.backend });

    expect(recording.seen[0]?.maxSpend).toBeUndefined();
  });
});

describe("what an agent execution costs becomes a CostRecord", () => {
  it("settles the charge and reports it with Runtime attribution", async () => {
    const recording = recordingBackend({ costs: charged });
    const result = await run({ spend: paidSpend, backend: recording.backend });

    expect(result.outcome).toBe("ok");
    const records = await costRecords();
    expect(records).toHaveLength(1);
    expect(records[0]?.provider).toBe("provider-a");
    expect(records[0]?.runId).toBe(RUN_ID);
    expect(records[0]?.stageId).toBe("draft");
    expect(records[0]?.authorizationId).toBe(grant.decisionId);
  });

  it("refuses a paid execution when no grant authorizes the operation", async () => {
    const recording = recordingBackend({ costs: charged });
    const result = await run({
      spend: paidSpend,
      backend: recording.backend,
      grants: false,
    });

    expect(result.outcome).not.toBe("ok");
    // Pre-dispatch. A refusal after the provider call is not a refusal.
    expect(recording.seen).toHaveLength(0);
  });
});

describe("a backend that pauses", () => {
  it("reports an explicit unsupported-pause outcome, never a completion", async () => {
    // A nullable `session` on a result whose `ok` is true reads as success. The outcome is a
    // discriminated union so a Stage has to narrow before it can claim anything happened.
    const recording = recordingBackend({ costs: charged, pauses: true });
    const capture: { outcome?: unknown } = {};
    const result = await run({ spend: paidSpend, backend: recording.backend, capture });

    expect(result.outcome).toBe("ok");
    const outcome = capture.outcome as { kind: string; explanation: string };
    expect(outcome.kind).toBe("paused_unsupported");
    expect(outcome.explanation).toContain("does not resume");

    // Whatever was billed before the pause is recorded. A pause is not evidence of no charge.
    const records = await costRecords();
    expect(records).toHaveLength(1);
    expect(records[0]?.actual).toEqual({ amount: "1.5000", currency: "USD" });
  });
});

describe("a Stage cannot reclaim the fields the Runtime owns", () => {
  it("overrides an execution id, signal and ceiling smuggled into the request", async () => {
    // The type omits all three, so this is the JavaScript adopter — or a request assembled from
    // configuration. The Runtime's values go on last, so they win rather than being merged over.
    const recording = recordingBackend({ costs: charged });
    stack = await makeStack({
      agentBackend: recording.backend,
      dispatchSpendGrants: () => grant,
      stages: () => [
        {
          id: "draft",
          version: "1",
          inputSchema: anySchema,
          outputSchema: anySchema,
          requiredCapabilities: [],
          artifacts: { produces: "none" },
          retrySafety: { kind: "no_external_effects" as const },
          execute: async (context: {
            runAgent: (request: Record<string, unknown>) => Promise<{ kind: string }>;
          }) => {
            await context.runAgent({
              request: {
                instructions: "draft the outline",
                executionId: "chosen-by-the-stage",
                maxSpend: { amount: "999.0000", currency: "USD" },
              },
              effect: { kind: "none" },
              spend: paidSpend,
            });
            return { kind: "completed" as const, output: {} };
          },
        } as never,
      ],
    });
    await stack.services.init({ episode: { showId: SHOW_ID, slug: "episode-a" }, actor: OPERATOR });
    await stack.services.startRun({
      workflowId: "workflow-a",
      workflowVersion: "1",
      runId: RUN_ID,
      actor: OPERATOR,
    });

    const result = await stack.services.runStage({
      runId: RUN_ID,
      stageId: "draft",
      actor: OPERATOR,
    });

    expect(result.outcome).toBe("ok");
    expect(recording.seen[0]?.executionId).not.toBe("chosen-by-the-stage");
    // The grant's, not the 999 the stage asked for. A spender does not choose its own limit.
    expect(recording.seen[0]?.maxSpend).toEqual({ amount: "1.0000", currency: "USD" });
  });
});

describe("one declared billing effect cannot cover several agent charges", () => {
  it("refuses a plural independent-charge result and records every charge", async () => {
    // `AgentResult.costs` is plural because one execution may incur several model, provider or
    // tool charges. Settling several *independent* ones against one reservation would let a
    // single approval cover N — the same rule the Worker path follows (ADR-0043, ADR-0046).
    const recording = recordingBackend({
      costs: [
        {
          provider: "provider-a",
          operation: "completion",
          billingStatus: "charged",
          actual: { amount: "0.5000", currency: "USD" },
        },
        {
          provider: "provider-b",
          operation: "embedding",
          billingStatus: "charged",
          actual: { amount: "0.2500", currency: "USD" },
        },
      ],
    });
    const result = await run({ spend: paidSpend, backend: recording.backend });

    expect(result.outcome).not.toBe("ok");
    // Recorded and attributed: the money is already spent. What is withheld is the claim that one
    // reservation covered both.
    const records = await costRecords();
    expect(records.map((record) => record.provider).sort()).toEqual(["provider-a", "provider-b"]);
  });

  it("accepts one charge alongside free observations", async () => {
    const recording = recordingBackend({
      costs: [
        {
          provider: "provider-a",
          operation: "warmup",
          billingStatus: "free",
          actual: { amount: "0.0000", currency: "USD" },
        },
        {
          provider: "provider-a",
          operation: "completion",
          billingStatus: "charged",
          actual: { amount: "0.5000", currency: "USD" },
        },
      ],
    });
    const result = await run({ spend: paidSpend, backend: recording.backend });

    expect(result.outcome).toBe("ok");
    expect(await costRecords()).toHaveLength(2);
  });
});

describe("a charge whose amount could not be established", () => {
  /** An unknown, unquantified charge — the case §19.3 exists for. */
  const unknownCharge: readonly CostObservation[] = [
    { provider: "provider-a", operation: "completion", billingStatus: "unknown" },
  ];

  it("is not reported to the Stage as completed", async () => {
    // The defect: `AgentExecutionService` computes `billingUnconfirmed` from durable records and
    // its contract says a caller must not silently retry when it is true. The adapter returned
    // only `outcome.result`, and `runAgent` discriminated on `result.session` alone — so an
    // execution whose reservation was still `billing_unknown` arrived as `completed`.
    const recording = recordingBackend({ costs: unknownCharge });
    const capture: { outcome?: unknown } = {};
    const result = await run({ spend: paidSpend, backend: recording.backend, capture });

    expect(result.outcome).toBe("ok");
    const outcome = capture.outcome as { kind: string; paused: boolean; explanation: string };
    expect(outcome.kind).toBe("billing_unresolved");
    expect(outcome.kind).not.toBe("completed");
    expect(outcome.paused).toBe(false);
    expect(outcome.explanation).toContain("not retryable");
  });

  it("keeps the reservation unresolved, so authorization is not restored", async () => {
    const recording = recordingBackend({ costs: unknownCharge });
    await run({ spend: paidSpend, backend: recording.backend });

    // The charge is durable — an unknown amount is still a charge — and the reservation still
    // stands against the grant.
    const records = await costRecords();
    expect(records).toHaveLength(1);
    expect(records[0]?.billingStatus).toBe("unknown");
    expect(records[0]?.actual).toBeUndefined();
  });

  it("retains both facts when the backend also pauses", async () => {
    // One unambiguous outcome. Splitting these into separate arms would let a caller reading for
    // a pause miss the unresolved billing, or the reverse — and unresolved billing is the fact
    // that governs what may be done next.
    const recording = recordingBackend({ costs: unknownCharge, pauses: true });
    const capture: { outcome?: unknown } = {};
    await run({ spend: paidSpend, backend: recording.backend, capture });

    const outcome = capture.outcome as { kind: string; paused: boolean; explanation: string };
    expect(outcome.kind).toBe("billing_unresolved");
    expect(outcome.paused).toBe(true);
    expect(outcome.explanation).toContain("paused");
  });

  it("still reports a resolved charge as completed", async () => {
    // The control. `billing_unresolved` must not swallow the ordinary path.
    const recording = recordingBackend({ costs: charged });
    const capture: { outcome?: unknown } = {};
    await run({ spend: paidSpend, backend: recording.backend, capture });

    expect((capture.outcome as { kind: string }).kind).toBe("completed");
  });
});

describe("a backend that says nothing about billing", () => {
  it("does not release authorization, and is not reported as completed", async () => {
    // Silence is not "no charges". The backend was dispatched under a paid expectation and came
    // back saying nothing, so whether it was charged is unknown — and `settle` treating an empty
    // observation array as evidence of no charge released the reservation on the strength of a
    // provider that said nothing.
    //
    // The Worker path in this same stack already answers this correctly. Two answers to one
    // question, one method apart, is what this closes.
    const recording = recordingBackend();
    const capture: { outcome?: unknown } = {};
    const result = await run({ spend: paidSpend, backend: recording.backend, capture });

    expect(result.outcome).toBe("ok");
    expect(recording.seen).toHaveLength(1);
    const outcome = capture.outcome as { kind: string };
    expect(outcome.kind).toBe("billing_unresolved");
    expect(outcome.kind).not.toBe("completed");
    // Nothing recorded, and nothing released: the reservation still stands against the grant.
    expect(await costRecords()).toHaveLength(0);
  });

  it("still completes when the backend says nothing was owed", async () => {
    // The control. `free` and `voided` are a provider stating nothing is owed, which is evidence
    // rather than the absence of it, and must keep releasing.
    const recording = recordingBackend({
      costs: [
        {
          provider: "provider-a",
          operation: "completion",
          billingStatus: "free",
          actual: { amount: "0.0000", currency: "USD" },
        },
      ],
    });
    const capture: { outcome?: unknown } = {};
    const result = await run({ spend: paidSpend, backend: recording.backend, capture });

    expect(result.outcome).toBe("ok");
    expect((capture.outcome as { kind: string }).kind).toBe("completed");
    expect(await costRecords()).toHaveLength(1);
  });
});

describe("a ceiling never travels from the Stage to the provider", () => {
  it("strips a smuggled maxSpend before a non-enforcing backend sees it", async () => {
    // The override existed only in the enforcing branch; the other passed the Stage's object
    // through untouched, `maxSpend` included. The trace then recorded `ceilingEnforced: false`
    // while a Stage-authored ceiling had been transmitted — a limit in front of a provider that
    // nobody authorized and nothing records.
    const recording = recordingBackend({ costs: charged, enforces: false });
    stack = await makeStack({
      agentBackend: recording.backend,
      dispatchSpendGrants: () => grant,
      stages: () => [
        {
          id: "draft",
          version: "1",
          inputSchema: anySchema,
          outputSchema: anySchema,
          requiredCapabilities: [],
          artifacts: { produces: "none" },
          retrySafety: { kind: "no_external_effects" as const },
          execute: async (context: {
            runAgent: (request: Record<string, unknown>) => Promise<{ kind: string }>;
          }) => {
            await context.runAgent({
              request: {
                instructions: "draft the outline",
                maxSpend: { amount: "999.0000", currency: "USD" },
              },
              effect: { kind: "none" },
              spend: paidSpend,
            });
            return { kind: "completed" as const, output: {} };
          },
        } as never,
      ],
    });
    await stack.services.init({ episode: { showId: SHOW_ID, slug: "episode-a" }, actor: OPERATOR });
    await stack.services.startRun({
      workflowId: "workflow-a",
      workflowVersion: "1",
      runId: RUN_ID,
      actor: OPERATOR,
    });

    const result = await stack.services.runStage({
      runId: RUN_ID,
      stageId: "draft",
      actor: OPERATOR,
    });

    expect(result.outcome).toBe("ok");
    // Absent, not overridden with a smaller number: this backend declares it enforces nothing, so
    // any ceiling reaching it would record a protection that does not exist (ADR-0030).
    expect(recording.seen[0]?.maxSpend).toBeUndefined();
  });
});
