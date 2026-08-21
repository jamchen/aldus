/**
 * The ten required tests of the #155 step-3 ruling (ADR-0044).
 *
 * These drive the real `SpendService` against a real reservation store on a real filesystem. The
 * property under test is ordering under concurrency and failure, and a double that agreed with the
 * store would be a test asserting the double.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ActorRef, CostRecord } from "@aldus-runtime/core";
import { FileSpendReservationStore } from "@aldus-runtime/file-store";
import { grantTermsDigest, type SpendGrant } from "@aldus-runtime/gate-engine";
import type { AgentBackend } from "@aldus-runtime/stage-runner";

import { AgentExecutionService } from "../src/agent-execution.js";
import type { CostRecordStore } from "../src/cost-store.js";
import { SpendService } from "../src/spend-service.js";

const ACTOR: ActorRef = { kind: "agent", id: "claude" };
const RUN = "run-a";

function grant(overrides: Partial<SpendGrant> = {}): SpendGrant {
  return {
    grantId: "grant-agent",
    runId: RUN,
    gateId: "agent.spend",
    decisionId: "decision-a",
    scope: { operations: ["agent.execute"] },
    maxTotal: { amount: "10.0000", currency: "USD" },
    maxPerRequest: { amount: "2.0000", currency: "USD" },
    ...overrides,
  };
}

function costStore(seed: CostRecord[] = []): CostRecordStore & { records: CostRecord[] } {
  const records = [...seed];
  return {
    records,
    list: () => Promise.resolve([...records]),
    append: (_runId, record) => {
      // Idempotent on cost id, so a settlement retry cannot duplicate spend.
      if (!records.some((existing) => existing.costId === record.costId)) records.push(record);
      return Promise.resolve();
    },
  };
}

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "aldus-step3-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function services(options: { costs?: ReturnType<typeof costStore>; backend?: AgentBackend } = {}) {
  const costs = options.costs ?? costStore();
  const spend = new SpendService({
    store: new FileSpendReservationStore({ root }),
    costs,
    now: () => new Date("2026-01-01T00:00:00.000Z"),
  });
  const backend: AgentBackend = options.backend ?? {
    id: "backend-a",
    version: "1.0.0",
    capabilities: () => Promise.resolve({ offers: [], interactive: false, resumable: false }),
    execute: () => Promise.resolve({ ok: true }),
  };
  const service = new AgentExecutionService({
    backend,
    spend,
    costs,
    events: { append: () => Promise.resolve(undefined) },
    now: () => new Date("2026-01-01T00:00:00.000Z"),
  });
  return { spend, costs, service };
}

const reserveInput = {
  operation: "agent.execute",
  runId: RUN,
  stageId: "outline.draft",
  attemptId: "att-1",
  effectKey: "effect-a",
} as const;

describe("concurrency", () => {
  it("2. two dispatches competing for insufficient headroom: only one reserves", async () => {
    const { spend } = services();
    const tight = grant({ maxTotal: { amount: "1.5000", currency: "USD" } });
    const expectation = {
      kind: "estimated",
      amount: { amount: "1.0000", currency: "USD" },
    } as const;

    const [a, b] = await Promise.all([
      spend.reserve({ ...reserveInput, grant: tight, effectKey: "effect-a", expectation }),
      spend.reserve({ ...reserveInput, grant: tight, effectKey: "effect-b", expectation }),
    ]);

    const reserved = [a, b].filter((outcome) => outcome.reserved);
    expect(reserved).toHaveLength(1);
  });

  it("reserving the same effect twice returns one reservation, not two", async () => {
    const { spend } = services();
    const expectation = {
      kind: "estimated",
      amount: { amount: "1.0000", currency: "USD" },
    } as const;

    const first = await spend.reserve({ ...reserveInput, grant: grant(), expectation });
    const second = await spend.reserve({ ...reserveInput, grant: grant(), expectation });

    if (!first.reserved || !second.reserved) throw new Error("both should have reserved");
    expect(second.reservation.reservationId).toBe(first.reservation.reservationId);
  });
});

it("a losing writer retries and recomputes rather than giving up", async () => {
  // Written because a mutation replacing the retry with a refusal passed every other test here:
  // nothing exercised the conflict path, so the bounded retry the ruling requires was asserted
  // by nobody.
  const real = new FileSpendReservationStore({ root });
  let conflictsToInject = 1;
  const flaky = {
    readGrant: (grantId: string) => real.readGrant(grantId),
    get: (id: string) => real.get(id),
    listByRun: (id: string) => real.listByRun(id),
    compareAndAppend: async (input: Parameters<typeof real.compareAndAppend>[0]) => {
      if (conflictsToInject > 0) {
        conflictsToInject -= 1;
        const stream = await real.readGrant(input.grantId);
        return { kind: "conflict" as const, currentRevision: stream.revision };
      }
      return real.compareAndAppend(input);
    },
  };
  const spend = new SpendService({
    store: flaky,
    costs: costStore(),
    now: () => new Date("2026-01-01T00:00:00.000Z"),
  });

  const outcome = await spend.reserve({
    ...reserveInput,
    grant: grant(),
    expectation: { kind: "estimated", amount: { amount: "1.0000", currency: "USD" } },
  });

  // It lost once and still committed, which is what "a conflict is ordinary concurrency, not an
  // internal failure" has to mean in practice.
  expect(outcome.reserved).toBe(true);
  expect(conflictsToInject).toBe(0);
});

describe("3. every CostExpectation arm", () => {
  it("free creates no reservation and needs no grant", async () => {
    const { spend } = services();

    const outcome = await spend.reserve({
      ...reserveInput,
      grant: undefined,
      expectation: { kind: "free" },
    });

    expect(outcome).toEqual({ reserved: false, reason: "free" });
  });

  it("estimated requires a grant", async () => {
    const { spend } = services();

    const outcome = await spend.reserve({
      ...reserveInput,
      grant: undefined,
      expectation: { kind: "estimated", amount: { amount: "1.0000", currency: "USD" } },
    });

    if (outcome.reserved || outcome.reason !== "refused") throw new Error("expected a refusal");
    expect(outcome.explanation).toContain("not evidence of free execution");
  });

  it("unestimated refuses unless the grant's policy permits it", async () => {
    const { spend } = services();

    const refused = await spend.reserve({
      ...reserveInput,
      grant: grant(),
      expectation: { kind: "unestimated" },
    });
    const permitted = await spend.reserve({
      ...reserveInput,
      effectKey: "effect-permitted",
      grant: grant({ unestimatedExecution: "reserve_max_per_request" }),
      expectation: { kind: "unestimated" },
    });

    if (refused.reserved) throw new Error("expected a refusal without the policy");
    if (!permitted.reserved) throw new Error("expected a reservation with the policy");
    // Reserves the per-request ceiling — not zero, which would make it invisible to concurrency.
    expect(permitted.reservation.reserved).toEqual({ amount: "2.0000", currency: "USD" });
  });

  it("4. permission without a usable maxPerRequest still refuses", async () => {
    const { spend } = services();
    const noCeiling = grant({ unestimatedExecution: "reserve_max_per_request" });
    delete (noCeiling as { maxPerRequest?: unknown }).maxPerRequest;

    const outcome = await spend.reserve({
      ...reserveInput,
      grant: noCeiling,
      expectation: { kind: "unestimated" },
    });

    if (outcome.reserved || outcome.reason !== "refused") throw new Error("expected a refusal");
    expect(outcome.explanation).toContain("no truthful amount to reserve");
  });

  it("a zero per-request ceiling refuses too", async () => {
    const { spend } = services();

    const outcome = await spend.reserve({
      ...reserveInput,
      grant: grant({
        unestimatedExecution: "reserve_max_per_request",
        maxPerRequest: { amount: "0.0000", currency: "USD" },
      }),
      expectation: { kind: "unestimated" },
    });

    if (outcome.reserved) throw new Error("expected a refusal");
  });
});

describe("5. the grant-terms digest binds the unestimated policy", () => {
  it("changing the policy invalidates the approval", () => {
    // §13.2's rule: widening what an approval permits must void it, exactly as raising a ceiling
    // does. A permission that could be added without re-approval is not operator-approved.
    expect(grantTermsDigest(grant())).not.toBe(
      grantTermsDigest(grant({ unestimatedExecution: "reserve_max_per_request" })),
    );
  });

  it("an absent policy digests the same as an explicit refuse", () => {
    expect(grantTermsDigest(grant())).toBe(
      grantTermsDigest(grant({ unestimatedExecution: "refuse" })),
    );
  });
});

describe("6/7. the dispatch boundary", () => {
  it("cancellation before dispatch preparation releases the reservation", async () => {
    const { spend } = services();
    const outcome = await spend.reserve({
      ...reserveInput,
      grant: grant(),
      expectation: { kind: "estimated", amount: { amount: "1.0000", currency: "USD" } },
    });
    if (!outcome.reserved) throw new Error("expected a reservation");

    const released = await spend.releaseBeforeDispatch(
      outcome.reservation,
      "cancelled by operator",
    );

    expect(released.status).toBe("released");
  });

  it("release is refused once dispatch has been prepared", async () => {
    // After that boundary a failure is not proof of no charge, so releasing would restore
    // authorization for money that may already be gone.
    const { spend } = services();
    const outcome = await spend.reserve({
      ...reserveInput,
      grant: grant(),
      expectation: { kind: "estimated", amount: { amount: "1.0000", currency: "USD" } },
    });
    if (!outcome.reserved) throw new Error("expected a reservation");
    const prepared = await spend.prepareDispatch(outcome.reservation, {
      backendId: "backend-a",
      backendVersion: "1.0.0",
      ceilingEnforced: false,
    });

    await expect(spend.releaseBeforeDispatch(prepared, "too late")).rejects.toThrow(
      /may have begun/,
    );
  });

  it("a throw after dispatch preparation leaves the reservation active and non-retryable", async () => {
    const { spend, service } = services({
      backend: {
        id: "backend-a",
        version: "1.0.0",
        capabilities: () => Promise.resolve({ offers: [], interactive: false, resumable: false }),
        execute: () => Promise.reject(new Error("provider exploded")),
      },
    });

    await expect(
      service.execute({
        runId: RUN,
        episodeId: "episode-a",
        stageId: "outline.draft",
        attemptId: "att-1",
        actor: ACTOR,
        request: { prompt: "draft" } as never,
        operation: "agent.execute",
        effectKey: "effect-thrown",
        expectation: { kind: "estimated", amount: { amount: "1.0000", currency: "USD" } },
        grant: grant(),
      }),
    ).rejects.toThrow(/provider exploded/);

    const stream = await new FileSpendReservationStore({ root }).readGrant("grant-agent");
    const kinds = stream.transitions.map((transition) => transition.kind);
    // Still consuming authorization: a failed request is not evidence of no charge (§19.3).
    expect(kinds).toContain("reservation.billing_unknown");
    expect(kinds).not.toContain("reservation.released");
    void spend;
  });
});

describe("8. an execution declared free that reports a charge", () => {
  it("records the charge and refuses to attach a grant to it", async () => {
    const { service, costs } = services({
      backend: {
        id: "backend-a",
        version: "1.0.0",
        capabilities: () => Promise.resolve({ offers: [], interactive: false, resumable: false }),
        execute: () =>
          Promise.resolve({
            ok: true,
            costs: [
              {
                provider: "provider-a",
                operation: "completion",
                billingStatus: "charged" as const,
                actual: { amount: "0.5000", currency: "USD" },
              },
            ],
          }),
      },
    });

    await expect(
      service.execute({
        runId: RUN,
        episodeId: "episode-a",
        stageId: "outline.draft",
        attemptId: "att-1",
        actor: ACTOR,
        request: { prompt: "draft" } as never,
        operation: "agent.execute",
        effectKey: "effect-free",
        expectation: { kind: "free" },
      }),
    ).rejects.toThrow(/declared this execution free/);

    // Recorded, so §20 can answer what it cost — and not laundered through a grant nobody
    // consulted.
    expect(costs.records).toHaveLength(1);
    expect(costs.records[0]?.authorizationId).toBeUndefined();
  });
});

describe("9/10. ordering", () => {
  it("no provider call happens before the reservation is durable", async () => {
    let dispatched = false;
    const { service } = services({
      backend: {
        id: "backend-a",
        version: "1.0.0",
        capabilities: () => Promise.resolve({ offers: [], interactive: false, resumable: false }),
        execute: () => {
          dispatched = true;
          return Promise.resolve({ ok: true });
        },
      },
    });

    await expect(
      service.execute({
        runId: RUN,
        episodeId: "episode-a",
        stageId: "outline.draft",
        attemptId: "att-1",
        actor: ACTOR,
        request: { prompt: "draft" } as never,
        operation: "tts.synthesize", // outside the grant's scope
        effectKey: "effect-scope",
        expectation: { kind: "estimated", amount: { amount: "1.0000", currency: "USD" } },
        grant: grant(),
      }),
    ).rejects.toThrow(/authorizes/);

    expect(dispatched).toBe(false);
  });

  it("the cost record is durable before the reservation stops consuming authorization", async () => {
    const { spend, costs } = services();
    const outcome = await spend.reserve({
      ...reserveInput,
      grant: grant(),
      expectation: { kind: "estimated", amount: { amount: "1.0000", currency: "USD" } },
    });
    if (!outcome.reserved) throw new Error("expected a reservation");

    const settled = await spend.settle(
      outcome.reservation,
      [
        {
          provider: "provider-a",
          operation: "completion",
          billingStatus: "charged",
          actual: { amount: "0.5000", currency: "USD" },
        },
      ],
      { authorizationId: "decision-a" },
    );

    expect(settled.reservation.status).toBe("settled");
    // Both facts exist, and the record carries the reservation lineage both ways.
    expect(costs.records).toHaveLength(1);
    expect(costs.records[0]?.reservationId).toBe(outcome.reservation.reservationId);
    expect(settled.reservation.costIds).toEqual([costs.records[0]?.costId]);
  });

  it("settling twice does not duplicate the cost record", async () => {
    // Cost ids are derived from the reservation, so a retry after a conflict re-appends the same
    // identities rather than minting new ones and charging twice.
    const { spend, costs } = services();
    const outcome = await spend.reserve({
      ...reserveInput,
      grant: grant(),
      expectation: { kind: "estimated", amount: { amount: "1.0000", currency: "USD" } },
    });
    if (!outcome.reserved) throw new Error("expected a reservation");
    const observation = {
      provider: "provider-a",
      operation: "completion",
      billingStatus: "charged" as const,
      actual: { amount: "0.5000", currency: "USD" },
    };

    await spend.settle(outcome.reservation, [observation], {});
    await expect(spend.settle(outcome.reservation, [observation], {})).rejects.toThrow(
      /cannot transition/,
    );

    expect(costs.records).toHaveLength(1);
  });
});

describe("an execution that cost nothing releases rather than settling", () => {
  /**
   * `free` and `voided` are both a provider stating that nothing is owed.
   *
   * `settle` recognised only `voided`, so an all-`free` execution reached `reservation.settled` —
   * which says money was spent and accounted for when none was. The lifecycle only ever had one
   * meaning for `released`, and this is it (ADR-0044).
   *
   * The fix lives in `SpendService`, so it applies to every paid path at once. These cover the
   * shared implementation; `packages/aldus-e2e/test/paid-worker-dispatch.test.ts` covers the Worker path
   * through the composed stack, and `synthesis.test.ts` the synthesis one.
   */
  async function settleWith(billingStatus: "free" | "voided", effectKey: string) {
    const { spend, costs } = services();
    const outcome = await spend.reserve({
      ...reserveInput,
      effectKey,
      grant: grant(),
      expectation: { kind: "estimated", amount: { amount: "1.0000", currency: "USD" } },
    });
    if (!outcome.reserved) throw new Error("expected a reservation");
    const prepared = await spend.prepareDispatch(outcome.reservation, {
      backendId: "backend-a",
      backendVersion: "1.0.0",
      ceilingEnforced: false,
    });
    const settled = await spend.settle(
      prepared,
      [
        {
          provider: "provider-a",
          operation: "completion",
          billingStatus,
          // Stated, not omitted: §19.3 forbids an amount-less charge, and here zero is a real
          // assertion rather than a stand-in for an unknown amount.
          actual: { amount: "0.0000", currency: "USD" },
        },
      ],
      {},
    );
    return { settled, costs };
  }

  it("releases when every observation is free", async () => {
    const { settled } = await settleWith("free", "effect-all-free");
    expect(settled.reservation.status).toBe("released");
  });

  it("releases when every observation is voided", async () => {
    const { settled } = await settleWith("voided", "effect-all-voided");
    expect(settled.reservation.status).toBe("released");
  });

  it("still records the observation, so §20 can answer what happened", async () => {
    // Released is not "nothing happened". The provider was called and said it cost nothing, and
    // that is a fact the trace has to carry.
    const { settled } = await settleWith("free", "effect-free-recorded");
    expect(settled.costs).toHaveLength(1);
    expect(settled.costs[0]?.billingStatus).toBe("free");
  });

  it("settles when one observation is free and another is charged", async () => {
    const { spend } = services();
    const outcome = await spend.reserve({
      ...reserveInput,
      effectKey: "effect-mixed-free",
      grant: grant(),
      expectation: { kind: "estimated", amount: { amount: "1.0000", currency: "USD" } },
    });
    if (!outcome.reserved) throw new Error("expected a reservation");
    const prepared = await spend.prepareDispatch(outcome.reservation, {
      backendId: "backend-a",
      backendVersion: "1.0.0",
      ceilingEnforced: false,
    });
    const settled = await spend.settle(
      prepared,
      [
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
      {},
    );

    expect(settled.reservation.status).toBe("settled");
  });
});

