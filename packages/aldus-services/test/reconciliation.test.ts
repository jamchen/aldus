/**
 * Human reconciliation of a charge nobody could measure (#155 step 5; ADR-0044).
 *
 * The decision under test is what an operator is attesting to. Two resolutions terminate a
 * reservation and one deliberately does not, and the rejected third — accepting the reservation
 * amount as the charge — is asserted absent rather than merely unimplemented.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SCHEMA_VERSION, type ActorRef, type CostRecord } from "@aldus-runtime/core";
import { FileSpendReservationStore } from "@aldus-runtime/file-store";
import { availableAuthorization, type SpendGrant } from "@aldus-runtime/gate-engine";

import type { CostRecordStore } from "../src/cost-store.js";
import { openOperatorConsole, SpendService } from "../src/spend-service.js";

/** The store returns `SpendReservation | undefined`; every call site here knows it exists. */
type SpendReservationLike = Parameters<SpendService["reconcile"]>[0];

const HUMAN: ActorRef = { kind: "human", id: "operator-a" };
const AGENT: ActorRef = { kind: "agent", id: "claude" };
const RUN = "run-a";

const grant: SpendGrant = {
  grantId: "grant-a",
  runId: RUN,
  gateId: "agent.spend",
  decisionId: "decision-a",
  scope: { operations: ["agent.execute"] },
  maxTotal: { amount: "10.0000", currency: "USD" },
  maxPerRequest: { amount: "2.0000", currency: "USD" },
};

function costStore(): CostRecordStore & { records: CostRecord[] } {
  const records: CostRecord[] = [];
  return {
    records,
    list: () => Promise.resolve([...records]),
    append: (_runId, record) => {
      if (!records.some((entry) => entry.costId === record.costId)) records.push(record);
      return Promise.resolve();
    },
  };
}

let root: string;
let spend: SpendService;
let console_: ReturnType<typeof openOperatorConsole>;
let costs: ReturnType<typeof costStore>;
let store: FileSpendReservationStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "aldus-reconcile-"));
  store = new FileSpendReservationStore({ root });
  costs = costStore();
  spend = new SpendService({ store, costs, now: () => new Date("2026-01-01T00:00:00.000Z") });
  console_ = openOperatorConsole({ spend, actor: HUMAN });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A reservation that dispatched and came back knowing nothing about billing. */
async function unresolved(effectKey = "effect-a") {
  const outcome = await spend.reserve({
    grant,
    operation: "agent.execute",
    runId: RUN,
    stageId: "outline.draft",
    attemptId: "att-1",
    effectKey,
    expectation: { kind: "estimated", amount: { amount: "2.0000", currency: "USD" } },
  });
  if (!outcome.reserved) throw new Error("expected a reservation");
  const prepared = await spend.prepareDispatch(outcome.reservation, {
    backendId: "backend-a",
    backendVersion: "1.0.0",
    ceilingEnforced: false,
  });
  return spend.markUnknown(prepared);
}

const evidence = "provider statement 2026-08, line 42";

describe("who may reconcile", () => {
  it("refuses to open a console for a non-human invocation", () => {
    // Refused when the console is *opened* rather than when someone tries to use it: a
    // composition that wired an agent identity is wrong at wiring time, and finding out at the
    // moment authorization would be released is finding out late.
    expect(() => openOperatorConsole({ spend, actor: AGENT })).toThrow(/human decision/);
  });

  it("refuses to open a console when no actor is established", () => {
    expect(() => openOperatorConsole({ spend, actor: undefined })).toThrow(/No actor identity/);
  });

  it("refuses a caller that fabricates a human authority", async () => {
    // The defect the console exists to close: a caller-supplied `ActorRef` proves nothing, because
    // any caller can write `{ kind: "human" }`. The earlier test only proved that a caller honest
    // about being an agent was refused — which is a different and much weaker claim.
    const reservation = await unresolved();
    const forged = { actor: HUMAN } as unknown as Parameters<typeof spend.reconcile>[2];

    await expect(
      spend.reconcile(
        reservation,
        {
          evidenceRef: evidence,
          decisionId: "dec-1",
          resolution: { kind: "released_as_uncharged" },
        },
        forged,
      ),
    ).rejects.toThrow(/did not come through an operator console/);
  });

  it("refuses a decision that cites nothing", async () => {
    const reservation = await unresolved();

    await expect(
      console_.reconcile(reservation, {
        evidenceRef: "   ",
        decisionId: "dec-1",
        resolution: { kind: "released_as_uncharged" },
      }),
    ).rejects.toThrow(/cite what it rests on/);
  });
});

