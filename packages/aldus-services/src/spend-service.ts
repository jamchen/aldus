/**
 * Reserving authorization before a paid effect, and settling it after (ADR-0044; #155 step 3).
 *
 * The service owns **policy**: scope, availability, lifecycle legality, the refusal vocabulary and
 * the retry loop. The store owns **durability**. The expected revision is what keeps a decision
 * taken a moment ago safe to apply: if the stream moved, the commit conflicts and the decision is
 * made again against what is now true.
 */

import {
  isLegalSuccessor,
  reduceReservations,
  newSpendReservationId,
  SCHEMA_VERSION,
  type BillingStatus,
  type CostExpectation,
  type CostObservation,
  type CostRecord,
  type Money,
  type SpendReservation,
  type SpendReservationTransition,
  type SpendTransitionKind,
} from "@aldus-runtime/core";
import {
  availableAuthorization,
  checkSpendScope,
  unestimatedPolicyIsSatisfiable,
  compareMoney,
  formatMoney,
  type SpendGrant,
} from "@aldus-runtime/gate-engine";
import type { SpendReservationStore } from "@aldus-runtime/file-store";

import type { CostRecordStore } from "./cost-store.js";
import { ServiceErrorCodes, serviceError } from "./errors.js";

/**
 * What the Runtime expects an execution to cost (ADR-0044; #155).
 *
 * A closed shape replacing an optional `estimated?: Money`, because the absence of an estimate is
 * **not evidence of free execution** — and the previous pair of optional fields made "nobody said"
 * and "nothing will be charged" the same state. That is the readable-absence defect, on the path
 * where it costs money.
 *
 * Runtime or adopter policy, never a billing fact a backend may use to authorize itself.
 */
/**
 * @see CostExpectation
 *
 * Re-exported from Core, where it moved so the Stage Runner can name it without depending on this
 * layer (#107). Nothing that imported it from here has to change.
 */
export type { CostExpectation };

/**
 * Whether a billing status is evidence that **no** charge occurred (§19.3).
 *
 * `free` and `voided` are the two, and they are evidence rather than an absence of it: a provider
 * saying "this was free" and one saying "this was reversed" both establish that nothing is owed.
 * Everything else — `charged`, `estimated`, `unknown` — leaves money either spent or unaccounted
 * for.
 *
 * Shared so the settlement lifecycle and the unauthorized-divergence check answer the question the
 * same way. They disagreed: settlement released only on `voided`, so an all-`free` execution
 * settled — saying money was spent and accounted for when none was — and the free-declaration
 * check treated any non-empty observation array as a violation, so a Worker declared free that
 * truthfully reported `billingStatus: "free"` was recorded as an unauthorized charge.
 */
export function isUncharged(status: BillingStatus): boolean {
  return status === "free" || status === "voided";
}

/** What the caller states before a paid effect. */
export interface ReserveInput {
  grant: SpendGrant | undefined;
  operation: string;
  runId: string;
  stageId: string;
  attemptId: string;
  /** Identity of the independently billed effect (ADR-0043). Retries resolve to one reservation. */
  effectKey: string;
  expectation: CostExpectation;
}

/** What a reservation attempt produced. */
export type ReserveOutcome =
  | { reserved: true; reservation: SpendReservation }
  /** Declared free: nothing to reserve, and nothing pretending to have been reserved. */
  | { reserved: false; reason: "free" }
  | { reserved: false; reason: "refused"; explanation: string; code: string };

/** Evidence about the execution, recorded before the provider is called. */
export interface DispatchEvidence {
  backendId: string;
  backendVersion: string;
  ceilingEnforced: boolean;
  appliedCeiling?: Money;
}

/** Dependencies. */
export interface SpendServiceOptions {
  store: SpendReservationStore;
  costs: CostRecordStore;
  now?: () => Date;
  newReservationId?: () => string;
  /** How many times a conflict is retried before refusing. */
  maxAttempts?: number;
}

const DEFAULT_MAX_ATTEMPTS = 8;

export class SpendService {
  readonly #store: SpendReservationStore;
  readonly #costs: CostRecordStore;
  readonly #now: () => Date;
  readonly #newReservationId: () => string;
  readonly #maxAttempts: number;

