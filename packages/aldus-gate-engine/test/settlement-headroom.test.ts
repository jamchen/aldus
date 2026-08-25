/**
 * A settled reservation stops consuming what it reserved and starts consuming what it cost.
 *
 * This exists because the prose drifted from the protocol first. A docstring described
 * `maxTotal ÷ maxPerRequest` as a lifetime dispatch count — "eight dispatches whatever they
 * actually cost" — which is true only of reservations that are still outstanding. Once they settle
 * below the ceiling the difference returns, and a run can dispatch far more than the quotient.
 *
 * Prose cannot be prevented from drifting, but it can be made to fail when it does.
 */

import { describe, expect, it } from "vitest";

import { SCHEMA_VERSION, type CostRecord, type SpendReservation } from "@aldus-runtime/core";

import { availableAuthorization, type SpendGrant } from "../src/index.js";

const usd = (amount: string) => ({ amount, currency: "USD" });

const grant = (): SpendGrant => ({
  grantId: "grant-agent",
  runId: "run-a",
  gateId: "performance.freeze",
  decisionId: "decision-a",
  scope: { operations: ["agent.execute"] },
  unestimatedExecution: "reserve_max_per_request",
  maxTotal: usd("25.0000"),
  maxPerRequest: usd("3.0000"),
});

const reservation = (overrides: Partial<SpendReservation> = {}): SpendReservation =>
  ({
    schemaVersion: SCHEMA_VERSION,
    reservationId: "res-a",
    grantId: "grant-agent",
    authorizationId: "decision-a",
    operation: "agent.execute",
    runId: "run-a",
    stageId: "script.draft",
    attemptId: "att-1",
    effectKey: "att-1:writer",
    reserved: usd("3.0000"),
    status: "reserved",
    costIds: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  }) as SpendReservation;

const cost = (overrides: Partial<CostRecord> = {}): CostRecord =>
  ({
    schemaVersion: SCHEMA_VERSION,
    costId: "cost-a",
    runId: "run-a",
    stageId: "script.draft",
    attemptId: "att-1",
    provider: "provider-a",
    operation: "agent.execute",
    // A cost belongs to a grant through the decision that authorized it, not through the grant id.
    authorizationId: "decision-a",
    actual: usd("0.2000"),
    billingStatus: "charged",
    reservationId: "res-a",
    recordedAt: "2026-01-01T00:00:10.000Z",
    ...overrides,
  }) as CostRecord;

describe("settlement returns unused headroom", () => {
  it("an outstanding unestimated reservation consumes the whole per-request ceiling", () => {
    // This is the half the docstring had right, and it is why the quotient bounds concurrency.
    const availability = availableAuthorization(grant(), [], [reservation()]);

    expect(availability.reserved).toEqual(usd("3.0000"));
    expect(availability.available).toEqual(usd("22.0000"));
  });

  it("after settling below the ceiling, the difference is available again", () => {
    // $3 reserved, $0.20 actually charged. If the reservation still counted at $3 the available
    // amount would be $22; it is $24.80, which is the released $2.80 back in the pool.
    const settled = reservation({ status: "settled", costIds: ["cost-a"] });
    const availability = availableAuthorization(grant(), [cost()], [settled]);

    expect(availability.reserved).toEqual(usd("0"));
    expect(availability.available).toEqual(usd("24.8000"));
  });

  it("so the quotient bounds outstanding dispatches, not the run", () => {
    // Nine settled cheap dispatches against a grant whose quotient is eight. If maxTotal were a
    // lifetime dispatch count this would be refused; it is not, and $23.20 remains.
    const settledCosts = Array.from({ length: 9 }, (_, index) =>
      cost({ costId: `cost-${index}`, reservationId: `res-${index}` }),
    );
    const settledReservations = Array.from({ length: 9 }, (_, index) =>
      reservation({
        reservationId: `res-${index}`,
        effectKey: `att-1:writer-${index}`,
        status: "settled",
        costIds: [`cost-${index}`],
      }),
    );

    const availability = availableAuthorization(grant(), settledCosts, settledReservations);

    expect(availability.available).toEqual(usd("23.2000"));
    expect(availability.determinate).toBe(true);
  });

  it("but an unresolved charge does not release anything, because its size is not known", () => {
    // The asymmetry the docstring has to carry: settled returns headroom, unresolved does not.
    const unknown = reservation({ status: "billing_unknown" });
    const availability = availableAuthorization(grant(), [], [unknown]);

    expect(availability.reserved).toEqual(usd("3.0000"));
    expect(availability.available).toEqual(usd("22.0000"));
  });
});