describe("the two terminal resolutions", () => {
  it("settled_with_amount writes the cost record before releasing authorization", async () => {
    const reservation = await unresolved();

    const result = await console_.reconcile(reservation, {
      evidenceRef: evidence,
      decisionId: "dec-1",
      resolution: {
        kind: "settled_with_amount",
        amount: { amount: "0.7500", currency: "USD" },
        // Who charged, and for what. Aldus does not invent a provider to fill a required field.
        provider: "provider-a",
        billedOperation: "completion",
      },
    });

    expect(result.reservation.status).toBe("settled");
    expect(costs.records).toHaveLength(1);
    expect(costs.records[0]?.actual).toEqual({ amount: "0.7500", currency: "USD" });
    // The grant recovers the difference between what was reserved and what was charged.
    const availability = availableAuthorization(grant, costs.records, [result.reservation]);
    expect(availability.determinate).toBe(true);
  });

  it("released_as_uncharged releases, and the evidence is on the record", async () => {
    const reservation = await unresolved();

    const result = await console_.reconcile(reservation, {
      evidenceRef: evidence,
      decisionId: "dec-1",
      resolution: { kind: "released_as_uncharged" },
    });

    expect(result.reservation.status).toBe("released");
    const stream = await store.readGrant(grant.grantId);
    const reconciled = stream.transitions.find(
      (transition) => transition.kind === "reservation.reconciled",
    );
    expect(reconciled?.detail["evidenceRef"]).toBe(evidence);
    expect(reconciled?.detail["decidedBy"]).toEqual({ kind: "human", id: "operator-a" });
  });
});

it("does not settle when the cost record cannot be written", async () => {
  // The ordering the ruling names: append the decision, write the record, and *only then* reach
  // a terminal state. Written because a mutation that settled first and wrote second passed
  // every other test here — the requirement was in the ruling and in the code, and asserted by
  // nobody.
  const reservation = await unresolved("effect-write-fails");
  const failing = openOperatorConsole({
    spend: new SpendService({
      store,
      costs: {
        list: () => Promise.resolve([]),
        append: () => Promise.reject(new Error("cost store unavailable")),
      },
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    }),
    actor: HUMAN,
  });

  await expect(
    failing.reconcile(reservation, {
      evidenceRef: evidence,
      decisionId: "dec-1",
      resolution: {
        kind: "settled_with_amount",
        amount: { amount: "0.7500", currency: "USD" },
        // Who charged, and for what. Aldus does not invent a provider to fill a required field.
        provider: "provider-a",
        billedOperation: "completion",
      },
    }),
  ).rejects.toThrow(/cost store unavailable/);

  // Authorization was not released for a charge nothing recorded. The human decision is durable
  // and the reservation still consumes — which is the recoverable state, not a lost one.
  const after = await store.get(reservation.reservationId);
  expect(after?.status).toBe("billing_unknown");
  const stream = await store.readGrant(grant.grantId);
  expect(stream.transitions.some((t) => t.kind === "reservation.reconciled")).toBe(true);
  expect(stream.transitions.some((t) => t.kind === "reservation.settled")).toBe(false);
});

describe("billing attribution stays truthful", () => {
  it("refuses to settle an amount without saying who charged", async () => {
    // The first implementation wrote `provider: "reconciled"` — how Aldus learned a fact, not who
    // billed. That fabricates a provider and silently removes the charge from per-provider
    // reporting. Written because a mutation dropping this refusal passed everything.
    const reservation = await unresolved("effect-no-provider");

    await expect(
      console_.reconcile(reservation, {
        evidenceRef: evidence,
        decisionId: "dec-1",
        resolution: { kind: "settled_with_amount", amount: { amount: "0.5000", currency: "USD" } },
      }),
    ).rejects.toThrow(/requires who was charged and for what/);
  });

  it("takes provider and operation from a surviving unresolved observation", async () => {
    // Where the charge was recorded but its amount was not, the provider is already known and the
    // human should not have to restate it — nor be able to restate it differently.
    const reservation = await unresolved("effect-linked");
    await costs.append(RUN, {
      schemaVersion: SCHEMA_VERSION,
      costId: `${reservation.reservationId}:cost:0`,
      runId: RUN,
      reservationId: reservation.reservationId,
      provider: "provider-b",
      operation: "synthesis",
      billingStatus: "unknown",
      recordedAt: "2026-01-01T00:00:00.000Z",
    });

    const resolved = await console_.reconcile(reservation, {
      evidenceRef: evidence,
      decisionId: "dec-1",
      resolution: {
        kind: "settled_with_amount",
        amount: { amount: "0.5000", currency: "USD" },
        // Deliberately different: the surviving observation is the authority on who charged.
        provider: "provider-a",
        billedOperation: "completion",
      },
    });

    expect(resolved.costs[0]?.provider).toBe("provider-b");
    expect(resolved.costs[0]?.operation).toBe("synthesis");
  });

  it("never writes Aldus itself as the provider", async () => {
    // The specific literal the first implementation used. Asserted directly because a refusal that
    // happens to fire on the *operation* being absent does not prove the provider is never
    // synthesized — a mutation defaulting only the provider passed the test above.
    const reservation = await unresolved("effect-provider-literal");
    await costs.append(RUN, {
      schemaVersion: SCHEMA_VERSION,
      costId: `${reservation.reservationId}:cost:0`,
      runId: RUN,
      reservationId: reservation.reservationId,
      provider: "provider-b",
      operation: "synthesis",
      billingStatus: "unknown",
      recordedAt: "2026-01-01T00:00:00.000Z",
    });

    const resolved = await console_.reconcile(reservation, {
      evidenceRef: evidence,
      decisionId: "dec-1",
      resolution: { kind: "settled_with_amount", amount: { amount: "0.5000", currency: "USD" } },
    });

    for (const record of resolved.costs) {
      expect(record.provider).not.toBe("reconciled");
      expect(record.operation).not.toBe("reconciliation");
    }
  });
});