  constructor(options: SpendServiceOptions) {
    this.#store = options.store;
    this.#costs = options.costs;
    this.#now = options.now ?? (() => new Date());
    this.#newReservationId = options.newReservationId ?? (() => newSpendReservationId());
    this.#maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  }

  /**
   * Commit authorization before any paid effect (ADR-0044).
   *
   * **This is the single authoritative pre-dispatch decision.** `checkSpend` is not called first:
   * its answer is stale the moment another writer moves the stream, and only the committed answer
   * protects anything.
   */
  async reserve(input: ReserveInput): Promise<ReserveOutcome> {
    if (input.expectation.kind === "free") return { reserved: false, reason: "free" };

    const grant = input.grant;
    if (grant === undefined) {
      return this.#refuse(
        ServiceErrorCodes.SPEND_NOT_AUTHORIZED,
        `Operation "${input.operation}" expects to cost money and no grant authorizes it. The ` +
          "absence of an estimate is not evidence of free execution — declare the expectation " +
          "`free` if nothing will be charged (§13.2).",
      );
    }

    const outOfScope = checkSpendScope(grant, input.operation);
    if (outOfScope !== undefined) {
      return this.#refuse(ServiceErrorCodes.SPEND_NOT_AUTHORIZED, outOfScope.explanation);
    }

    let amount: Money;
    if (input.expectation.kind === "estimated") {
      amount = input.expectation.amount;
    } else {
      if ((grant.unestimatedExecution ?? "refuse") !== "reserve_max_per_request") {
        return this.#refuse(
          ServiceErrorCodes.SPEND_NOT_AUTHORIZED,
          `Grant "${grant.grantId}" does not permit unestimated execution. An execution with no ` +
            "estimate cannot be checked against a ceiling, so it is refused unless the approval " +
            "explicitly permits reserving the per-request maximum (§13.2, ADR-0044).",
        );
      }
      const unsatisfiable = unestimatedPolicyIsSatisfiable(grant);
      if (unsatisfiable !== undefined) {
        return this.#refuse(ServiceErrorCodes.SPEND_NOT_AUTHORIZED, unsatisfiable);
      }
      amount = grant.maxPerRequest as Money;
    }

    for (let attempt = 0; attempt < this.#maxAttempts; attempt += 1) {
      const stream = await this.#store.readGrant(grant.grantId);
      const reservations = reduceReservations(stream.transitions);

      // Idempotency, decided inside the same boundary as availability: two callers racing to
      // reserve the same effect converge on one reservation rather than committing twice.
      const existing = reservations.find(
        (reservation) => reservation.effectKey === input.effectKey,
      );
      if (existing !== undefined) {
        if (
          existing.operation !== input.operation ||
          compareMoney(existing.reserved, amount) !== 0
        ) {
          return this.#refuse(
            ServiceErrorCodes.SPEND_NOT_AUTHORIZED,
            `Effect "${input.effectKey}" is already reserved under different terms. One effect ` +
              "identity cannot describe two different commitments (ADR-0044).",
          );
        }
        return { reserved: true, reservation: existing };
      }

