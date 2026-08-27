/**
 * Rework rounds derived from the record (#220 provenance foundation, ADR-0055/0056).
 *
 * Two properties under test, and the second was got wrong first.
 *
 * A round is a **reading** rather than a second record — everything it needs is already durable.
 * And a reading that cannot be established is **refused visibly**, never inferred: the first
 * version joined by `inputArtifacts.at(-1)` and by which evaluation finished most recently, and
 * neither is lineage. The contract gives array order no meaning, a stage may consume and produce
 * several artifacts, and the most recent evaluation may have judged a different candidate.
 */

import { describe, expect, it } from "vitest";

import {
  SCHEMA_VERSION,
  type ArtifactRef,
  type ReworkPolicy,
  type StageAttempt,
} from "@aldus-runtime/core";

import { deriveReworkRounds, type AttemptWithMetadata } from "../src/rework-rounds.js";

const ACTOR = { kind: "agent" as const, id: "agent-a" };
const CANDIDATE = "script-candidate";
const REPORT = "oracle-report";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);

const policy = (over: Partial<ReworkPolicy> = {}): ReworkPolicy => ({
  schemaVersion: SCHEMA_VERSION,
  policyId: "policy-a",
  stageId: "script.oracle",
  repairStageId: "script.revise",
  coversFindingClasses: ["unresolved_reference", "time_anchor_missing"],
  maxRounds: 3,
  escalateToGateId: "script.freeze",
  candidateArtifactKind: CANDIDATE,
  authorizationId: "decision-a",
  automaticCorrectionHarm: "a wrong repair rewrites narration a host reads aloud",
  ...over,
});

const art = (kind: string, sha: string): ArtifactRef => ({ kind, sha256: sha }) as never;

function attempt(over: Partial<StageAttempt> & { attemptId: string }): StageAttempt {
  return {
    schemaVersion: SCHEMA_VERSION,
    stageId: "stage",
    attempt: 1,
    status: "succeeded",
    actor: ACTOR,
    inputArtifacts: [],
    outputArtifacts: [],
    expectedArtifacts: [],
    ...over,
  } as unknown as StageAttempt;
}

/** An evaluation judges its input candidate and emits a report. */
const evaluation = (
  attemptId: string,
  judged: string,
  meta: Omit<AttemptWithMetadata, "attempt"> = {},
  over: Partial<StageAttempt> = {},
): AttemptWithMetadata => ({
  attempt: attempt({
    attemptId,
    stageId: "script.oracle",
    inputArtifacts: [art(CANDIDATE, judged)],
    outputArtifacts: [art(REPORT, `report-${attemptId}`.padEnd(64, "0"))],
    ...over,
  }),
  ...meta,
});

const repair = (
  attemptId: string,
  consumed: string,
  produced: string,
  over: Partial<StageAttempt> = {},
): AttemptWithMetadata => ({
  attempt: attempt({
    attemptId,
    stageId: "script.revise",
    inputArtifacts: [art(CANDIDATE, consumed)],
    outputArtifacts: [art(CANDIDATE, produced)],
    ...over,
  }),
});

describe("an advisory finding a policy covers is recorded as consumed", () => {
  // The first adopter's real shape, and the case ADR-0056 exists for: eight advisory channels, no
  // blocking ones, because §12.1 permits a blocking channel only after calibration and none has
  // promotion evidence. Deriving from `blockingFindingClasses` records `[]` for a repair that
  // consumed four findings — not conservative absence, a false statement.
  it("records the covered classes when nothing was blocking", () => {
    const reading = deriveReworkRounds({
      runId: "run-a",
      policy: policy(),
      evaluationAttempts: [
        evaluation("eval-1", A, {
          observedFindingClasses: ["unresolved_reference", "time_anchor_missing", "cut_candidate"],
          blockingFindingClasses: [],
          enumeratedFindings: 4,
          defectCountMeasurable: true,
        }),
      ],
      repairAttempts: [repair("rep-1", A, B)],
    });

    expect(reading.refused).toEqual([]);
    // Covered classes only. `cut_candidate` was observed and the policy does not cover it, so the
    // repair was not authorised to act on it and the round must not say it did.
    expect(reading.rounds[0]?.consumedFindingClasses).toEqual([
      "unresolved_reference",
      "time_anchor_missing",
    ]);
    expect(reading.rounds[0]?.inputFindingCount).toBe(4);
  });

  it("refuses rather than reporting an empty consumed set it cannot establish", () => {
    // An attempt from before observations were persisted. `[]` here would state that the repair
    // consumed nothing, which is the failure this whole rule is about.
    const reading = deriveReworkRounds({
      runId: "run-a",
      policy: policy(),
      evaluationAttempts: [evaluation("eval-1", A, { blockingFindingClasses: [] })],
      repairAttempts: [repair("rep-1", A, B)],
    });

    expect(reading.rounds).toEqual([]);
    expect(reading.refused[0]?.reason).toBe("consumed_classes_unrecorded");
  });
});