describe("investigation that ends without an answer", () => {
  it("records the decision and resolves nothing", async () => {
    // The rejected third resolution, in the shape it is permitted to take. "I could not find a
    // charge" is a human decision worth recording and is not evidence that no charge occurred.
    const reservation = await unresolved();

    const result = await console_.reconcile(reservation, {
      evidenceRef: "searched the console and the invoice; found nothing",
      decisionId: "dec-1",
      resolution: { kind: "investigation_ended" },
    });

    expect(result.reservation.status).toBe("billing_unknown");
    expect(result.costs).toHaveLength(0);
    // Still consuming, and the grant is still indeterminate: further spend needs a new
    // authorization rather than headroom this decision manufactured.
    const availability = availableAuthorization(grant, costs.records, [result.reservation]);
    expect(availability.determinate).toBe(false);
    expect(availability.reserved).toEqual({ amount: "2.0000", currency: "USD" });
  });

  it("cannot be used to create a numeric cost", async () => {
    const reservation = await unresolved();

    await console_.reconcile(reservation, {
      evidenceRef: "abandoned",
      decisionId: "dec-1",
      resolution: { kind: "investigation_ended" },
    });

    // Nothing was written. The reserved amount is an authorization fact and copying it into a
    // cost record would present what Aldus set aside as what a provider charged.
    expect(costs.records).toHaveLength(0);
  });
});

describe("the resolution that was rejected", () => {
  it("offers no way to accept the reserved amount as the charge", () => {
    // Asserted rather than left unimplemented: a future author reaching for it should find the
    // decision, not a gap. §19.3 already says an estimate does not resolve an unknown charge, and
    // this is the same substitution wearing a human's signature.
    const resolutions = ["settled_with_amount", "released_as_uncharged", "investigation_ended"];
    expect(resolutions).not.toContain("settled_as_unknown");
  });
});

describe("idempotency and staleness", () => {
  it("reconciling twice with the same decision does not settle twice", async () => {
    const reservation = await unresolved();
    const input = {
      evidenceRef: evidence,
      decisionId: "dec-1",
      resolution: {
        kind: "settled_with_amount" as const,
        amount: { amount: "0.7500", currency: "USD" },
        provider: "provider-a",
        billedOperation: "completion",
      },
    };

    await console_.reconcile(reservation, input);
    // The second call sees a terminal reservation and refuses rather than writing again.
    await expect(console_.reconcile(reservation, input)).rejects.toThrow(
      /only an unresolved charge/,
    );

    expect(costs.records).toHaveLength(1);
  });

  it("refuses a reservation that was never unresolved", async () => {
    const outcome = await spend.reserve({
      grant,
      operation: "agent.execute",
      runId: RUN,
      stageId: "outline.draft",
      attemptId: "att-1",
      effectKey: "effect-fresh",
      expectation: { kind: "estimated", amount: { amount: "1.0000", currency: "USD" } },
    });
    if (!outcome.reserved) throw new Error("expected a reservation");

    await expect(
      console_.reconcile(outcome.reservation, {
        evidenceRef: evidence,
        decisionId: "dec-1",
        resolution: { kind: "released_as_uncharged" },
      }),
    ).rejects.toThrow(/only an unresolved charge/);
  });
});

describe("budget status", () => {
  it("exposes what a reconciliation decision needs, and labels the reserved amount", async () => {
    await unresolved();

    const status = await spend.status(RUN);

    expect(status).toHaveLength(1);
    const entry = status[0];
    expect(entry?.requiresReconciliation).toBe(true);
    // Named for what it is. A reader taking this for the provider's charge has made the
    // substitution the rejected resolution would have institutionalised.
    expect(entry?.reservedAuthorizationAmount).toEqual({ amount: "2.0000", currency: "USD" });
    expect(entry?.effectKey).toBe("effect-a");
    expect(entry?.grantId).toBe("grant-a");
    expect(entry?.authorizationId).toBe("decision-a");
    expect(entry?.execution?.backendVersion).toBe("1.0.0");
  });

  it("carries no field named as a charge", async () => {
    await unresolved();

    const [entry] = await spend.status(RUN);

    // No `amount`, no `charged`, no `cost`. The one mistake this surface must not invite is
    // reading an authorization figure as a billing one.
    expect(Object.keys(entry ?? {})).not.toContain("amount");
    expect(Object.keys(entry ?? {})).not.toContain("charged");
  });
});

