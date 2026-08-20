/**
 * Dispatching an agent execution and recording what it cost (#107).
 *
 * `AgentResult.costs` existed and nothing produced one — `StageRunner` checks a backend's
 * capabilities and never calls `execute` — so an adopter's $7.05 across six executions could not
 * be recorded at all. These cover the composition that closes it.
 */

import { describe, expect, it } from "vitest";

import {
  SCHEMA_VERSION,
  type ActorRef,
  type AldusEvent,
  type CostRecord,
} from "@aldus-runtime/core";
import { checkSpend, type SpendGrant } from "@aldus-runtime/gate-engine";
import type { AgentBackend } from "@aldus-runtime/stage-runner";

import { AgentExecutionService, type CostRecordStore } from "../src/agent-execution.js";
import { summariseCosts } from "../src/costs.js";

const ACTOR: ActorRef = { kind: "agent", id: "claude" };
const RUN = "run-a";

const GRANT: SpendGrant = {
  grantId: "grant-1",
  runId: RUN,
  gateId: "performance.freeze",
  decisionId: "decision-7",
  maxTotal: { amount: "10.00", currency: "USD" },
  maxPerRequest: { amount: "2.00", currency: "USD" },
};

/** An in-memory store, so a test can read back what the runtime attributed. */
function costStore(seed: CostRecord[] = []): CostRecordStore & { records: CostRecord[] } {
  const records = [...seed];
  return {
    records,
    list: () => Promise.resolve([...records]),
    append: (_runId, record) => {
      records.push(record);
      return Promise.resolve();
    },
  };
}

function eventSink(): {
  append(runId: string, event: AldusEvent): Promise<void>;
  events: AldusEvent[];
} {
  const events: AldusEvent[] = [];
  return {
    events,
    append: (_runId, event) => {
      events.push(event);
      return Promise.resolve();
    },
  };
}

function backend(overrides: Partial<AgentBackend> = {}): AgentBackend {
  return {
    id: "backend-a",
    capabilities: () => Promise.resolve({ offers: [], interactive: false, resumable: false }),
    execute: () => Promise.resolve({ ok: true }),
    ...overrides,
  };
}

function serviceWith(options: {
  backend?: AgentBackend;
  costs?: ReturnType<typeof costStore>;
  events?: ReturnType<typeof eventSink>;
}) {
  const costs = options.costs ?? costStore();
  const events = options.events ?? eventSink();
  const service = new AgentExecutionService({
    backend: options.backend ?? backend(),
    costs,
    events,
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    newCostId: (() => {
      let n = 0;
      return () => `cost-${(n += 1)}`;
    })(),
  });
  return { service, costs, events };
}

const base = {
  runId: RUN,
  episodeId: "episode-a",
  stageId: "outline.draft",
  attemptId: "att-1",
  actor: ACTOR,
  request: { prompt: "draft it" } as never,
};

describe("an agent execution's cost is recorded with the runtime's attribution", () => {
  it("attributes a reported charge to the run, stage, attempt and authorization", async () => {
    const { service, costs } = serviceWith({
      backend: backend({
        execute: () =>
          Promise.resolve({
            ok: true,
            costs: [
              {
                provider: "provider-a",
                operation: "agent.execute",
                actual: { amount: "1.05", currency: "USD" },
                billingStatus: "charged",
              },
            ],
          }),
      }),
    });

    const outcome = await service.execute({ ...base, grant: GRANT });

    expect(outcome.costs).toHaveLength(1);
    const record = outcome.costs[0] as CostRecord;
    expect(record.runId).toBe(RUN);
    expect(record.stageId).toBe("outline.draft");
    expect(record.attemptId).toBe("att-1");
    // The link back to the approval that permitted the spend, supplied by the runtime — never
    // by the backend, which is the silent budget-bypass this exists to prevent.
    expect(record.authorizationId).toBe("decision-7");
    expect(record.actual).toEqual({ amount: "1.05", currency: "USD" });
    expect(costs.records).toHaveLength(1);
  });

  it("records a charge on a failed execution", async () => {
    // A provider may charge for a request that fails. A cost channel surviving only success loses
    // exactly the spend an operator most needs to see.
    const { service } = serviceWith({
      backend: backend({
        execute: () =>
          Promise.resolve({
            ok: false,
            error: { code: "PROVIDER_TIMEOUT", message: "timed out", category: "io" } as never,
            costs: [
              {
                provider: "provider-a",
                operation: "agent.execute",
                actual: { amount: "0.40", currency: "USD" },
                billingStatus: "charged",
              },
            ],
          }),
      }),
    });

    const outcome = await service.execute({ ...base, grant: GRANT });

    expect(outcome.result.ok).toBe(false);
    expect(outcome.costs).toHaveLength(1);
  });

  it("surfaces an unconfirmed billing status rather than letting a caller retry blindly", async () => {
    // §19.3. A caller must not silently retry: an unconfirmed charge may have landed, and
    // re-running would spend again on the assumption it did not.
    const { service } = serviceWith({
      backend: backend({
        execute: () =>
          Promise.resolve({
            ok: false,
            costs: [
              {
                provider: "provider-a",
                operation: "agent.execute",
                estimated: { amount: "0.90", currency: "USD" },
                billingStatus: "unknown",
              },
            ],
          }),
      }),
    });

    const outcome = await service.execute({ ...base, grant: GRANT });

    expect(outcome.billingUnconfirmed).toBe(true);
  });

  it("links the execution and its cost records in the trace", async () => {
    const { service, events } = serviceWith({
      backend: backend({
        execute: () =>
          Promise.resolve({
            ok: true,
            costs: [
              {
                provider: "provider-a",
                operation: "agent.execute",
                actual: { amount: "1.05", currency: "USD" },
                billingStatus: "charged",
              },
            ],
          }),
      }),
    });

    await service.execute({ ...base, grant: GRANT });

    const event = events.events.at(-1);
    expect(event?.action).toBe("agent.executed");
    expect(event?.attemptId).toBe("att-1");
    expect((event?.details as { costIds?: string[] })?.costIds).toEqual(["cost-1"]);
  });
});

