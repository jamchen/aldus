/**
 * Rework rounds derived from the record (#220 criterion 6, ADR-0055).
 *
 * The property under test is that a round is a **reading** rather than a second record. Everything
 * criterion 6 asks for is already durable — a repair is an ordinary attempt with input and output
 * artifacts, and the evaluation that opened it carries `blockingFindingClasses` and
 * `evaluationEvidence` since `next.40`. Storing rounds beside those would be a second place for the
 * same facts to disagree, and the disagreement surfaces when someone is already stuck.
 */

import { describe, expect, it } from "vitest";

import { SCHEMA_VERSION, type ReworkPolicy, type StageAttempt } from "@aldus-runtime/core";

import { deriveReworkRounds, type AttemptWithMetadata } from "../src/rework-rounds.js";

const ACTOR = { kind: "agent" as const, id: "agent-a" };

const policy: ReworkPolicy = {
  schemaVersion: SCHEMA_VERSION,
  policyId: "policy-a",
  stageId: "script.oracle",
  repairStageId: "script.revise",
  coversFindingClasses: ["comprehension"],
  maxRounds: 3,
  escalateToGateId: "script.freeze",
  authorizationId: "decision-a",
  automaticCorrectionHarm: "a wrong repair rewrites narration a host reads aloud",
};

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

const artifact = (sha: string) => ({ sha256: sha }) as never;

const evaluation = (
  attemptId: string,
  finishedAt: string,
  outputSha: string,
  meta: Omit<AttemptWithMetadata, "attempt"> = {},
): AttemptWithMetadata => ({
  attempt: attempt({
    attemptId,
    stageId: "script.oracle",
    finishedAt,
    outputArtifacts: [artifact(outputSha)],
  }),
  ...meta,
});

const repair = (
  attemptId: string,
  startedAt: string,
  inputSha: string,
  outputSha: string,
  over: Partial<StageAttempt> = {},
): AttemptWithMetadata => ({
  attempt: attempt({
    attemptId,
    stageId: "script.revise",
    startedAt,
    finishedAt: startedAt,
    inputArtifacts: [artifact(inputSha)],
    outputArtifacts: [artifact(outputSha)],
    ...over,
  }),
});

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);

describe("a round is one repair paired with the evaluation that opened it", () => {
  it("numbers rounds by position, so a resumed process derives the same ordinals", () => {
    // Criterion 4 as a property of the derivation rather than a claim about it: the ordinals come
    // from the records, so a process with no memory of the previous rounds computes the same ones.
    const rounds = deriveReworkRounds({
      runId: "run-a",
      policy,
      evaluationAttempts: [
        evaluation("eval-1", "2026-08-27T00:00:00.000Z", A, {
          blockingFindingClasses: ["comprehension"],
          enumeratedFindings: 4,
          defectCountMeasurable: true,
        }),
        evaluation("eval-2", "2026-08-27T00:02:00.000Z", B, {
          blockingFindingClasses: ["comprehension"],
          enumeratedFindings: 7,
          defectCountMeasurable: true,
        }),
      ],
      repairAttempts: [
        repair("rep-1", "2026-08-27T00:01:00.000Z", A, B),
        repair("rep-2", "2026-08-27T00:03:00.000Z", B, C),
      ],
    });

    expect(rounds.map((round) => round.roundIndex)).toEqual([1, 2]);
    expect(rounds.map((round) => round.inputDigest)).toEqual([A, B]);
    expect(rounds.map((round) => round.outputDigest)).toEqual([B, C]);
    // The counts the regression arm compares, taken from the evaluation that opened each round.
    expect(rounds.map((round) => round.inputFindingCount)).toEqual([4, 7]);
  });

  it("pairs each repair with the evaluation before it, not the one after", () => {
    // The pairing is what makes `consumedFindingClasses` true rather than plausible. Borrowing a
    // later evaluation would attribute a reading to a round that could not have read it.
    const rounds = deriveReworkRounds({
      runId: "run-a",
      policy,
      evaluationAttempts: [
        evaluation("eval-1", "2026-08-27T00:00:00.000Z", A, {
          blockingFindingClasses: ["comprehension"],
        }),
        evaluation("eval-2", "2026-08-27T00:02:00.000Z", B, {
          blockingFindingClasses: ["legal"],
        }),
      ],
      repairAttempts: [repair("rep-1", "2026-08-27T00:01:00.000Z", A, B)],
    });

    expect(rounds[0]?.consumedFindingClasses).toEqual(["comprehension"]);
  });

  it("does not count a repair that failed, because the bound is an authorised value", () => {
    // A failed repair consumed no finding and produced no candidate. Counting it would spend an
    // authorised round on work that never happened.
    const rounds = deriveReworkRounds({
      runId: "run-a",
      policy,
      evaluationAttempts: [evaluation("eval-1", "2026-08-27T00:00:00.000Z", A)],
      repairAttempts: [
        repair("rep-1", "2026-08-27T00:01:00.000Z", A, B, { status: "failed" }),
        repair("rep-2", "2026-08-27T00:03:00.000Z", A, C),
      ],
    });

    expect(rounds).toHaveLength(1);
    expect(rounds[0]?.repairAttemptId).toBe("rep-2");
  });

  it("omits a count that was never measurable rather than reporting zero", () => {
    // `defectCountMeasurable: false` means a defect count over this evidence is not a smaller
    // number, it is not a number (#140). Writing 0 would make the regression arm read an
    // unmeasured round as the best one.
    const rounds = deriveReworkRounds({
      runId: "run-a",
      policy,
      evaluationAttempts: [
        evaluation("eval-1", "2026-08-27T00:00:00.000Z", A, {
          enumeratedFindings: 3,
          defectCountMeasurable: false,
        }),
      ],
      repairAttempts: [repair("rep-1", "2026-08-27T00:01:00.000Z", A, B)],
    });

    expect(rounds[0]?.inputFindingCount).toBeUndefined();
  });

  it("carries no findings for a repair nobody evaluated first", () => {
    // A repair run by hand with no evaluation before it. Borrowing the nearest evaluation would
    // report findings the round could not have consumed.
    const rounds = deriveReworkRounds({
      runId: "run-a",
      policy,
      evaluationAttempts: [
        evaluation("eval-1", "2026-08-27T09:00:00.000Z", A, {
          blockingFindingClasses: ["comprehension"],
        }),
      ],
      repairAttempts: [repair("rep-1", "2026-08-27T00:01:00.000Z", A, B)],
    });

    expect(rounds[0]?.consumedFindingClasses).toEqual([]);
  });

  it("skips a repair whose digests cannot be established rather than guessing one", () => {
    const rounds = deriveReworkRounds({
      runId: "run-a",
      policy,
      evaluationAttempts: [],
      repairAttempts: [
        {
          attempt: attempt({
            attemptId: "rep-1",
            stageId: "script.revise",
            startedAt: "2026-08-27T00:01:00.000Z",
            outputArtifacts: [artifact(B)],
          }),
        },
      ],
    });

    expect(rounds).toEqual([]);
  });
});