      // The per-request ceiling, enforced here because this is the authoritative decision.
      //
      // ADR-0044 replaced `checkSpend` with `reserve` so nothing would act on a stale answer, and
      // in the move one of `checkSpend`'s three limits was left behind: scope and remaining total
      // were carried over and `maxPerRequest` was not. A grant capping a single request at 2.0000
      // would authorize a 5.0000 one whenever the total had room — on every paid path, not only
      // this one. Found by a composed Worker test asserting that an over-ceiling estimate reaches
      // no provider (#107).
      if (grant.maxPerRequest !== undefined && compareMoney(amount, grant.maxPerRequest) > 0) {
        return this.#refuse(
          ServiceErrorCodes.SPEND_NOT_AUTHORIZED,
          `A single request of ${formatMoney(amount)} exceeds the per-request limit of ` +
            `${formatMoney(grant.maxPerRequest)} on grant "${grant.grantId}" (§19.3).`,
        );
      }

      const costs = await this.#costs.list(input.runId);
      const availability = availableAuthorization(grant, costs, reservations);
      if (!availability.determinate) {
        return this.#refuse(
          ServiceErrorCodes.SPEND_NOT_AUTHORIZED,
          `Remaining authorization on grant "${grant.grantId}" is indeterminate: ` +
            `${availability.indeterminate.unboundedReservations.length} unresolved charge(s) of ` +
            "unknown size stand against it. Spending against a figure nobody can establish is how " +
            "a ceiling is exceeded without any single decision being wrong (§19.3, #150).",
        );
      }
      if (compareMoney(amount, availability.available) > 0) {
        return this.#refuse(
          ServiceErrorCodes.SPEND_NOT_AUTHORIZED,
          `Reserving this execution would exceed the remaining authorization on grant ` +
            `"${grant.grantId}".`,
        );
      }

      const reservationId = this.#newReservationId();
      const committed = await this.#store.compareAndAppend({
        grantId: grant.grantId,
        expectedRevision: stream.revision,
        transitions: [
          this.#transition(reservationId, grant.grantId, "reservation.reserved", {
            authorizationId: grant.decisionId,
            operation: input.operation,
            runId: input.runId,
            stageId: input.stageId,
            attemptId: input.attemptId,
            effectKey: input.effectKey,
            reserved: amount,
          }),
        ],
      });

      if (committed.kind === "conflict") continue; // recompute; never reuse the lost answer
      const settled = await this.#require(grant.grantId, reservationId);
      return { reserved: true, reservation: settled };
    }

    return this.#refuse(
      ServiceErrorCodes.SPEND_NOT_AUTHORIZED,
      `Grant "${grant.grantId}" is under sustained contention and this reservation could not be ` +
        "committed. Nothing was dispatched.",
    );
  }

  /** Record what the execution will be dispatched under — **before** the provider is called. */
  async prepareDispatch(
    reservation: SpendReservation,
    evidence: DispatchEvidence,
  ): Promise<SpendReservation> {
    return this.#appendOne(reservation, "reservation.dispatch_prepared", {
      execution: {
        backendId: evidence.backendId,
        backendVersion: evidence.backendVersion,
        ceilingEnforced: evidence.ceilingEnforced,
        ...(evidence.appliedCeiling === undefined
          ? {}
          : { appliedCeiling: evidence.appliedCeiling }),
      },
    });
  }

  /** Record the provider's request identity once it is known (#152's reconciliation handle). */
  async identifyDispatch(
    reservation: SpendReservation,
    providerRequestId: string,
  ): Promise<SpendReservation> {
    return this.#appendOne(reservation, "reservation.dispatch_identified", { providerRequestId });
  }

  /**
   * Persist the charge, then settle (ADR-0044).
   *
   * Cost ids are derived **once**, before the retry loop: regenerating them per attempt would turn
   * a storage conflict into duplicated spend.
   */
  async settle(
    reservation: SpendReservation,
    observations: readonly CostObservation[],
    attribution: { authorizationId?: string; takeId?: string },
  ): Promise<{ reservation: SpendReservation; costs: readonly CostRecord[] }> {
    const recordedAt = this.#now().toISOString();
    const written: CostRecord[] = [];
    for (const [index, observation] of observations.entries()) {
      const costId = `${reservation.reservationId}:cost:${index}`;
      const record: CostRecord = {
        ...observation,
        schemaVersion: SCHEMA_VERSION,
        costId,
        runId: reservation.runId,
        stageId: reservation.stageId,
        attemptId: reservation.attemptId,
        reservationId: reservation.reservationId,
        ...(attribution.authorizationId === undefined
          ? {}
          : { authorizationId: attribution.authorizationId }),
        ...(attribution.takeId === undefined ? {} : { takeId: attribution.takeId }),
        recordedAt,
      };
      await this.#costs.append(reservation.runId, record);
      written.push(record);
    }

    // `released` means no charge occurred, and `free` is evidence of exactly that — the same
    // evidence `voided` is. Recognising only `voided` settled an all-free execution, which says
    // money was spent and accounted for when none was (ADR-0044).
    const unknown = written.some((record) => record.billingStatus === "unknown");
    const kind: SpendTransitionKind = unknown
      ? "reservation.billing_unknown"
      : written.length === 0 || written.every((record) => isUncharged(record.billingStatus))
        ? "reservation.released"
        : "reservation.settled";

    const updated = await this.#appendOne(reservation, kind, {
      costIds: written.map((record) => record.costId),
    });
    return { reservation: updated, costs: written };
  }

  /**
   * Release a reservation whose effect is known **not** to have begun (ADR-0044).
   *
   * Refuses once `dispatch_prepared` exists. After that boundary a failure is not proof of no
   * charge, and releasing would restore authorization for money that may already be gone.
   */
  async releaseBeforeDispatch(
    reservation: SpendReservation,
    reason: string,
  ): Promise<SpendReservation> {
    if (reservation.execution !== undefined) {
      throw serviceError(
        ServiceErrorCodes.SPEND_NOT_AUTHORIZED,
        `Reservation "${reservation.reservationId}" has been prepared for dispatch, so its effect ` +
          "may have begun. Releasing it would restore authorization for money that may already be " +
          "gone; the honest outcome is an unknown charge awaiting reconciliation (ADR-0044).",
        {
          category: "conflict",
          retryable: false,
          details: { reservationId: reservation.reservationId },
        },
      );
    }
    return this.#appendOne(reservation, "reservation.released", { reason });
  }

  /** Retain the reservation and make the effect non-retryable (§19.3, #150). */
  async markUnknown(
    reservation: SpendReservation,
    costIds: readonly string[] = [],
    options: { reason?: string } = {},
  ): Promise<SpendReservation> {
    return this.#appendOne(reservation, "reservation.billing_unknown", {
      costIds: [...costIds],
      // Why it is unresolved, in the operator's terms. "Non-retryable" with no reason gives a
      // human nothing to act on, and a paid Worker that came back silent is a different problem
      // from one that threw.
      ...(options.reason === undefined ? {} : { reason: options.reason }),
    });
  }

  #transition(
    reservationId: string,
    grantId: string,
    kind: SpendTransitionKind,
    detail: Record<string, unknown>,
  ): SpendReservationTransition {
    return {
      schemaVersion: SCHEMA_VERSION,
      // Stable across retries: one reservation has at most one transition of each kind, so a
      // repeat resolves to `already_present` rather than committing twice.
      transitionId: `${reservationId}:${kind}`,
      reservationId,
      grantId,
      kind,
      at: this.#now().toISOString(),
      detail,
    };
  }

  /** Append one transition, retrying past conflicts caused by unrelated writers. */
  async #appendOne(
    reservation: SpendReservation,
    kind: SpendTransitionKind,
    detail: Record<string, unknown>,
  ): Promise<SpendReservation> {
    for (let attempt = 0; attempt < this.#maxAttempts; attempt += 1) {
      const stream = await this.#store.readGrant(reservation.grantId);
      const current = reduceReservations(stream.transitions).find(
        (entry) => entry.reservationId === reservation.reservationId,
      );
      if (current === undefined) {
        throw serviceError(
          ServiceErrorCodes.SPEND_NOT_AUTHORIZED,
          `Reservation "${reservation.reservationId}" is not in grant "${reservation.grantId}".`,
          { category: "not_found", retryable: false, details: {} },
        );
      }
      if (!isLegalSuccessor(lastKindOf(stream.transitions, current.reservationId), kind)) {
        throw serviceError(
          ServiceErrorCodes.SPEND_NOT_AUTHORIZED,
          `Reservation "${current.reservationId}" cannot transition to "${kind}" from its current ` +
            "state. A reservation that stopped consuming authorization never resumes (ADR-0044).",
          {
            category: "conflict",
            retryable: false,
            details: { reservationId: current.reservationId },
          },
        );
      }

      const result = await this.#store.compareAndAppend({
        grantId: reservation.grantId,
        expectedRevision: stream.revision,
        transitions: [this.#transition(current.reservationId, current.grantId, kind, detail)],
      });
      // A conflict here is usually an unrelated reservation on a shared grant. Retrying is right;
      // sending an operator to reconciliation for it would make every busy grant look broken.
      if (result.kind === "conflict") continue;
      return this.#require(reservation.grantId, reservation.reservationId);
    }
    throw serviceError(
      ServiceErrorCodes.SPEND_NOT_AUTHORIZED,
      `Grant "${reservation.grantId}" is under sustained contention; "${kind}" was not recorded.`,
      { category: "conflict", retryable: true, details: {} },
    );
  }

  async #require(grantId: string, reservationId: string): Promise<SpendReservation> {
    const stream = await this.#store.readGrant(grantId);
    const found = reduceReservations(stream.transitions).find(
      (reservation) => reservation.reservationId === reservationId,
    );
    if (found === undefined) {
      throw serviceError(
        ServiceErrorCodes.SPEND_NOT_AUTHORIZED,
        `Reservation "${reservationId}" was committed and cannot be read back.`,
        { category: "internal", retryable: false, details: { grantId, reservationId } },
      );
    }
    return found;
  }

  #refuse(code: string, explanation: string): ReserveOutcome {
    return { reserved: false, reason: "refused", explanation, code };
  }
}

/** The most recent transition kind for one reservation, or `undefined` if it has none. */
function lastKindOf(
  transitions: readonly SpendReservationTransition[],
  reservationId: string,
): SpendTransitionKind | undefined {
  let last: SpendTransitionKind | undefined;
  for (const transition of transitions) {
    if (transition.reservationId === reservationId) last = transition.kind;
  }
  return last;
}
