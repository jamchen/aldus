/**
 * Rework rounds, derived from the record rather than stored beside it (#220, ADR-0055).
 *
 * Criterion 6 wants each round to carry the digests it read, the findings consumed, the repair
 * execution, the output and the cost. **Every one of those is already durable**: a repair is an
 * ordinary stage attempt with input and output artifacts, and the evaluation that opened the round
 * is an attempt carrying `blockingFindingClasses` and `evaluationEvidence` since `next.40`.
 *
 * So a round is not a new record. It is a **reading** of two existing ones, and deriving it is the
 * choice this codebase makes elsewhere for the same reason — `#pendingObservations` derives rather
 * than stores "so the two cannot drift". A second record of the same facts is a second place for
 * them to disagree, and the disagreement surfaces when someone is already stuck.
 *
 * It also avoids inventing a durable Core type for something the contract does not yet name. Adding
 * `ReworkRound` to the run-collection registry would make it a stored domain type on the strength
 * of a work package rather than the contract, and that is a decision for the contract to make.
 */

import type { ReworkPolicy, ReworkRound, StageAttempt } from "@aldus-runtime/core";
import { SCHEMA_VERSION } from "@aldus-runtime/core";

/** What a derivation reads: the two stages the policy names, as the record holds them. */
export interface ReworkRoundSource {
  runId: string;
  policy: ReworkPolicy;
  /** Attempts of the evaluating stage (`policy.stageId`), oldest first. */
  evaluationAttempts: readonly AttemptWithMetadata[];
  /** Attempts of the repair stage (`policy.repairStageId`), oldest first. */
  repairAttempts: readonly AttemptWithMetadata[];
}

/** One attempt and the per-attempt metadata the stage runner keeps beside it. */
export interface AttemptWithMetadata {
  attempt: StageAttempt;
  /**
   * From `AttemptMetadata`, and only the fields a round reads.
   *
   * Optional throughout, because an attempt recorded before `next.40` has none of them. Absence is
   * carried into the round as absence rather than as a zero — a count that was never measured is
   * not a small one (#140).
   */
  blockingFindingClasses?: readonly string[] | undefined;
  enumeratedFindings?: number | undefined;
  defectCountMeasurable?: boolean | undefined;
}

/**
 * Read the completed rework rounds for one policy.
 *
 * A **round** is one repair attempt that produced an artifact, paired with the evaluation that
 * opened it — the latest evaluation attempt that finished before the repair started. Pairing by
 * time rather than by an identifier, because nothing links them today and inventing a link would
 * be storing the thing this function exists not to store.
 *
 * Rounds are numbered by position, so a resumed process derives the same ordinals from the same
 * records. That is criterion 4 as a property of the derivation rather than a claim about it.
 */
export function deriveReworkRounds(source: ReworkRoundSource): ReworkRound[] {
  const { policy, runId } = source;

  // Only repairs that finished and produced something. A repair that failed or was cancelled did
  // not consume a finding and did not produce the next candidate, so counting it would spend a
  // bound on work that never happened — and the bound is an authorised value.
  const repairs = source.repairAttempts.filter(
    (entry) => entry.attempt.status === "succeeded" && entry.attempt.outputArtifacts.length > 0,
  );

  const rounds: ReworkRound[] = [];
  for (const [index, repair] of repairs.entries()) {
    const opened = latestBefore(source.evaluationAttempts, repair.attempt.startedAt);
    const inputDigest =
      repair.attempt.inputArtifacts.at(-1)?.sha256 ??
      opened?.attempt.outputArtifacts.at(-1)?.sha256;
    const outputDigest = repair.attempt.outputArtifacts.at(-1)?.sha256;
    // A repair whose input digest cannot be established is not reported as a round with a guessed
    // one. It is skipped, and the skip is visible as a gap in the ordinals rather than as a round
    // that reads as complete — the same reason an unmeasured count stays absent.
    if (inputDigest === undefined || outputDigest === undefined) continue;

    const measurable = opened?.defectCountMeasurable === true;
    rounds.push({
      schemaVersion: SCHEMA_VERSION,
      policyId: policy.policyId,
      runId,
      roundIndex: index + 1,
      inputDigest,
      consumedFindingClasses: [...(opened?.blockingFindingClasses ?? [])],
      repairStageId: policy.repairStageId,
      repairAttemptId: repair.attempt.attemptId,
      outputDigest,
      costIds: [],
      actor: repair.attempt.actor,
      at: repair.attempt.finishedAt ?? repair.attempt.startedAt ?? "",
      ...(measurable && opened?.enumeratedFindings !== undefined
        ? { inputFindingCount: opened.enumeratedFindings }
        : {}),
    });
  }
  return rounds;
}

/**
 * The latest attempt that finished before `at`.
 *
 * `undefined` when nothing did — a repair with no evaluation before it is a repair somebody ran by
 * hand, and the round it produced carries no findings consumed rather than borrowing a later
 * evaluation's. Borrowing would attribute a reading to a round that could not have read it.
 */
function latestBefore(
  attempts: readonly AttemptWithMetadata[],
  at: string | undefined,
): AttemptWithMetadata | undefined {
  if (at === undefined) return undefined;
  let best: AttemptWithMetadata | undefined;
  for (const entry of attempts) {
    const finished = entry.attempt.finishedAt;
    if (finished === undefined || finished > at) continue;
    if (best === undefined || finished > (best.attempt.finishedAt ?? "")) best = entry;
  }
  return best;
}
