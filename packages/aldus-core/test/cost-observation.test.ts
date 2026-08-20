/**
 * The billing/attribution split (contract §19.3; #107, ADR pending).
 *
 * A backend or Worker reports what it was charged. The Runtime states which Run, Stage, attempt
 * and authorization the charge belongs to. #107 reported an adopter with $7.05 of real agent spend
 * that Aldus could not record at all, and the reason asking a backend to supply attribution is the
 * wrong fix is in the same issue: a backend that forgets to copy an `authorizationId` produces a
 * charge nothing can hold against a budget.
 */

import { describe, expect, it } from "vitest";

import { SCHEMA_VERSION } from "../src/schema-version.js";
import { costObservationSchema, costRecordSchema } from "../src/schema/cost.js";

/** Fields the Runtime states, which an observation must therefore not carry. */
const RUNTIME_ATTRIBUTION = [
  "costId",
  "runId",
  "stageId",
  "attemptId",
  "authorizationId",
  "recordedAt",
] as const;

describe("a cost observation carries billing facts and no attribution", () => {
  it("omits every field the Runtime is responsible for stating", () => {
    const keys = new Set(Object.keys(costObservationSchema.shape));
    const leaked = RUNTIME_ATTRIBUTION.filter((field) => keys.has(field));
    expect(
      leaked,
      "a backend that can state its own run or authorization can state a wrong one, which is the " +
        "silent budget-bypass #107 reported",
    ).toEqual([]);
  });

  it("carries the billing facts a provider actually knows", () => {
    expect(Object.keys(costObservationSchema.shape).sort()).toEqual([
      "actual",
      "billingStatus",
      "estimated",
      "operation",
      "provider",
      "providerRequestId",
      "quantity",
    ]);
  });

  it("agrees with the record about every field it shares", () => {
    // Behavioural rather than introspective: the same billing values that satisfy a full
    // CostRecord must satisfy the observation, and a value the record rejects must be rejected
    // here too. A transcribed copy would pass a name check on the day it was written and disagree
    // about *types* after the first change to either (ADR-0031).
    const billing = {
      provider: "provider-a",
      operation: "agent.execute",
      actual: { amount: "1.051694", currency: "USD" },
      billingStatus: "charged",
    };
    expect(costObservationSchema.safeParse(billing).success).toBe(true);
    expect(
      costRecordSchema.safeParse({
        schemaVersion: SCHEMA_VERSION,
        costId: "cost-1",
        runId: "run-1",
        recordedAt: "2026-01-01T00:00:00.000Z",
        ...billing,
      }).success,
    ).toBe(true);

    // And the same rejection, from one definition rather than two that happen to agree today.
    const bad = { ...billing, billingStatus: "invented" };
    expect(costObservationSchema.safeParse(bad).success).toBe(false);
    expect(
      costRecordSchema.safeParse({
        schemaVersion: SCHEMA_VERSION,
        costId: "cost-1",
        runId: "run-1",
        recordedAt: "2026-01-01T00:00:00.000Z",
        ...bad,
      }).success,
    ).toBe(false);
  });

  it("accepts an observation with an actual amount and no estimate", () => {
    const parsed = costObservationSchema.safeParse({
      provider: "provider-a",
      operation: "agent.execute",
      actual: { amount: "1.051694", currency: "USD" },
      billingStatus: "charged",
    });
    expect(parsed.success).toBe(true);
  });
});