describe("an abandoned investigation is not a dead end", () => {
  it("investigation_ended then a later settled_with_amount both succeed", async () => {
    // The defect the ruling found: recording an abandoned investigation on the terminal
    // `reservation.reconciled` seam left the projection `billing_unknown`, so a later decision
    // looked legal and was then refused because the last transition was already `reconciled`.
    // Ending one investigation permanently prevented later evidence from resolving the charge.
    const reservation = await unresolved("effect-dead-end");

    await console_.reconcile(reservation, {
      evidenceRef: "searched the console; found nothing",
      decisionId: "dec-1",
      resolution: { kind: "investigation_ended" },
    });
    const afterFirst = await store.get(reservation.reservationId);
    expect(afterFirst?.status).toBe("billing_unknown");

    // A second abandoned investigation is also permitted — evidence may arrive on the third try.
    await console_.reconcile(afterFirst as NonNullable<typeof afterFirst>, {
      evidenceRef: "asked support; no answer yet",
      decisionId: "dec-2",
      resolution: { kind: "investigation_ended" },
    });

    const afterSecond = await store.get(reservation.reservationId);
    const resolved = await console_.reconcile(afterSecond as NonNullable<typeof afterSecond>, {
      evidenceRef: "invoice line 88 shows 0.9000 USD",
      decisionId: "dec-3",
      resolution: {
        kind: "settled_with_amount",
        amount: { amount: "0.9000", currency: "USD" },
        provider: "provider-a",
        billedOperation: "completion",
      },
    });

    expect(resolved.reservation.status).toBe("settled");
    // Every finding is on the record, in order, including the two that resolved nothing.
    const [entry] = (await spend.status(RUN)).filter(
      (item) => item.reservationId === reservation.reservationId,
    );
    expect(entry?.reconciliationHistory.map((h) => h.outcome)).toEqual([
      "audit_only",
      "audit_only",
      "completed",
    ]);
    expect(entry?.reconciliationHistory[0]?.evidenceRef).toContain("found nothing");
  });
});

