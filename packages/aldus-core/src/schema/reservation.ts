/**
 * Authorization reserved before a paid effect, and settled from what the provider reported
 * (contract §13.2, §19.3; ADR-0044, #155).
 *
 * Aldus could authorize estimated spend and record a charge afterwards, with nothing in between.
 * Three failures lived in that gap: two executions reading the same headroom and both dispatching;
 * a provider charging without saying how much; and a write failing after the money moved. A
 * reservation is the durable statement that authorization is committed to an effect **before** the
 * effect happens.
 */

import { z } from "zod";

import { iso8601, moneySchema, nonEmptyString, schemaVersionString } from "./common.js";

/** Lifecycle of one reservation (ADR-0044). */
export const SPEND_RESERVATION_STATUSES = [
  /** Authorization is committed to an effect that has not settled. Consumes availability. */
  "reserved",
  /** The charge is known and recorded. Consumes nothing further. */
  "settled",
  /** No charge occurred — a free or voided outcome. Consumes nothing further. */
  "released",
  /**
   * The provider charged and did not say how much.
   *
   * Still consumes its full reserved amount: an unknown charge is neither free nor zero, and
   * releasing it would restore authorization for money that may already be gone (§19.3, #150).
   */
  "billing_unknown",
] as const;

/** @see SPEND_RESERVATION_STATUSES */
export type SpendReservationStatus = (typeof SPEND_RESERVATION_STATUSES)[number];

/**
 * What was true of the execution this reservation covers, at the moment it was dispatched
 * (ADR-0044).
 *
 * Persisted rather than re-derived. A backend that declares it enforces a ceiling **today** says
 * nothing about a request dispatched by an earlier version, or about one the Runtime never handed
 * a ceiling to — and inferring the second from the first is ADR-0030's defect in its purest form:
 * claiming a protection from a declaration that was not the one in force.
 */
export const executionCeilingEvidenceSchema = z
  .object({
    /** Which backend or adapter performed the execution. Opaque to Core (§4.2). */
    backendId: nonEmptyString,
    /**
     * Which version of it.
     *
     * Recorded because the capability that matters is the one that version declared, and a
     * capability check re-run later reads a different program.
     */
    backendVersion: nonEmptyString,
    /**
     * Whether the Runtime actually supplied a ceiling **and** the backend enforced it.
     *
     * Both halves. A ceiling passed to a backend that ignores it is a protection that does not
     * exist, and a backend that would have enforced one it was never given is no different.
     */
    ceilingEnforced: z.boolean(),
    /** The ceiling actually applied, where one was. */
    appliedCeiling: moneySchema.optional(),
  })
  .meta({
    id: "ExecutionCeilingEvidence",
    title: "ExecutionCeilingEvidence",
    description:
      "What was true of a paid execution when it was dispatched (architecture contract §19.3). " +
      "Persisted rather than re-derived: a backend's current capabilities are not evidence about " +
      "an earlier request.",
  });

/** @see executionCeilingEvidenceSchema */
export type ExecutionCeilingEvidence = z.infer<typeof executionCeilingEvidenceSchema>;

/**
 * One reservation of authorization against one independently billed effect (ADR-0044).
 *
 * **Per effect, not per attempt.** ADR-0043 established that an effect key belongs to the
 * independently deduplicated effect; a reservation follows the same cardinality, because an attempt
 * performing N billed operations commits authorization N times. Reusing one reservation across
 * several effects is the same defect one field over.
 */
