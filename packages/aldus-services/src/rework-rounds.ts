/**
 * Rework rounds, derived from the record rather than stored beside it (#220, ADR-0055).
 *
 * A round's facts are already durable: a repair is an ordinary stage attempt with input and output
 * artifacts, and the evaluation that opened it carries its observations and enforcement
 * classification since `next.40`. So a round is a **reading** of two existing records, not a third
 * one — the choice this codebase makes elsewhere for the same reason (`#pendingObservations`
 * derives rather than stores "so the two cannot drift").
 *
 * **What it will not do is infer a round it cannot establish.** The first version of this joined by
 * `inputArtifacts.at(-1)` and by which evaluation finished most recently before the repair started.
 * Neither is lineage: the contract gives array order no meaning, a stage may consume and produce
 * several artifacts, and the most recent evaluation may have judged a different candidate than the
 * one the repair consumed. A stored temporal ordering can narrow candidates; it cannot prove what
 * was read.
 *
 * So the joins are explicit — the policy declares the candidate's artifact kind, and the evaluation
 * that opened a round is the one that *judged that candidate*, matched by digest. A repair whose
 * joins cannot be established is **refused, visibly**, and never reported as a round with an
 * inferred one.
 */

import type { ArtifactRef, ReworkPolicy, ReworkRound, StageAttempt } from "@aldus-runtime/core";
import { SCHEMA_VERSION } from "@aldus-runtime/core";

/** What a derivation reads: the two stages the policy names, as the record holds them. */
export interface ReworkRoundSource {
  runId: string;
  policy: ReworkPolicy;
  /** Attempts of the evaluating stage (`policy.stageId`), in record order. */
  evaluationAttempts: readonly AttemptWithMetadata[];
  /** Attempts of the repair stage (`policy.repairStageId`), in record order. */
  repairAttempts: readonly AttemptWithMetadata[];
}

/** One attempt and the per-attempt metadata the stage runner keeps beside it. */
export interface AttemptWithMetadata {
  attempt: StageAttempt;
  /**
   * Finding classes the evaluator **emitted**, from `AttemptMetadata.observations`.
   *
   * Separate from {@link blockingFindingClasses} and load-bearing, because ADR-0056 permits a
   * reviewed policy to cover an *advisory* class. The first adopter's oracle declares eight
   * advisory channels and no blocking ones, so a round derived from blocking classes alone records
   * `consumedFindingClasses: []` for a repair that consumed four findings — not conservative
   * absence, a false statement.
   */
  observedFindingClasses?: readonly string[] | undefined;
  /** Classes the stage's declared enforcement classified as blocking. Enforcement provenance. */
  blockingFindingClasses?: readonly string[] | undefined;
  enumeratedFindings?: number | undefined;
  defectCountMeasurable?: boolean | undefined;
}

/** Why a repair attempt could not be read as a round. */
export type ReworkJoinRefusal =
  | "repair_unsuccessful"
  | "candidate_input_ambiguous"
  | "candidate_output_ambiguous"
  | "no_evaluation_judged_this_candidate"
  | "consumed_classes_unrecorded";

/** A repair the record could not establish as a round, and what was missing. */
export interface RefusedRound {
  repairAttemptId: string;
  reason: ReworkJoinRefusal;
  explanation: string;
}

/** Rounds the record establishes, and repairs it refuses to call rounds. */
export interface ReworkRoundReading {
  rounds: ReworkRound[];
  /**
   * Repairs that happened and could not be joined.
   *
   * Surfaced rather than dropped. A repair silently absent from the round list reads as a repair
   * that never ran, which understates what was spent — and a reader comparing a bound against a
   * shorter list would conclude there is room left.
   */
  refused: RefusedRound[];
}

/**
 * Read the rework rounds one policy's records establish.
 *
 * A **round** is a successful repair that consumed a candidate some evaluation judged. Every part
 * of that is joined explicitly:
 *
 * - the candidate is the artifact of `policy.candidateArtifactKind` — exactly one on the way in and
 *   exactly one on the way out, or the repair is refused rather than disambiguated by position;
 * - the evaluation that opened the round is the one whose **inputs** include that same digest,
 *   because an evaluator judges its input and emits a report as its output;
 * - `consumedFindingClasses` is that evaluation's observed classes intersected with what the policy
 *   covers, so an advisory class a reviewed policy covers is recorded as consumed (ADR-0056).
 *
 * Ordinals are positions among established rounds, so a process with no memory of the previous ones
 * derives the same numbers from the same records.
 */
