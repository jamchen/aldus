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
    loops: [
      {
        policyId: "policy-a",
        stageId: "script.oracle",
        recordedRounds: [],
        refusedRepairs: [],
        ...loop,
      },
    ],
  }) as unknown as ReworkStatusReport;

describe("the loop explains where it is", () => {
  it("says why there is no preview, and never says converged", () => {
    // Not "converged". A loop that has not started and one that finished clean have the same empty
    // round list, and the difference is the whole reason `not_evaluated` exists.
    const out = renderRework(
      report({ previewUnavailable: "no completed attempt has judged a candidate" }),
    );

    expect(out).toContain("no preview");
    expect(out).toContain("no completed attempt has judged a candidate");
    expect(out).not.toContain("converged");
  });

  it("labels every line as recorded or as a preview", () => {
    // Nothing executes a policy yet. An unlabelled "stopped" reads as runtime-controlled execution
    // that has not happened, which is a counterfactual presented as operational status.
    const out = renderRework(
      report({
        wouldDecide: {
          kind: "escalate",
          gateId: "script.freeze",
          reason: "bounds_exhausted",
          explanation: "spent",
          artifactDigest: B,
          candidates: [{ digest: B }],
        },
      }),
    );

    // The sentence says Aldus does not execute a policy **by decision** (#220, closed 2026-09-03),
    // not that an executor is pending. A reader who takes "yet" as a roadmap plans around a
    // release that is not coming; the two words that carry it are asserted here so the claim
    // cannot quietly revert to the roadmap reading.
    expect(out).toContain("does not execute a rework policy, by decision");
    expect(out).not.toContain("yet");
    expect(out).toContain("recorded rounds");
    expect(out).toContain("would decide");
  });

  it("surfaces repairs the record cannot join rather than dropping them", () => {
    // A repair missing from the list reads as one that never ran, and a reader comparing that
    // against a bound concludes there is room left.
    const out = renderRework(
      report({
        refusedRepairs: [
          {
            repairAttemptId: "rep-9",
            reason: "candidate_input_ambiguous",
            explanation: "did not consume exactly one candidate",
          },
        ],
        previewUnavailable: "nothing judged",
      }),
    );

    expect(out).toContain("not joined");
    expect(out).toContain("rep-9");
    expect(out).toContain("candidate_input_ambiguous");
  });

  it("names the next round and what the repair is being asked to fix", () => {
    const out = renderRework(
      report({
        wouldDecide: {
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
        wouldDecide: {
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
        wouldDecide: {
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
        wouldDecide: {
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

  /**
   * The running-attempt arm (#220, ADR-0057).
   *
   * The line an operator acts on. It must name the attempt, say what is unestablished, point at the
   * bounded remedy, and never read as an escalation — there is no gate here and no candidate to
   * choose.
   */
  describe("an attempt recorded running", () => {
    const reconcile = (
      over: Partial<
        Extract<
          NonNullable<ReworkStatusReport["loops"][number]["wouldDecide"]>,
          { kind: "reconciliation_required" }
        >
      > = {},
    ): string =>
      renderRework(
        report({
          recordedRounds: [],
          wouldDecide: {
            kind: "reconciliation_required",
            stageId: "script.oracle",
            attemptId: "att-10",
            artifactDigest: A,
            explanation:
              'Attempt "att-10" of "script.oracle" is recorded as running, so round 1 can neither ' +
              "be said to have happened nor not happened. Reconcile it — `--force` takes the " +
              "stage over. This is not a statement that the attempt is dead, and not a statement " +
              "that a takeover is safe.",
            ...over,
          },
        }),
      );

    it("names the attempt, the uncertainty and the remedy", () => {
      const out = reconcile();

      expect(out).toContain("reconcile");
      expect(out).toContain("att-10");
      expect(out).toContain("script.oracle");
      expect(out).toContain("neither be said to have happened nor not happened");
      expect(out).toContain("--force");
    });

    it("does not read as an escalation or a convergence", () => {
      const out = reconcile();

      expect(out).not.toContain("stop (");
      expect(out).not.toContain("decide script.freeze");
      expect(out).not.toContain("converged");
      expect(out).not.toContain("candidates");
    });

    it("labels recorded evidence as establishing nothing about completion", () => {
      // Both timings from the ruling print the same qualifier. A count on its own reads as a
      // completion signal in exactly the direction the record cannot support.
      const quiet = reconcile({ recordedCostIds: [], recordedArtifactDigests: [] });
      const charged = reconcile({
        recordedCostIds: ["cost-a"],
        recordedArtifactDigests: [B],
      });

      expect(quiet).toContain("0 cost record(s), 0 artifact(s)");
      expect(charged).toContain("1 cost record(s), 1 artifact(s)");
      for (const out of [quiet, charged]) {
        expect(out).toContain("neither establishes whether the evaluation finished");
      }
    });

    it("carries the disclaimer through unaltered rather than summarising it", () => {
      const out = reconcile();

      expect(out).toContain("not a statement that the attempt is dead");
      expect(out).toContain("not a statement that a takeover is safe");
    });
  });

  it("says so when no policy is declared", () => {
    const out = renderRework({ runId: "run-a", loops: [] });

    expect(out).toContain("No rework policy is declared");
  });
});
