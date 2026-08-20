/**
 * A grant is a budget pool; a decision is who authorized its terms (#155).
 *
 * The defect this prevents is invisible at the point someone causes it. Adding a gate for agent
 * spend that shares a `decisionId` with paid synthesis couples the two ledgers; adding one with
 * its own decision does not — and both look identical when written. The first shape means an
 * unresolved agent charge quietly reduces what synthesis may spend.
 */

import { describe, expect, it } from "vitest";

import { SCHEMA_VERSION, type SpendReservation } from "@aldus-runtime/core";

import {
  availableAuthorization,
  checkSpendScope,
  grantTermsDigest,
  type SpendGrant,
} from "../src/index.js";

const usd = (amount: string) => ({ amount, currency: "USD" });

function grant(overrides: Partial<SpendGrant> = {}): SpendGrant {
  return {
    grantId: "grant-tts",
    runId: "run-a",
    gateId: "performance.freeze",
    decisionId: "decision-shared",
    scope: { operations: ["tts.synthesize"] },
    maxTotal: usd("10.0000"),
    ...overrides,
  };
}

function reservation(overrides: Partial<SpendReservation> = {}): SpendReservation {
  return {
    schemaVersion: SCHEMA_VERSION,
    reservationId: "res-a",
    grantId: "grant-agent",
    authorizationId: "decision-shared",
    operation: "agent.execute",
    runId: "run-a",
    stageId: "outline.draft",
    attemptId: "att-1",
    effectKey: "effect-a",
    reserved: usd("2.0000"),
    status: "reserved",
    costIds: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as SpendReservation;
}

describe("availability is derived per grant, not per decision", () => {
  it("an agent reservation sharing a decision does not consume the synthesis grant", () => {
    // The hazard, stated as a test. Both grants name `decision-shared`; only the agent grant is
    // drawn on. Partitioning by decision would have made this reduce synthesis headroom.
    const tts = grant();

    const availability = availableAuthorization(tts, [], [reservation()]);

    expect(availability.reserved).toEqual(usd("0"));
    expect(availability.available).toEqual(usd("10.0000"));
  });

  it("a reservation against this grant does consume it", () => {
    const tts = grant();

    const availability = availableAuthorization(
      tts,
      [],
      [reservation({ grantId: "grant-tts", operation: "tts.synthesize" })],
    );

    expect(availability.reserved).toEqual(usd("2.0000"));
    expect(availability.available).toEqual(usd("8.0000"));
  });

  it("two grants under one decision are separate pools", () => {
    // What the ruling requires an adopter to be able to express: one human decision may establish
    // an agent grant and a TTS grant, and aggregating them must be an explicit policy above both
    // rather than an accident of reusing a decisionId.
    const agent = grant({ grantId: "grant-agent", scope: { operations: ["agent.execute"] } });
    const tts = grant();
    const reservations = [reservation()];

    expect(availableAuthorization(agent, [], reservations).reserved).toEqual(usd("2.0000"));
    expect(availableAuthorization(tts, [], reservations).reserved).toEqual(usd("0"));
  });
});

describe("a grant states what it may be spent on", () => {
  it("refuses an operation the grant does not authorize", () => {
    const refusal = checkSpendScope(grant(), "agent.execute");

    expect(refusal).toBeDefined();
    expect(refusal?.authorized).toEqual(["tts.synthesize"]);
  });

  it("permits an operation it does authorize", () => {
    expect(checkSpendScope(grant(), "tts.synthesize")).toBeUndefined();
  });

  it("binds scope into the authorization digest, so widening it voids the approval", () => {
    // §13.2's rule applied to scope. Changing a grant from agent-only to TTS-capable widens what
    // an approval permits exactly as raising its ceiling does, and an approval surviving that
    // change did not bind what it appeared to bind.
    const agentOnly = grant({ scope: { operations: ["agent.execute"] } });
    const alsoTts = grant({ scope: { operations: ["agent.execute", "tts.synthesize"] } });

    expect(grantTermsDigest(agentOnly)).not.toBe(grantTermsDigest(alsoTts));
  });

  it("does not depend on the order operations were listed in", () => {
    // The set is the term. Re-listing the same operations must not read as a different approval.
    const a = grant({ scope: { operations: ["agent.execute", "tts.synthesize"] } });
    const b = grant({ scope: { operations: ["tts.synthesize", "agent.execute"] } });

    expect(grantTermsDigest(a)).toBe(grantTermsDigest(b));
  });
});
