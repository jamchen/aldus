/**
 * `takePaidness` and `isPaid` (architecture contract §13.2, §19.3; #136).
 *
 * Pinned in this package's own suite because the receipt for PR #269 found that a hand mutant
 * removing the `incurredCharge === false → "free"` arm survived tts-ledger's 79 tests and was caught
 * only one package over, in services' composition tests. A property whose only pin is in another
 * package is a property this package can break without noticing, and the runner measuring this
 * package's suite alone would report SURVIVED for a mutation that services would catch — a
 * non-answer read as an answer.
 *
 * Three outcomes, each reached by every route to it, and `unknown` asserted as the residue rather
 * than derived from the other two: absence is **not** free, which is the whole finding of #136.
 */

import { SCHEMA_VERSION } from "@aldus-runtime/core";
import { describe, expect, it } from "vitest";

import { isPaid, takePaidness, takeRecordSchema, type TakeRecord } from "../src/take.js";
import { AT, OPERATOR, PLAN_ID, RUN_ID } from "./helpers.js";

/** A well-formed take carrying no charge evidence of any kind. */
function bareTake(overrides: Partial<TakeRecord> = {}): TakeRecord {
  return takeRecordSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    takeId: "take-1",
    runId: RUN_ID,
    planId: PLAN_ID,
    segmentId: "seg-1",
    attempt: 1,
    text: { raw: "Something." },
    parameters: { provider: "provider-a", voice: "voice-a", model: "model-a" },
    recordedAt: AT,
    ...overrides,
  });
}

describe("takePaidness: paid", () => {
  it("a cost record reference is charge evidence", () => {
    const take = bareTake({ costRecordId: "cost-a" });
    expect(takePaidness(take)).toBe("paid");
    expect(isPaid(take)).toBe(true);
  });

  it("an unauthorized charge is charge evidence — the money was already spent", () => {
    const take = bareTake({
      unauthorizedCharge: {
        reason: "authorization expired before the provider answered",
        acknowledgedBy: OPERATOR,
        acknowledgedAt: AT,
      },
    });
    expect(takePaidness(take)).toBe("paid");
    expect(isPaid(take)).toBe(true);
  });

  it("the adapter reporting a charge is charge evidence", () => {
    const take = bareTake({ delivery: { adapterId: "adapter-a", incurredCharge: true } });
    expect(takePaidness(take)).toBe("paid");
    expect(isPaid(take)).toBe(true);
  });

  it("charge evidence outranks an adapter saying the delivery was free", () => {
    // A cost record was written; the adapter's report does not un-spend the money.
    const take = bareTake({
      costRecordId: "cost-a",
      delivery: { adapterId: "adapter-a", incurredCharge: false },
    });
    expect(takePaidness(take)).toBe("paid");
  });
});

describe("takePaidness: free", () => {
  it("only the adapter saying so makes a take free", () => {
    // The arm the PR #269 receipt found unpinned here. Without it this take reads `unknown`, and
    // every caller branching on `free` — retention, cost summaries — silently loses the case.
    const take = bareTake({ delivery: { adapterId: "adapter-a", incurredCharge: false } });
    expect(takePaidness(take)).toBe("free");
    expect(isPaid(take)).toBe(false);
  });

  it("an authorization is not charge evidence, so an authorized free delivery is still free", () => {
    // The #133 ruling: permitted is not spent. Seven takes were authorised and rendered for nothing.
    const take = bareTake({
      authorization: {
        gateId: "performance-freeze",
        decisionId: "dec-a",
        grantId: "grant-a",
        planScopeSha256: "a".repeat(64),
      },
      delivery: { adapterId: "adapter-a", incurredCharge: false },
    });
    expect(takePaidness(take)).toBe("free");
  });
});

describe("takePaidness: unknown", () => {
  it("nothing recorded establishes nothing — and unknown is not free", () => {
    const take = bareTake();
    expect(takePaidness(take)).toBe("unknown");
    expect(takePaidness(take)).not.toBe("free");
    expect(isPaid(take)).toBe(false);
  });

  it("a delivery that does not say whether it charged is unknown, not free", () => {
    // The replay adapter's shape: bytes bought once by another take, delivered again with the field
    // omitted. `free` would say they were never bought.
    const take = bareTake({
      delivery: { adapterId: "adapter-replay", mechanism: "replay", sourceTakeId: "take-0" },
    });
    expect(takePaidness(take)).toBe("unknown");
  });

  it("an authorization alone is unknown, because permitted is not spent", () => {
    const take = bareTake({
      authorization: {
        gateId: "performance-freeze",
        decisionId: "dec-a",
        grantId: "grant-a",
        planScopeSha256: "a".repeat(64),
      },
    });
    expect(takePaidness(take)).toBe("unknown");
    expect(isPaid(take)).toBe(false);
  });
});
