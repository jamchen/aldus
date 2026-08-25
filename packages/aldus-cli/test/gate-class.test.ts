import { describe, expect, it } from "vitest";

import type { StatusReport } from "@aldus-runtime/services";

import { renderStatus } from "../src/index.js";

/**
 * A gate's **class** and whether it is stopping work **now** are different facts.
 *
 * `status` rendered both from `blocking` alone, so a satisfied blocking gate printed `(advisory)` —
 * false about its class, and the opposite of what the gate exists for. An adopter driving a real
 * run saw every passing gate in their repository reported as advisory, and none of them is.
 *
 * The gates it misdescribed were exactly the ones that had already done their job, because being
 * satisfied is what makes `blocking` false.
 */

type Gate = Record<string, unknown>;

/** The gates live on the focused Run report, which is the shape `status` renders. */
const report = (gates: Gate[]): StatusReport =>
  ({
    workspaceRoot: "/w",
    initialized: true,
    runs: [],
    summary: "one run",
    focused: {
      run: { runId: "run-a", workflowId: "wf", workflowVersion: "1" },
      state: { status: "in_progress", waitingOn: [], currentStage: undefined },
      stages: [],
      gates,
      costs: { recordCount: 0, byCurrency: {}, unknown: 0 },
      plan: { next: [], blocked: [], summary: "" },
    },
  }) as unknown as StatusReport;

const gate = (over: Gate): Gate => ({
  gateId: "script.freeze",
  level: "content_freeze",
  enforcement: "blocking",
  state: "satisfied",
  blocking: false,
  ...over,
});

describe("a gate's class is not its state", () => {
  it("calls a satisfied blocking gate blocking, not advisory", () => {
    const out = renderStatus(report([gate({ state: "satisfied", blocking: false })]));
    expect(out).toContain("script.freeze  satisfied  (blocking)");
    expect(out).not.toContain("advisory");
  });

  it("calls an advisory gate advisory whatever its state", () => {
    const out = renderStatus(
      report([gate({ gateId: "lint.report", enforcement: "advisory", state: "pending" })]),
    );
    expect(out).toContain("lint.report  pending  (advisory)");
  });

  it("says separately when a gate is stopping work right now", () => {
    const out = renderStatus(report([gate({ state: "pending", blocking: true })]));
    expect(out).toContain("(blocking)");
    expect(out).toContain("stops work");
  });

  it("does not say a satisfied gate stops work", () => {
    // The control: the two facts must not collapse back into one in the other direction either.
    const out = renderStatus(report([gate({ state: "satisfied", blocking: false })]));
    expect(out).not.toContain("stops work");
  });
});
