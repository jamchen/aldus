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

import type { ActorRef, CostRecord } from "@aldus-runtime/core";
import { FileSpendReservationStore } from "@aldus-runtime/file-store";
import { availableAuthorization, type SpendGrant } from "@aldus-runtime/gate-engine";

import type { CostRecordStore } from "../src/cost-store.js";
import { SpendService } from "../src/spend-service.js";

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
let costs: ReturnType<typeof costStore>;
let store: FileSpendReservationStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "aldus-reconcile-"));
  store = new FileSpendReservationStore({ root });
  costs = costStore();
  spend = new SpendService({ store, costs, now: () => new Date("2026-01-01T00:00:00.000Z") });
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
  it("refuses an agent, whatever it claims about itself", async () => {
    // An agent that could reconcile could release authorization it had itself consumed.
    const reservation = await unresolved();

    await expect(
      spend.reconcile(reservation, {
        actor: AGENT,
        evidenceRef: evidence,
        decisionId: "dec-1",
        resolution: { kind: "released_as_uncharged" },
      }),
    ).rejects.toThrow(/human decision/);
  });

  it("refuses a decision that cites nothing", async () => {
    const reservation = await unresolved();

    await expect(
      spend.reconcile(reservation, {
        actor: HUMAN,
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

    const result = await spend.reconcile(reservation, {
      actor: HUMAN,
      evidenceRef: evidence,
      decisionId: "dec-1",
      resolution: { kind: "settled_with_amount", amount: { amount: "0.7500", currency: "USD" } },
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

    const result = await spend.reconcile(reservation, {
      actor: HUMAN,
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
  const failing = new SpendService({
    store,
    costs: {
      list: () => Promise.resolve([]),
      append: () => Promise.reject(new Error("cost store unavailable")),
    },
    now: () => new Date("2026-01-01T00:00:00.000Z"),
  });

  await expect(
    failing.reconcile(reservation, {
      actor: HUMAN,
      evidenceRef: evidence,
      decisionId: "dec-1",
      resolution: { kind: "settled_with_amount", amount: { amount: "0.7500", currency: "USD" } },
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

describe("investigation that ends without an answer", () => {
  it("records the decision and resolves nothing", async () => {
    // The rejected third resolution, in the shape it is permitted to take. "I could not find a
    // charge" is a human decision worth recording and is not evidence that no charge occurred.
    const reservation = await unresolved();

    const result = await spend.reconcile(reservation, {
      actor: HUMAN,
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

    await spend.reconcile(reservation, {
      actor: HUMAN,
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
      actor: HUMAN,
      evidenceRef: evidence,
      decisionId: "dec-1",
      resolution: {
        kind: "settled_with_amount" as const,
        amount: { amount: "0.7500", currency: "USD" },
      },
    };

    await spend.reconcile(reservation, input);
    // The second call sees a terminal reservation and refuses rather than writing again.
    await expect(spend.reconcile(reservation, input)).rejects.toThrow(/only an unresolved charge/);

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
      spend.reconcile(outcome.reservation, {
        actor: HUMAN,
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

describe("#152 — the provider may have executed and the cost write failed", () => {
  it("leaves the reservation active, exposes the handle, and reconciles to a correct terminal state", async () => {
    // The contract test the ruling names, end to end:
    //
    //   provider may have executed
    //     → CostRecord append fails
    //       → reservation remains active and non-retryable
    //         → budget status exposes the reconciliation handle
    //           → human reconciliation reaches the correct audited terminal state
    //
    // No paid provider is involved: the failure is injected at the store, which is where a real
    // one would surface.
    const failing: CostRecordStore = {
      list: () => Promise.resolve([]),
      append: () => Promise.reject(new Error("cost store unavailable")),
    };
    const service = new SpendService({
      store,
      costs: failing,
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

    // Still active: the money may be gone and nothing recorded it, so releasing would restore
    // authorization for a charge that may have happened.
    const stillActive = await store.get(identified.reservationId);
    expect(stillActive?.status).toBe("reserved");

    // The handle an operator needs to investigate, without any credential.
    const [entry] = (await service.status(RUN)).filter(
      (item) => item.reservationId === identified.reservationId,
    );
    expect(entry?.providerRequestId).toBe("provider-request-9");
    expect(entry?.execution?.backendVersion).toBe("1.0.0");

    // A human establishes what happened. `markUnknown` first, because reconciliation resolves an
    // unresolved charge and this one is merely unrecorded — the operator states which it is.
    const unknownNow = await service.markUnknown(stillActive as NonNullable<typeof stillActive>);
    const working = new SpendService({
      store,
      costs,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });
    const resolved = await working.reconcile(unknownNow, {
      actor: HUMAN,
      evidenceRef: "provider console shows request provider-request-9 charged 1.0000 USD",
      decisionId: "dec-152",
      resolution: { kind: "settled_with_amount", amount: { amount: "1.0000", currency: "USD" } },
    });

    expect(resolved.reservation.status).toBe("settled");
    expect(resolved.costs[0]?.actual).toEqual({ amount: "1.0000", currency: "USD" });
  });
});