export const spendReservationSchema = z
  .object({
    /** Schema version of this record (ADR-0003). */
    schemaVersion: schemaVersionString,
    /** Identity of this reservation. */
    reservationId: nonEmptyString,
    /**
     * The budget pool whose headroom this consumes (contract §19.3).
     *
     * **The contended resource, and therefore the lease and partition key.** Two reservations
     * against one grant compete for the same headroom; two against different grants do not, even
     * when one human decision authorized both.
     *
     * Distinct from {@link authorizationId} on purpose. Treating the decision as the ledger
     * partition would make one `GateDecision` mean one budget pool — an implementation shortcut
     * hardened into a workflow restriction, and the mechanism by which an unresolved agent charge
     * would quietly reduce what synthesis may spend.
     */
    grantId: nonEmptyString,
    /**
     * The `GateDecision` that authorized the terms (contract §13.2).
     *
     * Provenance, not partition: it answers *who permitted this*, and `CostRecord.authorizationId`
     * carries the same value. It is deliberately **not** what availability is derived per.
     */
    authorizationId: nonEmptyString,
    /**
     * What this reservation is for, e.g. `"agent.execute"` (§4.2).
     *
     * Checked against the grant's declared scope before reserving, so passing the wrong grant to
     * an execution gateway cannot authorize an unrelated operation. An open string — Core names no
     * operations.
     */
    operation: nonEmptyString,
    /** Run this reservation belongs to (contract §6.2). */
    runId: nonEmptyString,
    /** Stage that will incur the cost. */
    stageId: nonEmptyString,
    /** Attempt that will incur it. */
    attemptId: nonEmptyString,
    /**
     * Identity of the independently billed effect (ADR-0043).
     *
     * Retrying the same effect resolves to the same reservation rather than reserving twice, which
     * is what makes the reserve operation idempotent.
     */
    effectKey: nonEmptyString,
    /**
     * How much authorization this commits, in the **grant's** currency.
     *
     * Not the provider's billing currency. A reservation states what Aldus set aside; what the
     * provider charges, and in what currency, is a separate fact that may not exist yet (ADR-0044).
     */
    reserved: moneySchema,
    /** @see SPEND_RESERVATION_STATUSES */
    status: z.enum(SPEND_RESERVATION_STATUSES),
    /** Cost records that settled this reservation. The other half of `CostRecord.reservationId`. */
    costIds: z.array(nonEmptyString).max(1024),
    /**
     * Provider-side request identity, captured at dispatch (contract §15; #152).
     *
     * Recorded here rather than only on a cost record, because the case this exists for is the one
     * where the cost record was never written. Reconciliation needs something to ask the provider
     * about.
     */
    providerRequestId: nonEmptyString.optional(),
    /** What was true of the execution when it was dispatched. Absent until dispatch. */
    execution: executionCeilingEvidenceSchema.optional(),
    /** When the reservation was created — before the effect, always. */
    createdAt: iso8601,
    /** When it reached a terminal status. */
    settledAt: iso8601.optional(),
  })
  .refine(
    (reservation) => reservation.status === "reserved" || reservation.settledAt !== undefined,
    {
      message:
        "a reservation that is no longer `reserved` must record when it settled (architecture " +
        "contract §20: production trace answers when authorization stopped being committed).",
      path: ["settledAt"],
    },
  )
  .meta({
    id: "SpendReservation",
    title: "SpendReservation",
    description:
      "Authorization committed to one independently billed effect before that effect occurs " +
      "(architecture contract §13.2, §19.3). ADDITIONAL CONSTRAINT NOT EXPRESSIBLE IN JSON " +
      "SCHEMA: a reservation past `reserved` must record `settledAt`. `reserved` is denominated " +
      "in the authorization's currency, which is not necessarily the provider's billing currency.",
  });

/** @see spendReservationSchema */
export type SpendReservation = z.infer<typeof spendReservationSchema>;

/**
 * Whether a reservation still commits authorization (ADR-0044).
 *
 * `billing_unknown` counts. An unknown charge is neither free nor zero, and releasing it would
 * restore authorization for money that may already be gone.
 */
export function reservationIsActive(reservation: SpendReservation): boolean {
  return reservation.status === "reserved" || reservation.status === "billing_unknown";
}

/**
 * Whether an unresolved reservation's exposure is bounded by what was reserved (ADR-0044).
 *
 * Every fact must be present, and all of them are facts about **this execution** rather than about
 * the backend in general:
 *
 * - the execution evidence was recorded at dispatch;
 * - the Runtime supplied a ceiling and the backend enforced it;
 * - a ceiling amount is on the record;
 * - the reservation is still active, still consuming its full reserved amount.
 *
 * Any absence and the answer is `false`, which leaves the whole grant indeterminate. That is the
 * safe direction: the alternative claims a bound from evidence that was never collected.
 */