describe("silence is not evidence that nothing was charged", () => {
  /**
   * The rule lives in `settle` so every caller gets it.
   *
   * It used to live in whichever caller thought of it. `StageRunner`'s Worker path guarded before
   * calling `settle` and refused non-retryably; the agent path reached the same `settle` with an
   * empty array and `written.length === 0` released the reservation. One question, two answers,
   * one method apart — and `SynthesisGateway` reaches the same call.
   *
   * Covering it here covers all three by construction. The Worker path keeps its own earlier
   * refusal and its own message, which is a different, sharper answer for the same fact rather
   * than a competing one.
   */
  async function dispatchThenSettle(observations: Parameters<SpendService["settle"]>[1]) {
    const { spend } = services();
    const outcome = await spend.reserve({
      ...reserveInput,
      effectKey: `effect-silence-${observations.length}-${String(observations[0]?.billingStatus)}`,
      grant: grant(),
      expectation: { kind: "estimated", amount: { amount: "1.0000", currency: "USD" } },
    });
    if (!outcome.reserved) throw new Error("expected a reservation");
    const prepared = await spend.prepareDispatch(outcome.reservation, {
      backendId: "backend-a",
      backendVersion: "1.0.0",
      ceilingEnforced: false,
    });
    return spend.settle(prepared, observations, {});
  }

  it("retains the reservation when the dispatch reported nothing", async () => {
    const settled = await dispatchThenSettle([]);

    // Not `released`. Releasing would restore authorization on the strength of a provider that
    // said nothing, which is how a budget is quietly exceeded (§19.3).
    expect(settled.reservation.status).toBe("billing_unknown");
    expect(settled.costs).toHaveLength(0);
  });

  it("says why, so an operator is not left inferring it from an empty cost list", async () => {
    const { spend } = services();
    const outcome = await spend.reserve({
      ...reserveInput,
      effectKey: "effect-silence-reason",
      grant: grant(),
      expectation: { kind: "estimated", amount: { amount: "1.0000", currency: "USD" } },
    });
    if (!outcome.reserved) throw new Error("expected a reservation");
    const prepared = await spend.prepareDispatch(outcome.reservation, {
      backendId: "backend-a",
      backendVersion: "1.0.0",
      ceilingEnforced: false,
    });
    await spend.settle(prepared, [], {});

    // Read from the stream rather than a report: `SpendService.status` arrives with #155 step 5,
    // and the reason has to be durable regardless of what reads it.
    const stream = await new FileSpendReservationStore({ root }).readGrant(grant().grantId);
    const unresolved = stream.transitions.filter(
      (transition) =>
        transition.reservationId === prepared.reservationId &&
        transition.kind === "reservation.billing_unknown",
    );
    expect(unresolved).toHaveLength(1);
    expect(String(unresolved[0]?.detail["reason"])).toContain("silence is not evidence");
  });

  it("still releases when the dispatch reported that nothing was owed", async () => {
    // The control, and the distinction the fix turns on: `free` is a provider stating no charge,
    // which is evidence. An empty array is the absence of a statement.
    const settled = await dispatchThenSettle([
      {
        provider: "provider-a",
        operation: "completion",
        billingStatus: "free",
        actual: { amount: "0.0000", currency: "USD" },
      },
    ]);

    expect(settled.reservation.status).toBe("released");
  });
});