describe("an unattributed charge is invisible to the budget", () => {
  it("draws down the grant only because the runtime attributed it", async () => {
    // The sharpest form of why `authorizationId` is not the backend's to supply. `computeLedger`
    // counts a cost against a grant only when its authorizationId names that grant's decision —
    // so a backend that forgot to copy it would not merely lose an audit link, it would produce a
    // charge the budget cannot see. Spend would silently exceed its ceiling with every record
    // present and correct.
    const costs = costStore();
    const { service } = serviceWith({
      costs,
      backend: backend({
        execute: () =>
          Promise.resolve({
            ok: true,
            costs: [
              {
                provider: "provider-a",
                operation: "agent.execute",
                actual: { amount: "3.00", currency: "USD" },
                billingStatus: "charged",
              },
            ],
          }),
      }),
    });

    await service.execute({ ...base, grant: GRANT });

    const recorded = costs.records[0] as CostRecord;
    expect(recorded.authorizationId).toBe(GRANT.decisionId);
    // And therefore it counts: a second execution estimating more than the remainder is refused.
    await expect(
      service.execute({ ...base, grant: GRANT, estimated: { amount: "8.00", currency: "USD" } }),
    ).rejects.toMatchObject({ code: "ALDUS_SPEND_NOT_AUTHORIZED" });
  });
});

describe("spend is checked before the effect, not after", () => {
  it("refuses an estimate with no grant to check it against", async () => {
    const { service } = serviceWith({});
    await expect(
      service.execute({ ...base, estimated: { amount: "1.00", currency: "USD" } }),
    ).rejects.toMatchObject({ code: "ALDUS_SPEND_NOT_AUTHORIZED" });
  });

  it("refuses when the grant is already exhausted, and the backend never runs", async () => {
    // The load-bearing half: a refusal that arrives once the provider has been billed is not a
    // refusal, so the assertion is that `execute` was never reached.
    let dispatched = false;
    const spent: CostRecord[] = [
      {
        schemaVersion: "1.6",
        costId: "cost-old",
        runId: RUN,
        provider: "provider-a",
        operation: "agent.execute",
        actual: { amount: "9.50", currency: "USD" },
        billingStatus: "charged",
        // Without this the charge draws down nothing: `computeLedger` counts only costs whose
        // authorizationId names the grant's decision. That is the mechanism, and it is why the
        // runtime supplies the field rather than the backend.
        authorizationId: "decision-7",
        recordedAt: "2026-01-01T00:00:00.000Z",
      },
    ];
    const { service } = serviceWith({
      costs: costStore(spent),
      backend: backend({
        execute: () => {
          dispatched = true;
          return Promise.resolve({ ok: true });
        },
      }),
    });

    await expect(
      service.execute({ ...base, grant: GRANT, estimated: { amount: "1.00", currency: "USD" } }),
    ).rejects.toMatchObject({ code: "ALDUS_SPEND_NOT_AUTHORIZED" });
    expect(dispatched).toBe(false);
  });

  it("passes a ceiling only to a backend that says it enforces one", async () => {
    // Sending a limit to a backend that ignores it would record a protection that does not exist,
    // which a reader counts (ADR-0030).
    const seen: Record<string, unknown>[] = [];
    const enforcing = backend({
      capabilities: () =>
        Promise.resolve({
          offers: [],
          interactive: false,
          resumable: false,
          enforcesSpendCeiling: true,
        }),
      execute: (request) => {
        seen.push(request as unknown as Record<string, unknown>);
        return Promise.resolve({ ok: true });
      },
    });
    const ignoring = backend({
      execute: (request) => {
        seen.push(request as unknown as Record<string, unknown>);
        return Promise.resolve({ ok: true });
      },
    });

    await serviceWith({ backend: enforcing }).service.execute({ ...base, grant: GRANT });
    await serviceWith({ backend: ignoring }).service.execute({ ...base, grant: GRANT });

    expect(seen[0]?.["maxSpend"]).toEqual({ amount: "2.00", currency: "USD" });
    expect(seen[1]?.["maxSpend"]).toBeUndefined();
  });
});