export function reservationExposureIsBounded(reservation: SpendReservation): boolean {
  const execution = reservation.execution;
  if (execution === undefined) return false;
  if (!execution.ceilingEnforced) return false;
  if (execution.appliedCeiling === undefined) return false;
  return reservationIsActive(reservation);
}

/* -------------------------------------------------------------------------------------------
 * Transitions — the authoritative form (ADR-0044, #155 step 2)
 * ---------------------------------------------------------------------------------------- */

/** What kinds of fact a reservation stream carries. */
export const SPEND_TRANSITION_KINDS = [
  /** Authorization committed to an effect, before dispatch. */
  "reservation.reserved",
  /** The runtime is about to call a provider. Appended **before** the call. */
  "reservation.dispatch_prepared",
  /** The provider request identity became known. */
  "reservation.dispatch_identified",
  /** A charge is known and its cost records are durable. */
  "reservation.settled",
  /** No charge occurred. */
  "reservation.released",
  /** The provider charged and did not say how much. */
  "reservation.billing_unknown",
  /**
   * A human investigated and stopped without an answer (#155 step 5).
   *
   * **Non-terminal and repeatable**, and deliberately not `reservation.reconciled`. Recording an
   * abandoned investigation on the terminal seam consumed it: the projection stayed
   * `billing_unknown`, so a later decision looked legal, and the append was then refused because
   * the last transition was already `reconciled`. Ending one investigation permanently prevented
   * later evidence from settling or releasing the reservation.
   */
  "reservation.investigation_recorded",
  /** A human or a provider lookup resolved an unknown charge. */
  "reservation.reconciled",
] as const;

/** @see SPEND_TRANSITION_KINDS */
export type SpendTransitionKind = (typeof SPEND_TRANSITION_KINDS)[number];

/**
 * One appended fact about a reservation. Never edited (ADR-0044).
 *
 * `transitionId` is the identity a retry resolves against: the same id with byte-identical contents
 * is the same fact and appending it again is a no-op; the same id with different contents is two
 * different facts wearing one name, and is refused.
 */
export const spendReservationTransitionSchema = z
  .object({
    schemaVersion: schemaVersionString,
    /** Stable across retries of the operation that produced it. */
    transitionId: nonEmptyString,
    reservationId: nonEmptyString,
    /** The budget pool this belongs to — the stream's partition key. */
    grantId: nonEmptyString,
    kind: z.enum(SPEND_TRANSITION_KINDS),
    at: iso8601,
    /** Kind-specific payload, already redacted (§19.2). */
    detail: z.record(z.string(), z.unknown()),
  })
  .meta({
    id: "SpendReservationTransition",
    title: "SpendReservationTransition",
    description:
      "One appended, immutable fact about a spend reservation (architecture contract §19.3). " +
      "The transition stream is authoritative; SpendReservation is a projection of it.",
  });

/** @see spendReservationTransitionSchema */
export type SpendReservationTransition = z.infer<typeof spendReservationTransitionSchema>;

/** Which kinds may follow which. Terminal states have no successors (ADR-0044). */
const ALLOWED_AFTER: Record<string, readonly SpendTransitionKind[]> = {
  // Before anything exists, only a reservation may be created.
  "": ["reservation.reserved"],
  "reservation.reserved": [
    "reservation.dispatch_prepared",
    "reservation.dispatch_identified",
    "reservation.settled",
    "reservation.released",
    "reservation.billing_unknown",
  ],
  // Annotations, not state changes: the reservation stays `reserved`.
  "reservation.dispatch_prepared": [
    "reservation.dispatch_identified",
    "reservation.settled",
    "reservation.released",
    "reservation.billing_unknown",
  ],
  "reservation.dispatch_identified": [
    "reservation.settled",
    "reservation.released",
    "reservation.billing_unknown",
  ],
  "reservation.billing_unknown": [
    "reservation.investigation_recorded",
    "reservation.reconciled",
    "reservation.settled",
    "reservation.released",
  ],
  // Repeatable: a second investigation may end unresolved too, and a third may find the answer.
  "reservation.investigation_recorded": [
    "reservation.investigation_recorded",
    "reservation.reconciled",
    "reservation.settled",
    "reservation.released",
  ],
  // Terminal. A reservation that stopped consuming authorization never resumes.
  "reservation.settled": [],
  "reservation.released": [],
  // Repeatable, because one reservation may hold several independently billed observations. A
  // partial settlement failure leaves each unwritten observation needing its own decision — they
  // can have different providers, and one record cannot name two. The reservation stays
  // `billing_unknown` until the last one is resolved, so a decision covering observation A does
  // not release authorization for B.
  "reservation.reconciled": [
    "reservation.reconciled",
    "reservation.investigation_recorded",
    "reservation.settled",
    "reservation.released",
  ],
};

