/**
 * Take lineage (architecture contract §15 "fallback or regeneration lineage", §12.4).
 *
 * A take supersedes at most one earlier take, so lineage is a chain rather than a graph. That is a
 * deliberate restriction: a graph would allow two takes to claim the same predecessor, and then
 * "what replaced this?" has two answers and neither is wrong. A chain has one.
 *
 * Nothing here deletes or rewrites. §15.1 requires rejected paid takes to be retained with unique
 * identity, so the chain is the whole history of a segment — every attempt, why each was made, and
 * what a human said about it. That history is the input to §15.1's repair strategies and to
 * WP-10's defect corpus, and pruning it to "the one that worked" would throw away the evidence
 * that made the working one findable.
 */

import { TtsLedgerErrorCodes, ttsLedgerError } from "./errors.js";
import { isAccepted, isRejected, type RepairRung, type TakeRecord } from "./take.js";

/** One segment's takes, oldest first, with the repairs that connect them. */
export interface SegmentLineage {
  segmentId: string;
  /** Every take for the segment, oldest first. */
  takes: TakeRecord[];
  /** The accepted take, if a human has accepted one (contract §13.3). */
  accepted?: TakeRecord;
  /** Takes a human rejected. Retained forever (contract §15.1). */
  rejected: TakeRecord[];
  /** Takes nobody has judged yet. */
  undecided: TakeRecord[];
  /** The repair rungs used across the chain, in the order they were taken (contract §12.4). */
  repairPath: RepairRung[];
}

/**
 * Build the lineage for every segment in a set of takes.
 *
 * Ordering follows the `supersedes` chain rather than `recordedAt`, because a timestamp says when
 * a record was written and the chain says what replaced what — and after a crash or an
 * out-of-order write those can disagree. Takes with no predecessor start a chain; anything left
 * over after the chains are walked is appended in `attempt` order so nothing is silently dropped.
 *
 * @throws {AldusError} `ALDUS_TTS_LINEAGE_CYCLE` if the chain loops, which correct data cannot do.
 */
export function buildLineage(takes: readonly TakeRecord[]): Map<string, SegmentLineage> {
  const bySegment = new Map<string, TakeRecord[]>();
  for (const take of takes) {
    const bucket = bySegment.get(take.segmentId);
    if (bucket === undefined) bySegment.set(take.segmentId, [take]);
    else bucket.push(take);
  }

  const lineages = new Map<string, SegmentLineage>();
  for (const [segmentId, segmentTakes] of bySegment) {
    const ordered = orderChain(segmentId, segmentTakes);
    const accepted = ordered.find(isAccepted);
    lineages.set(segmentId, {
      segmentId,
      takes: ordered,
      ...(accepted === undefined ? {} : { accepted }),
      rejected: ordered.filter(isRejected),
      undecided: ordered.filter((take) => take.decision === undefined),
      repairPath: ordered.flatMap((take) => (take.repair === undefined ? [] : [take.repair.rung])),
    });
  }
  return lineages;
}

/** Order one segment's takes oldest-first by following `supersedes`. */
function orderChain(segmentId: string, takes: readonly TakeRecord[]): TakeRecord[] {
  const byId = new Map(takes.map((take) => [take.takeId, take]));
  const supersededIds = new Set(
    takes.flatMap((take) => (take.supersedes === undefined ? [] : [take.supersedes])),
  );

  // A chain head is a take nothing supersedes: the newest. Walking backwards from there and
  // reversing gives oldest-first without trusting any timestamp.
  //
  // Every take must be walked from *some* start, not only from a head. A closed cycle has no
  // head at all — in `a supersedes b, b supersedes a` both are superseded — so walking heads
  // alone would leave the cycle undiscovered and fall through to the orphan branch, silently
  // returning corrupt lineage as if it were fine. Walking the leftovers as starts too is what
  // makes the detection total.
  const heads = takes.filter((take) => !supersededIds.has(take.takeId));
  const ordered: TakeRecord[] = [];
  const placed = new Set<string>();

  const walkFrom = (start: TakeRecord): void => {
    const chain: TakeRecord[] = [];
    const seen = new Set<string>();
    let current: TakeRecord | undefined = start;
    while (current !== undefined) {
      if (seen.has(current.takeId)) {
        throw ttsLedgerError(
          TtsLedgerErrorCodes.LINEAGE_CYCLE,
          `Take lineage for segment "${segmentId}" loops at "${current.takeId}". A take supersedes ` +
            "an earlier take, so the chain is strictly backwards in time and cannot close.",
          {
            category: "conflict",
            retryable: false,
            details: { segmentId, takeId: current.takeId },
          },
        );
      }
      seen.add(current.takeId);
      chain.push(current);
      current = current.supersedes === undefined ? undefined : byId.get(current.supersedes);
    }
    chain.reverse();
    for (const take of chain) {
      if (placed.has(take.takeId)) continue;
      placed.add(take.takeId);
      ordered.push(take);
    }
  };

  for (const head of heads) walkFrom(head);

  // Anything not reachable from a head is either a partially written chain or a cycle. Walking
  // it resolves which: a cycle throws above, and a genuine orphan is appended rather than
  // dropped, because losing a paid take to a bookkeeping gap would violate §15.1.
  for (const take of [...takes].sort((a, b) => a.attempt - b.attempt)) {
    if (placed.has(take.takeId)) continue;
    walkFrom(take);
  }

  return ordered;
}

/** The accepted take for a segment, if one exists (contract §13.3). */
export function acceptedTakeFor(
  takes: readonly TakeRecord[],
  segmentId: string,
): TakeRecord | undefined {
  return takes.find((take) => take.segmentId === segmentId && isAccepted(take));
}

/**
 * Segments that have no accepted take yet.
 *
 * What an operator needs to know before a run can move past the Human Ear gate (§13.3) — and what
 * `aldus status` (§18, §24) would surface as the next thing needing a person.
 */
export function segmentsAwaitingAcceptance(
  takes: readonly TakeRecord[],
  segmentIds: readonly string[],
): string[] {
  return segmentIds.filter((segmentId) => acceptedTakeFor(takes, segmentId) === undefined);
}