export function deriveReworkRounds(source: ReworkRoundSource): ReworkRoundReading {
  const { policy, runId } = source;
  const rounds: ReworkRound[] = [];
  const refused: RefusedRound[] = [];

  for (const repair of source.repairAttempts) {
    const refuse = (reason: ReworkJoinRefusal, explanation: string): void => {
      refused.push({ repairAttemptId: repair.attempt.attemptId, reason, explanation });
    };

    // A repair that failed or was cancelled consumed no finding and produced no candidate. Counting
    // it would spend an authorised round on work that never happened, and the bound is an
    // authorised value.
    if (repair.attempt.status !== "succeeded") {
      refuse(
        "repair_unsuccessful",
        `attempt is "${repair.attempt.status}", not a completed repair`,
      );
      continue;
    }

    const consumed = onlyOfKind(repair.attempt.inputArtifacts, policy.candidateArtifactKind);
    if (consumed === undefined) {
      refuse(
        "candidate_input_ambiguous",
        `did not consume exactly one "${policy.candidateArtifactKind}" artifact, so which ` +
          "candidate it repaired is not established",
      );
      continue;
    }

    const produced = onlyOfKind(repair.attempt.outputArtifacts, policy.candidateArtifactKind);
    if (produced === undefined) {
      refuse(
        "candidate_output_ambiguous",
        `did not produce exactly one "${policy.candidateArtifactKind}" artifact, so which ` +
          "candidate it produced is not established",
      );
      continue;
    }

    // The evaluation that judged **this** candidate, by digest. Not the most recent one: a repair
    // run between two evaluations, or an evaluation of a different candidate, would otherwise
    // attribute a reading to a round that could not have read it.
    const opened = judgedBy(
      source.evaluationAttempts,
      consumed.sha256,
      policy.candidateArtifactKind,
    );
    if (opened === undefined) {
      refuse(
        "no_evaluation_judged_this_candidate",
        `no completed evaluation of "${policy.stageId}" judged the candidate this repair consumed`,
      );
      continue;
    }

    // Unknown is not an empty list. An attempt recorded before observations were persisted cannot
    // establish what the round consumed, and reporting `[]` would state that it consumed nothing.
    if (opened.observedFindingClasses === undefined) {
      refuse(
        "consumed_classes_unrecorded",
        `the evaluation that opened this round predates recorded observations, so what the repair ` +
          "consumed cannot be established",
      );
      continue;
    }

    const covers = new Set(policy.coversFindingClasses);
    const measurable = opened.defectCountMeasurable === true;
    rounds.push({
      schemaVersion: SCHEMA_VERSION,
      policyId: policy.policyId,
      runId,
      roundIndex: rounds.length + 1,
      inputDigest: consumed.sha256,
      consumedFindingClasses: opened.observedFindingClasses.filter((cls) => covers.has(cls)),
      repairStageId: policy.repairStageId,
      repairAttemptId: repair.attempt.attemptId,
      outputDigest: produced.sha256,
      costIds: [],
      actor: repair.attempt.actor,
      at: repair.attempt.finishedAt ?? repair.attempt.startedAt ?? "",
      ...(measurable && opened.enumeratedFindings !== undefined
        ? { inputFindingCount: opened.enumeratedFindings }
        : {}),
    });
  }

  return { rounds, refused };
}

/**
 * The one artifact of a kind, or `undefined` when there is not exactly one.
 *
 * Zero and several are the same answer here: neither establishes which artifact is meant, and
 * picking one would be `.at(-1)` with extra steps.
 */
export function onlyOfKind(
  artifacts: readonly ArtifactRef[],
  kind: string,
): ArtifactRef | undefined {
  const matching = artifacts.filter((artifact) => artifact.kind === kind);
  return matching.length === 1 ? matching[0] : undefined;
}

/**
 * The completed evaluation attempt that judged the candidate with this digest.
 *
 * An evaluator judges its **input** and emits its report as output, so the subject is matched
 * against `inputArtifacts`. Running and failed attempts are excluded: an attempt that has not
 * finished has not judged anything, and reading one as a verdict is the shape `not_evaluated`
 * exists to keep out.
 */
export function judgedBy(
  attempts: readonly AttemptWithMetadata[],
  digest: string,
  kind: string,
): AttemptWithMetadata | undefined {
  return attempts.find(
    (entry) =>
      entry.attempt.status === "succeeded" &&
      entry.attempt.inputArtifacts.some(
        (artifact) => artifact.kind === kind && artifact.sha256 === digest,
      ),
  );
}
