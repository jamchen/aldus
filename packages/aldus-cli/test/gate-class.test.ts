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
 * satisfied is what makes `currentlyBlocking` false.
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
      state: { status: "in_progress", waitingOn: [], releasedStages: [], currentStage: undefined },
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
  currentlyBlocking: false,
  ...over,
});

describe("a gate's class is not its state", () => {
  it("calls a satisfied blocking gate blocking, not advisory", () => {
    const out = renderStatus(report([gate({ state: "satisfied", currentlyBlocking: false })]));
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
    const out = renderStatus(report([gate({ state: "pending", currentlyBlocking: true })]));
    expect(out).toContain("(blocking)");
    expect(out).toContain("stops work");
  });

  it("reads `currentlyBlocking`, not the pre-#204 `blocking`", () => {
    // The rename is only a rename if the renderer followed it. A row that carries `blocking` under
    // the old name — a payload built before the rename — must not print "stops work", or the
    // renderer is still reading the field the type no longer has.
    const out = renderStatus(
      report([gate({ state: "pending", currentlyBlocking: false, blocking: true })]),
    );
    expect(out).toContain("(blocking)");
    expect(out).not.toContain("stops work");
  });

  it("does not say a satisfied gate stops work", () => {
    // The control: the two facts must not collapse back into one in the other direction either.
    const out = renderStatus(report([gate({ state: "satisfied", currentlyBlocking: false })]));
    expect(out).not.toContain("stops work");
  });
});

describe("status says why a gate is stuck", () => {
  it("shows the explanation the engine composed for an unproduced subject", () => {
    // The engine writes this sentence precisely so `pending` is not read as "nobody has got to it
    // yet". An adopter hit an unproduced subject three times in one run and read all three that
    // way, because the sentence never left the report.
    const out = renderStatus(
      report([
        gate({
          gateId: "caption.sync",
          state: "pending",
          currentlyBlocking: true,
          missingSubjects: ["subtitle/sync-report"],
          explanation:
            'Gate "caption.sync" has no recorded decision, and "subtitle/sync-report" has not ' +
            "been supplied: nothing has produced what the approval would bind.",
        }),
      ]),
    );

    expect(out).toContain("nothing has produced");
  });

  it("names the missing subjects and the upstream blocker", () => {
    const out = renderStatus(
      report([
        gate({
          gateId: "release.upload",
          state: "blocked_upstream",
          currentlyBlocking: true,
          missingSubjects: ["release/receipt"],
          blockedBy: ["caption.sync"],
        }),
      ]),
    );

    expect(out).toContain("not supplied: release/receipt");
    expect(out).toContain("blocked by: caption.sync");
  });

  it("stays quiet about a satisfied gate, so the line that matters is still read", () => {
    // The control. Noise is how an explanation stops being read, so a gate that is fine says
    // nothing beyond its row.
    const out = renderStatus(
      report([
        gate({ state: "satisfied", currentlyBlocking: false, explanation: "should not appear" }),
      ]),
    );

    expect(out).not.toContain("should not appear");
  });
});
