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

describe("the hint depends on who is asking", () => {
  // Reported by the first adopter from the first real use. They ran the printed command as
  // `ALDUS_ACTOR=agent:coordinator` and got `SPEND_NOT_AUTHORIZED: reconciliation is a human
  // decision`. The refusal is right — an agent that could reconcile could release authorization it
  // had itself consumed — but the listing told the current actor to run a command the current
  // actor may not run, and the listing is where an agent coordinator looks.
  it("tells an agent to transcribe a human's decision", () => {
    const out = renderCosts(report("reserved"), "agent");
    expect(out).toContain("--decided-by");
    expect(out).toContain("--verbatim");
  });

  it("gives a human the plain form", () => {
    // The negative control, and the reason this is not just "always print the clause": a hint
    // printed to everyone is noise a human learns to skip, which is how it stops working on the
    // day it matters.
    const out = renderCosts(report("reserved"), "human");
    expect(out).not.toContain("--decided-by");
  });

  it("gives the plain form when the actor is unknown", () => {
    // An absent actor is not evidence of an agent. The mutating command will refuse an
    // unattributed invocation on its own terms (§19.2), and guessing here would put a clause in
    // front of every reader who has not configured one.
    expect(renderCosts(report("reserved"))).not.toContain("--decided-by");
  });

  it("carries the clause on the unresolved-charge line too", () => {
    // Both sections name a verb that reconciles, so both need it. Fixing only the one in the bug
    // report would leave the same round trip one line up.
    const out = renderCosts(report("billing_unknown"), "agent");
    expect(out).toContain("--decided-by");
  });
});