describe("the join is by artifact identity, not by array position or recency", () => {
  it("is invariant to the order of a multi-artifact attempt", () => {
    // The adversarial case. Under `.at(-1)` these two orderings produce different rounds — or a
    // round about the evaluator's report rather than the candidate it judged.
    const forwards = deriveReworkRounds({
      runId: "run-a",
      policy: policy(),
      evaluationAttempts: [
        evaluation("eval-1", A, { observedFindingClasses: ["unresolved_reference"] }),
      ],
      repairAttempts: [
        repair("rep-1", A, B, {
          inputArtifacts: [art(CANDIDATE, A), art(REPORT, C)],
          outputArtifacts: [art(CANDIDATE, B), art("notes", C)],
        }),
      ],
    });
    const backwards = deriveReworkRounds({
      runId: "run-a",
      policy: policy(),
      evaluationAttempts: [
        evaluation("eval-1", A, { observedFindingClasses: ["unresolved_reference"] }),
      ],
      repairAttempts: [
        repair("rep-1", A, B, {
          inputArtifacts: [art(REPORT, C), art(CANDIDATE, A)],
          outputArtifacts: [art("notes", C), art(CANDIDATE, B)],
        }),
      ],
    });

    expect(forwards.rounds).toEqual(backwards.rounds);
    expect(forwards.rounds[0]?.inputDigest).toBe(A);
    expect(forwards.rounds[0]?.outputDigest).toBe(B);
  });

  it("chooses the evaluation that judged the consumed candidate, not the most recent one", () => {
    // Two evaluations before one repair, and only one of them judged what the repair consumed.
    // Recency picks the wrong one and attributes its findings to a round that never read them.
    const reading = deriveReworkRounds({
      runId: "run-a",
      policy: policy(),
      evaluationAttempts: [
        evaluation("eval-judged-A", A, { observedFindingClasses: ["unresolved_reference"] }),
        evaluation("eval-judged-C", C, { observedFindingClasses: ["time_anchor_missing"] }),
      ],
      repairAttempts: [repair("rep-1", A, B)],
    });

    expect(reading.rounds[0]?.consumedFindingClasses).toEqual(["unresolved_reference"]);
  });

  it("refuses when no completed evaluation judged the consumed candidate", () => {
    const reading = deriveReworkRounds({
      runId: "run-a",
      policy: policy(),
      evaluationAttempts: [
        evaluation("eval-1", C, { observedFindingClasses: ["unresolved_reference"] }),
      ],
      repairAttempts: [repair("rep-1", A, B)],
    });

    expect(reading.rounds).toEqual([]);
    expect(reading.refused[0]?.reason).toBe("no_evaluation_judged_this_candidate");
  });

  it("does not read a running or failed evaluation as having judged anything", () => {
    // An attempt that has not finished has not judged. Reading one as the verdict is the shape
    // `not_evaluated` exists to keep out, one layer down.
    const reading = deriveReworkRounds({
      runId: "run-a",
      policy: policy(),
      evaluationAttempts: [
        evaluation(
          "eval-1",
          A,
          { observedFindingClasses: ["unresolved_reference"] },
          { status: "running" },
        ),
      ],
      repairAttempts: [repair("rep-1", A, B)],
    });

    expect(reading.refused[0]?.reason).toBe("no_evaluation_judged_this_candidate");
  });

  it("refuses a repair whose candidate is ambiguous on either side", () => {
    const two = deriveReworkRounds({
      runId: "run-a",
      policy: policy(),
      evaluationAttempts: [
        evaluation("eval-1", A, { observedFindingClasses: ["unresolved_reference"] }),
      ],
      repairAttempts: [
        repair("rep-1", A, B, { inputArtifacts: [art(CANDIDATE, A), art(CANDIDATE, C)] }),
      ],
    });
    expect(two.refused[0]?.reason).toBe("candidate_input_ambiguous");

    const none = deriveReworkRounds({
      runId: "run-a",
      policy: policy(),
      evaluationAttempts: [
        evaluation("eval-1", A, { observedFindingClasses: ["unresolved_reference"] }),
      ],
      repairAttempts: [repair("rep-1", A, B, { outputArtifacts: [art(REPORT, C)] })],
    });
    expect(none.refused[0]?.reason).toBe("candidate_output_ambiguous");
  });
});

describe("what the reading refuses stays visible", () => {
  it("reports a failed repair as refused rather than dropping it", () => {
    // A repair silently absent from the round list reads as a repair that never ran, which
    // understates what was spent — and a reader comparing that against a bound concludes there is
    // room left.
    const reading = deriveReworkRounds({
      runId: "run-a",
      policy: policy(),
      evaluationAttempts: [
        evaluation("eval-1", A, { observedFindingClasses: ["unresolved_reference"] }),
      ],
      repairAttempts: [repair("rep-1", A, B, { status: "failed" }), repair("rep-2", A, C)],
    });

    expect(reading.refused.map((entry) => entry.reason)).toEqual(["repair_unsuccessful"]);
    expect(reading.rounds).toHaveLength(1);
    expect(reading.rounds[0]?.roundIndex).toBe(1);
  });

  it("omits a count that was never measurable rather than reporting zero", () => {
    const reading = deriveReworkRounds({
      runId: "run-a",
      policy: policy(),
      evaluationAttempts: [
        evaluation("eval-1", A, {
          observedFindingClasses: ["unresolved_reference"],
          enumeratedFindings: 3,
          defectCountMeasurable: false,
        }),
      ],
      repairAttempts: [repair("rep-1", A, B)],
    });

    expect(reading.rounds[0]?.inputFindingCount).toBeUndefined();
  });
});