describe("a charge whose amount the provider withheld (#150)", () => {
  // The defect: this observation was **valid to report and fatal to append**. The observation
  // schema accepted it, the record schema refused it, and reporting it threw away the cost record,
  // the event and the completed `AgentResult` — after the money was gone.

  const unknownCharge = {
    provider: "provider-a",
    operation: "completion",
    billingStatus: "unknown" as const,
  };

  it("6/7/8. returns the original result, appends the record, links it from the event", async () => {
    const { service, costs, events } = serviceWith({
      backend: backend({
        execute: () => Promise.resolve({ ok: true, output: "drafted", costs: [unknownCharge] }),
      }),
    });

    const result = await service.execute({ ...base, grant: GRANT });

    // The provider's execution completed. Reporting an honest cost must not turn that into a
    // schema exception.
    expect(result.result.ok).toBe(true);
    expect(result.result.output).toBe("drafted");

    expect(costs.records).toHaveLength(1);
    expect(costs.records[0]?.billingStatus).toBe("unknown");
    // No fabricated amount introduced during attribution. Zero is a numerical assertion and this
    // is an uncertainty state.
    expect(costs.records[0]?.actual).toBeUndefined();
    expect(costs.records[0]?.estimated).toBeUndefined();

    const details = events.events[0]?.details as { costIds?: string[] };
    expect(details.costIds).toEqual([costs.records[0]?.costId]);

    // 8.
    expect(result.billingUnconfirmed).toBe(true);
  });

  it("10. a later spend check against the same grant is refused as billing-unconfirmed", async () => {
    const { service, costs } = serviceWith({
      backend: backend({
        execute: () => Promise.resolve({ ok: true, costs: [unknownCharge] }),
      }),
    });
    await service.execute({ ...base, grant: GRANT });

    const check = checkSpend(GRANT, costs.records, {
      amount: { amount: "0.0100", currency: "USD" },
    });

    if (check.allowed) throw new Error("a spend after an unconfirmed charge must be refused");
    expect(check.reason).toBe("billing-unconfirmed");
    // The unresolved charge is neither free, voided, nor a zero draw.
    expect(check.ledger.unresolvedUnknown).toHaveLength(1);
    expect(check.ledger.remainingIsDeterminate).toBe(false);
  });

  it("an estimate does not resolve an unknown charge", async () => {
    // The ruling is explicit: an estimate is evidence about what was expected, and does not
    // confirm the final charge. A record carrying both is still unresolved.
    const { service, costs } = serviceWith({
      backend: backend({
        execute: () =>
          Promise.resolve({
            ok: true,
            costs: [{ ...unknownCharge, estimated: { amount: "0.5000", currency: "USD" } }],
          }),
      }),
    });
    await service.execute({ ...base, grant: GRANT });

    const check = checkSpend(GRANT, costs.records, {
      amount: { amount: "0.0100", currency: "USD" },
    });

    if (check.allowed) throw new Error("an estimate must not resolve an unknown charge");
    expect(check.reason).toBe("billing-unconfirmed");
  });

  it("9. the summary exposes it without adding to actual or estimated totals", () => {
    const record = {
      schemaVersion: SCHEMA_VERSION,
      costId: "cost-1",
      runId: RUN,
      provider: "provider-a",
      operation: "completion",
      billingStatus: "unknown" as const,
      recordedAt: "2026-01-01T00:00:00.000Z",
    };

    const summary = summariseCosts([record]);

    expect(summary.recordCount).toBe(1);
    expect(summary.unknownBillingRecordCount).toBe(1);
    expect(summary.unquantifiedUnknownBillingRecordCount).toBe(1);
    expect(summary.actualByCurrency).toEqual({});
    expect(summary.estimatedByCurrency).toEqual({});
    // It has no `Money`, so no currency can be derived — which is exactly why a reader must not
    // treat `currenciesWithUnknownBilling` as the only unknown-billing signal.
    expect(summary.currenciesWithUnknownBilling).toEqual([]);
  });
});
