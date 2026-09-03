/**
 * `status` must not name a decided gate as what a Run waits on (#278, ADR-0059).
 *
 * The adopter's output, on a real Run:
 *
 * ```
 * Run run_… (waiting) at script.revise
 * Waiting  script.comprehension
 * ```
 *
 * `script.comprehension` was `satisfied`. A reader was told to go and decide something that had
 * been decided — the same family as #204, where a satisfied blocking gate printed `(advisory)`,
 * one field over: there the gate's *class* was rendered from what was true of it now, here what is
 * true of it now was rendered from a stage's *record* of where it stopped.
 *
 * The remedy has two halves, and both are asserted here. The gate must leave the "Waiting" line,
 * and the parked stage must not leave with it: nothing in the runtime re-runs a parked stage, so
 * an operator who is told nothing is left with an attempt that never completes.
 */

import { describe, expect, it } from "vitest";

import type { StatusReport } from "@aldus-runtime/services";

import { renderStatus } from "../src/index.js";

type Loose = Record<string, unknown>;

/** A focused Run report, the shape `status` renders. */
const report = (state: Loose, over: Loose = {}): StatusReport =>
  ({
    workspaceRoot: "/w",
    initialized: true,
    runs: [],
    summary: "one run",
    focused: {
      run: { runId: "run-a", workflowId: "workflow-a", workflowVersion: "1" },
      state: { waitingOn: [], releasedStages: [], goalStages: [], outstandingGoals: [], ...state },
      stages: [],
      gates: [],
      costs: { recordCount: 0, actualByCurrency: {}, estimatedByCurrency: {} },
      plan: { next: [], blocked: [], summary: "" },
      ...over,
    },
  }) as unknown as StatusReport;

describe("a decided gate is not a wait", () => {
  it("names a gate that still awaits a decision", () => {
    // The control for the two below: the line has to keep working for the case it exists for.
    const out = renderStatus(report({ status: "waiting", waitingOn: ["gate-a"] }));
    expect(out).toContain("Waiting  gate-a");
  });

  it("does not print a Waiting line when nothing awaits a decision", () => {
    const out = renderStatus(
      report({
        status: "completed",
        releasedStages: [{ stageId: "stage-a", gateId: "gate-a" }],
      }),
    );
    expect(out).not.toContain("Waiting");
  });

  it("says the stage is parked on a decision already made, and to run it again", () => {
    const out = renderStatus(
      report({
        status: "completed",
        releasedStages: [{ stageId: "stage-a", gateId: "gate-a" }],
      }),
    );
    expect(out).toContain("Released stage-a");
    expect(out).toContain('gate "gate-a" has been decided');
    expect(out).toContain("run the stage again");
  });

  it("names every released stage, not just one", () => {
    const out = renderStatus(
      report({
        status: "running",
        releasedStages: [
          { stageId: "stage-a", gateId: "gate-a" },
          { stageId: "stage-b", gateId: "gate-b" },
        ],
      }),
    );
    expect(out).toContain("Released stage-a");
    expect(out).toContain("Released stage-b");
  });

  it("prints both lines when one stage waits and another was released", () => {
    // The two facts are independent, and a renderer that treated them as one state would have to
    // pick — which is how the satisfied gate got printed as the wait in the first place.
    const out = renderStatus(
      report({
        status: "waiting",
        waitingOn: ["gate-b"],
        releasedStages: [{ stageId: "stage-a", gateId: "gate-a" }],
      }),
    );
    expect(out).toContain("Waiting  gate-b");
    expect(out).toContain("Released stage-a");
    expect(out).not.toContain("Waiting  gate-a");
  });
});