/** Why a proposed transition is not legal for the current stream. */
export interface TransitionRejection {
  transitionId: string;
  reason: "illegal-successor" | "unknown-reservation";
  explanation: string;
}

/**
 * Whether a proposed transition may follow what the stream already holds (ADR-0044).
 *
 * **Lifecycle policy, evaluated by `SpendService` against a projection it reduced** — not by the
 * storage adapter. A store that knew the state machine would be a store making policy, and the
 * expected revision is what keeps a decision taken a moment ago safe to apply.
 */
export function isLegalSuccessor(
  previous: SpendTransitionKind | undefined,
  next: SpendTransitionKind,
): boolean {
  return (ALLOWED_AFTER[previous ?? ""] ?? []).includes(next);
}

/**
 * Reduce a grant's transitions into the reservations they describe (ADR-0044).
 *
 * The projection. Never stored as the answer to anything — `availableAuthorization` runs over the
 * result of this, so a cached figure can never become a second authoritative balance.
 */
export function reduceReservations(
  transitions: readonly SpendReservationTransition[],
): readonly SpendReservation[] {
  const byId = new Map<string, SpendReservation>();
  for (const transition of transitions) {
    // The detail is `Record<string, unknown>` by schema. Reading it here is the one place a
    // transition's payload becomes typed, and the projection is validated by the caller that
    // parses the stream — a malformed detail surfaces as a refused stream, not a silently
    // half-built reservation.
    const detail = transition.detail as Record<string, never>;
    const existing = byId.get(transition.reservationId);

    if (transition.kind === "reservation.reserved") {
      byId.set(transition.reservationId, {
        schemaVersion: transition.schemaVersion,
        reservationId: transition.reservationId,
        grantId: transition.grantId,
        authorizationId: detail["authorizationId"],
        operation: detail["operation"],
        runId: detail["runId"],
        stageId: detail["stageId"],
        attemptId: detail["attemptId"],
        effectKey: detail["effectKey"],
        reserved: detail["reserved"],
        status: "reserved",
        costIds: [],
        createdAt: transition.at,
      } as unknown as SpendReservation);
      continue;
    }

    if (existing === undefined) continue;

    switch (transition.kind) {
      case "reservation.dispatch_prepared":
        byId.set(transition.reservationId, { ...existing, execution: detail["execution"] });
        break;
      case "reservation.dispatch_identified":
        byId.set(transition.reservationId, {
          ...existing,
          providerRequestId: detail["providerRequestId"],
        });
        break;
      case "reservation.settled":
      case "reservation.released":
      case "reservation.billing_unknown":
        byId.set(transition.reservationId, {
          ...existing,
          status: (transition.kind.split(".")[1] ?? "reserved") as SpendReservation["status"],
          costIds: (detail["costIds"] as string[] | undefined) ?? existing.costIds,
          ...(transition.kind === "reservation.billing_unknown"
            ? {}
            : { settledAt: transition.at }),
        });
        break;
      case "reservation.reconciled":
        byId.set(transition.reservationId, {
          ...existing,
          costIds: (detail["costIds"] as string[] | undefined) ?? existing.costIds,
        });
        break;
      // Recorded and deliberately inert: an abandoned investigation resolves nothing, so the
      // projection is unchanged and the reservation keeps consuming its reserved amount.
      case "reservation.investigation_recorded":
        break;
    }
  }
  return [...byId.values()];
}