describe("#152 — the provider may have executed and the cost write failed", () => {
  it("becomes reconcilable without any preparatory repair step", async () => {
    // The contract test the ruling names, end to end:
    //
    //   provider may have executed
    //     → CostRecord append fails
    //       → reservation remains active and non-retryable
    //         → budget status exposes the reconciliation handle and the reason
    //           → human reconciliation reaches the correct audited terminal state
    //
    // The earlier version called `markUnknown` by hand between the failure and the reconciliation,
    // which proved the *pieces* worked and not the path: an operator has no such call, and a state
    // that needs an out-of-band repair before it can be acted on is not a recovery.
    const failingCosts: CostRecordStore = {
      list: () => Promise.resolve([]),
      append: () => Promise.reject(new Error("cost store unavailable")),
    };
    const service = new SpendService({
      store,
      costs: failingCosts,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });

    const outcome = await service.reserve({
      grant,
      operation: "agent.execute",
      runId: RUN,
      stageId: "outline.draft",
      attemptId: "att-1",
      effectKey: "effect-152",
      expectation: { kind: "estimated", amount: { amount: "2.0000", currency: "USD" } },
    });
    if (!outcome.reserved) throw new Error("expected a reservation");
    const prepared = await service.prepareDispatch(outcome.reservation, {
      backendId: "backend-a",
      backendVersion: "1.0.0",
      ceilingEnforced: false,
    });
    const identified = await service.identifyDispatch(prepared, "provider-request-9");

    // The provider returned and the settlement write fails.
    await expect(
      service.settle(
        identified,
        [
          {
            provider: "provider-a",
            operation: "completion",
            billingStatus: "charged",
            actual: { amount: "1.0000", currency: "USD" },
          },
        ],
        {},
      ),
    ).rejects.toThrow(/cost store unavailable/);

    // The state an operator has to act on exists already — nobody had to put it there.
    const [entry] = (await service.status(RUN)).filter(
      (item) => item.reservationId === identified.reservationId,
    );
    expect(entry?.requiresReconciliation).toBe(true);
    expect(entry?.unresolvedReason).toContain("settlement persistence failed");
    expect(entry?.providerRequestId).toBe("provider-request-9");
    expect(entry?.execution?.backendVersion).toBe("1.0.0");
    // The unrecorded charge is named, not counted. A human is told which observation to look up
    // with the provider rather than how many to reconstruct from the sentence above.
    expect(entry?.pendingObservations).toEqual([
      {
        observationId: `${identified.reservationId}:cost:0`,
        provider: "provider-a",
        operation: "completion",
      },
    ]);
    expect(entry?.durableCosts).toEqual([]);

    // A human resolves it from that surfaced state, through the operator console.
    const operator = openOperatorConsole({
      spend: new SpendService({ store, costs, now: () => new Date("2026-01-01T00:00:00.000Z") }),
      actor: HUMAN,
    });
    const stuck = await store.get(identified.reservationId);
    const resolved = await operator.reconcile(stuck as NonNullable<typeof stuck>, {
      evidenceRef: "provider console shows request provider-request-9 charged 1.0000 USD",
      decisionId: "dec-152",
      resolution: {
        kind: "settled_with_amount",
        amount: { amount: "1.0000", currency: "USD" },
        observationId: `${identified.reservationId}:cost:0`,
      },
    });

    expect(resolved.reservation.status).toBe("settled");
    // The record lands under the identity the failed write would have used, so reconciling twice
    // rewrites one record rather than adding a second.
    expect(resolved.costs[0]?.costId).toBe(`${identified.reservationId}:cost:0`);
    // Truthful attribution: the provider that charged, and the authorization it drew on.
    expect(resolved.costs[0]?.provider).toBe("provider-a");
    expect(resolved.costs[0]?.operation).toBe("completion");
    expect(resolved.costs[0]?.authorizationId).toBe(grant.decisionId);
  });

  it("resumes the same decision after a transient cost-store failure", async () => {
    // The decision is durable before the cost write, so retrying it must continue rather than
    // restart — and must not be blocked by the decision transition it already appended.
    const reservation = await unresolved("effect-resume");
    let failNext = true;
    const flaky: CostRecordStore = {
      list: () => costs.list(RUN),
      append: (runId, record) => {
        if (failNext) {
          failNext = false;
          return Promise.reject(new Error("transient store failure"));
        }
        return costs.append(runId, record);
      },
    };
    const operator = openOperatorConsole({
      spend: new SpendService({
        store,
        costs: flaky,
        now: () => new Date("2026-01-01T00:00:00.000Z"),
      }),
      actor: HUMAN,
    });
    const decision = {
      evidenceRef: evidence,
      decisionId: "dec-resume",
      resolution: {
        kind: "settled_with_amount" as const,
        amount: { amount: "0.5000", currency: "USD" },
        provider: "provider-a",
        billedOperation: "completion",
      },
    };

    await expect(operator.reconcile(reservation, decision)).rejects.toThrow(/transient/);

    const midway = await store.get(reservation.reservationId);
    const resumed = await operator.reconcile(midway as NonNullable<typeof midway>, decision);

    expect(resumed.reservation.status).toBe("settled");
    expect(costs.records.filter((r) => r.reservationId === reservation.reservationId)).toHaveLength(
      1,
    );
  });

  it("refuses a different decision once one is recorded", async () => {
    const reservation = await unresolved("effect-conflict");
    await console_.reconcile(reservation, {
      evidenceRef: evidence,
      decisionId: "dec-first",
      resolution: { kind: "investigation_ended" },
    });
    const afterAudit = await store.get(reservation.reservationId);
    await console_.reconcile(afterAudit as NonNullable<typeof afterAudit>, {
      evidenceRef: evidence,
      decisionId: "dec-second",
      resolution: {
        kind: "settled_with_amount",
        amount: { amount: "0.5000", currency: "USD" },
        provider: "provider-a",
        billedOperation: "completion",
      },
    });

    // An abandoned investigation does not block a later finding — the dead end the ruling named.
    const settled = await store.get(reservation.reservationId);
    expect(settled?.status).toBe("settled");

    // But a second, different *terminal* decision would overwrite a human's recorded finding.
    const another = await unresolved("effect-two-decisions");
    await console_.reconcile(another, {
      evidenceRef: evidence,
      decisionId: "dec-a",
      resolution: { kind: "released_as_uncharged" },
    });
    const done = await store.get(another.reservationId);
    await expect(
      console_.reconcile(done as NonNullable<typeof done>, {
        evidenceRef: evidence,
        decisionId: "dec-b",
        resolution: { kind: "released_as_uncharged" },
      }),
    ).rejects.toThrow(/only an unresolved charge/);
  });
});

