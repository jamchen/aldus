import { describe, expect, it } from "vitest";

import type { ReworkStatusReport } from "@aldus-runtime/services";

import { renderRework } from "../src/render.js";

/**
 * `rework status` output (#220 criterion 7).
 *
 * Three questions an operator had to reconstruct from eight stage executions: which round the loop
 * is on, why another is allowed, and why it stopped. The first adopter reconstructed exactly that
 * by hand, from a bash loop and a grep, and the reconstruction is what went wrong.
 */

const A = "a".repeat(64);
const B = "b".repeat(64);

const report = (loop: Partial<ReworkStatusReport["loops"][number]>): ReworkStatusReport =>
  ({
    runId: "run-a",
    loops: [{ policyId: "policy-a", stageId: "script.oracle", rounds: [], spent: 0, ...loop }],
  }) as unknown as ReworkStatusReport;

describe("the loop explains where it is", () => {
  it("says nothing to decide when the evaluating stage has never run", () => {
    // Not "converged". A loop that has not started and one that finished clean have the same empty
    // round list, and the difference is the whole reason `not_evaluated` exists.
    const out = renderRework(report({}));

    expect(out).toContain("has not run");
    expect(out).not.toContain("converged");
  });

  it("names the next round and what the repair is being asked to fix", () => {
    const out = renderRework(
      report({
        decision: {
          kind: "rework",
          round: 2,
          repairStageId: "script.revise",
          consumeFindingClasses: ["comprehension"],
          inputDigest: A,
        },
      }),
    );

    expect(out).toContain("round 2");
    expect(out).toContain("script.revise");
    expect(out).toContain("comprehension");
  });

  it("prints the stop reason's sentence, not only its name", () => {
    // "bounds_exhausted" tells a reader what state it is in and not what to do — and the two most
    // useful reasons argue against the obvious next move. The sentence is the part that does.
    const out = renderRework(
      report({
        spent: 2,
        decision: {
          kind: "escalate",
          gateId: "script.freeze",
          reason: "regression",
          explanation: "The last repair increased findings from 4 to 7.",
          artifactDigest: B,
          candidates: [
            { digest: A, findingCount: 4 },
            { digest: B, findingCount: 7 },
          ],
        },
      }),
    );

    expect(out).toContain("regression");
    expect(out).toContain("increased findings from 4 to 7");
    expect(out).toContain("script.freeze");
  });

  it("lists candidates unranked, and says so", () => {
    // The loop carries the newest forward and the newest is not the best after a regression. A
    // reader takes the first entry as advice unless told otherwise, so it is told otherwise.
    //
    // The counts descend deliberately. The first version of this fixture was 4 then 7 — already in
    // ascending order — so a renderer that sorted by count produced the identical output and the
    // assertion passed. An assertion true for another reason, in the test written to stop the
    // ranking. 7 then 4 makes sorting observable.
    const out = renderRework(
      report({
        decision: {
          kind: "escalate",
          gateId: "script.freeze",
          reason: "regression",
          explanation: "worse",
          artifactDigest: B,
          candidates: [
            { digest: A, findingCount: 7 },
            { digest: B, findingCount: 4 },
          ],
        },
      }),
    );

    expect(out).toContain("not ranked");
    // Record order: oldest first, whatever the counts say. Sorted output reads as a recommendation.
    expect(out.indexOf(A.slice(0, 8))).toBeLessThan(out.indexOf(B.slice(0, 8)));
  });

  it("marks an unmeasured candidate rather than showing a count", () => {
    const out = renderRework(
      report({
        decision: {
          kind: "escalate",
          gateId: "script.freeze",
          reason: "bounds_exhausted",
          explanation: "spent",
          artifactDigest: B,
          candidates: [{ digest: A }, { digest: B, findingCount: 7 }],
        },
      }),
    );

    expect(out).toContain("not measured");
  });

  it("says so when no policy is declared", () => {
    const out = renderRework({ runId: "run-a", loops: [] });

    expect(out).toContain("No rework policy is declared");
  });
});
