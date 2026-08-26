import { describe, expect, it } from "vitest";

import type { CostReport } from "@aldus-runtime/services";

import { renderCosts } from "../src/render.js";

/**
 * The listing must not offer a verb the state cannot accept (#226).
 *
 * `costs` listed a `reserved` reservation holding real money and named `aldus costs settle` as its
 * resolution. `settle` accepts only `billing_unknown`, so every reservation in that section was one
 * the named command would refuse — the one place that tells an operator what to do naming the one
 * command that would not work.
 */

const report = (status: "reserved" | "billing_unknown"): CostReport =>
  ({
    runId: "run-a",
    records: [],
    summary: { recordCount: 0, actualByCurrency: {}, estimatedByCurrency: {} },
    unresolved: [
      {
        reservationId: "res-a",
        status,
        operation: "agent.execute",
        reservedAuthorizationAmount: { amount: "12.00", currency: "USD" },
        requiresReconciliation: status === "billing_unknown",
      },
    ],
  }) as unknown as CostReport;

describe("each unresolved state is offered the verb that accepts it", () => {
  it("sends a stuck `reserved` reservation to `costs abandon`", () => {
    const out = renderCosts(report("reserved"));
    expect(out).toContain("costs abandon");
    expect(out).toContain("res-a");
  });

  it("sends an unresolved charge to `costs settle`", () => {
    // The other half, and the reason this is two assertions rather than one: a render that named
    // `abandon` everywhere would pass the first test and be exactly as wrong.
    const out = renderCosts(report("billing_unknown"));
    expect(out).toContain("aldus costs settle <reservation-id>");
    expect(out).not.toContain("costs abandon");
  });
});