describe("a decision's identity is all of it, not just its id", () => {
  const durableDecisionThenFailure = async (effectKey: string) => {
    const reservation = await unresolved(effectKey);
    const failing = openOperatorConsole({
      spend: new SpendService({
        store,
        costs: {
          list: () => costs.list(RUN),
          append: () => Promise.reject(new Error("store down")),
        },
        now: () => new Date("2026-01-01T00:00:00.000Z"),
      }),
      actor: HUMAN,
    });
    const decision = {
      evidenceRef: evidence,
      decisionId: "dec-1",
      resolution: {
        kind: "settled_with_amount" as const,
        amount: { amount: "0.5000", currency: "USD" },
        provider: "provider-a",
        billedOperation: "completion",
      },
    };
    await expect(failing.reconcile(reservation, decision)).rejects.toThrow(/store down/);
    const midway = await store.get(reservation.reservationId);
    return { midway: midway as NonNullable<typeof midway>, decision };
  };

  it("refuses the same id carrying a different amount", async () => {
    // The gap: comparing only the id let a retry reuse one decision's identity while carrying a
    // different payload, and the resume path skipped the durable append and executed the new one.
    const { midway, decision } = await durableDecisionThenFailure("effect-amount");

    await expect(
      console_.reconcile(midway, {
        ...decision,
        resolution: { ...decision.resolution, amount: { amount: "9.0000", currency: "USD" } },
      }),
    ).rejects.toThrow(/different contents/);
  });

  it("refuses the same id carrying a different resolution", async () => {
    const { midway, decision } = await durableDecisionThenFailure("effect-resolution");

    await expect(
      console_.reconcile(midway, {
        ...decision,
        resolution: { kind: "released_as_uncharged" },
      }),
    ).rejects.toThrow(/different contents/);
  });

  it("refuses the same id carrying different evidence or a different provider", async () => {
    const { midway, decision } = await durableDecisionThenFailure("effect-evidence");

    await expect(
      console_.reconcile(midway, { ...decision, evidenceRef: "a different story" }),
    ).rejects.toThrow(/different contents/);
    await expect(
      console_.reconcile(midway, {
        ...decision,
        resolution: { ...decision.resolution, provider: "provider-z" },
      }),
    ).rejects.toThrow(/different contents/);
  });

  it("resumes the identical decision", async () => {
    const { midway, decision } = await durableDecisionThenFailure("effect-identical");

    const resumed = await console_.reconcile(midway, decision);

    expect(resumed.reservation.status).toBe("settled");
  });

  it("reports a durable decision whose cost write failed as recorded, not completed", async () => {
    const { midway } = await durableDecisionThenFailure("effect-recorded");

    const [entry] = (await spend.status(RUN)).filter(
      (item) => item.reservationId === midway.reservationId,
    );

    // Still waiting on someone. Calling this completed would tell an operator the matter is closed
    // while the reservation is unresolved.
    expect(entry?.status).toBe("billing_unknown");
    expect(entry?.reconciliationHistory.at(-1)?.outcome).toBe("decision_recorded");
    expect(entry?.requiresReconciliation).toBe(true);
  });
});

describe("partial settlement keeps what it already wrote", () => {
  it("names the durable cost ids and the unresolved remainder", async () => {
    // Two observations, the second failing. Marking unknown with an empty list dropped the first
    // from the reservation, so a later reconciliation had no way to know part of the charge was
    // already durable — and could settle a total that double-counted it.
    let appends = 0;
    const partial = new SpendService({
      store,
      costs: {
        list: () => costs.list(RUN),
        append: (runId, record) => {
          appends += 1;
          return appends > 1
            ? Promise.reject(new Error("store down"))
            : costs.append(runId, record);
        },
      },
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });

    const outcome = await partial.reserve({
      grant,
      operation: "agent.execute",
      runId: RUN,
      stageId: "outline.draft",
      attemptId: "att-1",
      effectKey: "effect-partial",
      expectation: { kind: "estimated", amount: { amount: "2.0000", currency: "USD" } },
    });
    if (!outcome.reserved) throw new Error("expected a reservation");
    const prepared = await partial.prepareDispatch(outcome.reservation, {
      backendId: "backend-a",
      backendVersion: "1.0.0",
      ceilingEnforced: false,
    });

    const charge = {
      provider: "provider-a",
      operation: "completion",
      billingStatus: "charged" as const,
      actual: { amount: "0.3000", currency: "USD" },
    };
    await expect(partial.settle(prepared, [charge, charge], {})).rejects.toThrow(/store down/);

    const [entry] = (await partial.status(RUN)).filter(
      (item) => item.reservationId === prepared.reservationId,
    );

    // The record that landed is named, so reconciliation can see it rather than re-counting it.
    expect(entry?.costIds).toHaveLength(1);
    expect(entry?.costIds[0]).toBe(`${prepared.reservationId}:cost:0`);
    expect(entry?.unresolvedReason).toContain("1 of 2");
    expect(entry?.requiresReconciliation).toBe(true);
  });
});

describe("unknown billing is counted by the absence of an actual amount", () => {
  it("counts an unknown record that carries only an estimate", async () => {
    // §19.3: an estimate does not resolve an unknown charge. Requiring both fields to be absent
    // counted an estimated-but-unknown record as quantified.
    const reservation = await unresolved("effect-estimated");
    await costs.append(RUN, {
      schemaVersion: SCHEMA_VERSION,
      costId: `${reservation.reservationId}:cost:0`,
      runId: RUN,
      reservationId: reservation.reservationId,
      provider: "provider-a",
      operation: "completion",
      billingStatus: "unknown",
      estimated: { amount: "0.5000", currency: "USD" },
      recordedAt: "2026-01-01T00:00:00.000Z",
    });

    const [entry] = (await spend.status(RUN)).filter(
      (item) => item.reservationId === reservation.reservationId,
    );

    expect(entry?.unquantifiedUnknownBillingCount).toBe(1);
  });
});

describe("a settlement that failed partway (#152)", () => {
  /**
   * Two observations, two providers, and a cost store that dies after the first.
   *
   * The shape the previous review rejected: carrying a count told an operator that one of two
   * charges was unrecorded and nothing about which, so the only way to reconcile "the remainder"
   * was to read an English sentence and guess. With two different providers there is no figure
   * that describes the remainder — it is two charges, and attributing both to one provider is a
   * fabricated record.
   */
  async function partiallySettled() {
    const outcome = await spend.reserve({
      grant,
      operation: "agent.execute",
      runId: RUN,
      stageId: "outline.draft",
      attemptId: "att-1",
      effectKey: "effect-partial",
      expectation: { kind: "estimated", amount: { amount: "2.0000", currency: "USD" } },
    });
    if (!outcome.reserved) throw new Error("expected a reservation");
    const prepared = await spend.prepareDispatch(outcome.reservation, {
      backendId: "backend-a",
      backendVersion: "1.0.0",
      ceilingEnforced: false,
    });

    // Fails on the second append only, so observation 0 is genuinely durable.
    let appended = 0;
    const flaky: CostRecordStore = {
      list: costs.list,
      append: (runId, record) => {
        appended += 1;
        if (appended > 1) return Promise.reject(new Error("cost store unavailable"));
        return costs.append(runId, record);
      },
    };
    const flakySpend = new SpendService({
      store,
      costs: flaky,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });

    await expect(
      flakySpend.settle(
        prepared,
        [
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
        {},
      ),
    ).rejects.toThrow(/cost store unavailable/);
    return prepared.reservationId;
  }

  it("identifies the durable and the unrecorded portion across a restart", async () => {
    const reservationId = await partiallySettled();

    // A new service over the same directory: the operator comes back tomorrow, and everything
    // they need is in the stream rather than in the process that failed.
    const restarted = new SpendService({
      store: new FileSpendReservationStore({ root }),
      costs,
      now: () => new Date("2026-01-02T00:00:00.000Z"),
    });
    const [entry] = (await restarted.status(RUN)).filter(
      (item) => item.reservationId === reservationId,
    );

    expect(entry?.durableCosts).toEqual([
      { costId: `${reservationId}:cost:0`, provider: "provider-a", operation: "completion" },
    ]);
    expect(entry?.pendingObservations).toEqual([
      {
        observationId: `${reservationId}:cost:1`,
        provider: "provider-b",
        operation: "embedding",
      },
    ]);
  });

  it("settles only the named portion, with neither loss nor double count", async () => {
    const reservationId = await partiallySettled();
    const restarted = new SpendService({
      store: new FileSpendReservationStore({ root }),
      costs,
      now: () => new Date("2026-01-02T00:00:00.000Z"),
    });
    const operator = openOperatorConsole({ spend: restarted, actor: HUMAN });
    const stuck = await store.get(reservationId);

    const resolved = await operator.reconcile(stuck as NonNullable<typeof stuck>, {
      evidenceRef: "provider-b invoice line 7",
      decisionId: "dec-partial",
      resolution: {
        kind: "settled_with_amount",
        amount: { amount: "0.2500", currency: "USD" },
        observationId: `${reservationId}:cost:1`,
      },
    });

    // Who charged comes from the observation, not from the operator: provider-b billed it, and a
    // decision that could name a provider could name the wrong one.
    expect(resolved.costs[0]?.provider).toBe("provider-b");
    expect(resolved.costs[0]?.operation).toBe("embedding");
    expect(resolved.costs[0]?.costId).toBe(`${reservationId}:cost:1`);
    expect(resolved.reservation.status).toBe("settled");

    // Neither loss nor double count: two records, one per observation, summing to what was
    // actually charged. The durable one was not rewritten and the pending one was not added twice.
    const mine = costs.records.filter((record) => record.reservationId === reservationId);
    expect(mine.map((record) => record.costId).sort()).toEqual([
      `${reservationId}:cost:0`,
      `${reservationId}:cost:1`,
    ]);
    expect(
      mine.reduce((total, record) => total + Number(record.actual?.amount ?? 0), 0),
    ).toBeCloseTo(0.75, 4);

    const [entry] = (await restarted.status(RUN)).filter(
      (item) => item.reservationId === reservationId,
    );
    expect(entry?.pendingObservations).toEqual([]);
  });

  it("refuses a settlement that does not say which charge it covers", async () => {
    const reservationId = await partiallySettled();
    const stuck = await store.get(reservationId);
    await expect(
      console_.reconcile(stuck as NonNullable<typeof stuck>, {
        evidenceRef: "provider statement",
        decisionId: "dec-unnamed",
        resolution: {
          kind: "settled_with_amount",
          amount: { amount: "0.2500", currency: "USD" },
          provider: "provider-b",
          billedOperation: "embedding",
        },
      }),
    ).rejects.toThrow(/must name which one it covers/);
  });

  it("refuses to settle an observation that is already durable", async () => {
    // The double count, attempted directly. Observation 0 was written before the failure, so it
    // is not pending, and settling it again would put a second record against one charge.
    const reservationId = await partiallySettled();
    const stuck = await store.get(reservationId);
    await expect(
      console_.reconcile(stuck as NonNullable<typeof stuck>, {
        evidenceRef: "provider statement",
        decisionId: "dec-dup",
        resolution: {
          kind: "settled_with_amount",
          amount: { amount: "0.5000", currency: "USD" },
          observationId: `${reservationId}:cost:0`,
        },
      }),
    ).rejects.toThrow(/is not awaiting a record/);
  });

  it("keeps the reservation unresolved while a second observation is still pending", async () => {
    // Three observations, two unrecorded. Settling one must not release authorization for the
    // other — the release-before-durable ordering ADR-0044 forbids, one observation over.
    const outcome = await spend.reserve({
      grant,
      operation: "agent.execute",
      runId: RUN,
      stageId: "outline.draft",
      attemptId: "att-1",
      effectKey: "effect-three",
      expectation: { kind: "estimated", amount: { amount: "2.0000", currency: "USD" } },
    });
    if (!outcome.reserved) throw new Error("expected a reservation");
    const prepared = await spend.prepareDispatch(outcome.reservation, {
      backendId: "backend-a",
      backendVersion: "1.0.0",
      ceilingEnforced: false,
    });
    const flaky: CostRecordStore = {
      list: costs.list,
      append: () => Promise.reject(new Error("cost store unavailable")),
    };
    const flakySpend = new SpendService({
      store,
      costs: flaky,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });
    await expect(
      flakySpend.settle(
        prepared,
        [
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
        {},
      ),
    ).rejects.toThrow();

    const id = prepared.reservationId;
    const first = await console_.reconcile((await store.get(id)) as SpendReservationLike, {
      evidenceRef: "provider-a invoice line 1",
      decisionId: "dec-a",
      resolution: {
        kind: "settled_with_amount",
        amount: { amount: "0.5000", currency: "USD" },
        observationId: `${id}:cost:0`,
      },
    });
    expect(first.reservation.status).toBe("billing_unknown");

    const second = await console_.reconcile((await store.get(id)) as SpendReservationLike, {
      evidenceRef: "provider-b invoice line 2",
      decisionId: "dec-b",
      resolution: {
        kind: "settled_with_amount",
        amount: { amount: "0.2500", currency: "USD" },
        observationId: `${id}:cost:1`,
      },
    });
    expect(second.reservation.status).toBe("settled");
    expect(
      costs.records
        .filter((record) => record.reservationId === id)
        .map((record) => record.provider)
        .sort(),
    ).toEqual(["provider-a", "provider-b"]);
  });
});

describe("re-recording one decision as the clock advances", () => {
  it("is idempotent for an investigation that ended unresolved", async () => {
    // `#transition` stamps a fresh `at`, and the store compares an existing transition id
    // byte-for-byte. Without a presence-and-digest check that made a retry a permanent conflict:
    // the same finding, recorded a minute later, could never be re-recorded.
    let tick = 0;
    const advancing = new SpendService({
      store,
      costs,
      now: () => new Date(Date.UTC(2026, 0, 1, 0, tick++)),
    });
    const operator = openOperatorConsole({ spend: advancing, actor: HUMAN });
    const reservation = await unresolved("effect-clock");

    const input = {
      evidenceRef: evidence,
      decisionId: "dec-clock",
      resolution: { kind: "investigation_ended" as const },
    };
    await operator.reconcile(reservation, input);
    const again = await operator.reconcile(reservation, input);

    expect(again.reservation.status).toBe("billing_unknown");
    const [entry] = (await advancing.status(RUN)).filter(
      (item) => item.reservationId === reservation.reservationId,
    );
    // Once, not twice. A second entry would tell a later investigator two people looked.
    expect(
      entry?.reconciliationHistory.filter((item) => item.outcome === "audit_only"),
    ).toHaveLength(1);
  });

  it("still refuses the same decision id carrying a changed finding", async () => {
    let tick = 0;
    const advancing = new SpendService({
      store,
      costs,
      now: () => new Date(Date.UTC(2026, 0, 1, 0, tick++)),
    });
    const operator = openOperatorConsole({ spend: advancing, actor: HUMAN });
    const reservation = await unresolved("effect-clock-2");

    await operator.reconcile(reservation, {
      evidenceRef: evidence,
      decisionId: "dec-clock-2",
      resolution: { kind: "investigation_ended" },
    });
    await expect(
      operator.reconcile(reservation, {
        evidenceRef: "a different statement entirely",
        decisionId: "dec-clock-2",
        resolution: { kind: "investigation_ended" },
      }),
    ).rejects.toThrow(/carrying different contents|already carries/);
  });
});
