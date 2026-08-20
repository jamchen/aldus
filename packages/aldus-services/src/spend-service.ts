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
  type CostObservation,
  type ActorRef,
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
export type CostExpectation =
  /** Declared free. No grant required, no reservation created. */
  | { kind: "free" }
  /** Expected to cost this much. A grant is required and the estimate is reserved. */
  | { kind: "estimated"; amount: Money }
  /** Expected to cost, amount unknown. A grant is required and its policy must permit this. */
  | { kind: "unestimated" };

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

/**
 * How a human resolved a charge nobody could measure (ADR-0044; #155 step 5).
 *
 * **Two terminal resolutions, and one that resolves nothing.** A third — accepting the reservation
 * amount as the charge — was proposed and rejected: a reservation amount is an *authorization*
 * fact, not a provider billing fact, and copying it into a `CostRecord` would present what Aldus
 * set aside as what a provider charged. §19.3 already says an estimate does not resolve an unknown
 * charge, and this is the same substitution wearing a human's signature.
 */
export type ReconciliationResolution =
  | {
      /** Provider evidence or a cited operator finding established the charge. */
      kind: "settled_with_amount";
      /**
       * What was actually charged, in the **provider's billing currency**.
       *
       * Not converted into the authorization currency. Where they differ, both are recorded and
       * the mismatch is reported; converting implicitly would invent a rate nobody approved.
       */
      amount: Money;
    }
  | {
      /** Positive evidence that nothing was charged. */
      kind: "released_as_uncharged";
    }
  | {
      /**
       * Investigation ended without an answer.
       *
       * Recorded as a human decision and **resolves nothing**: the reservation stays
       * `billing_unknown`, keeps consuming its full reserved amount, and reports stay
       * indeterminate. *"I could not find a charge"* is not evidence that no charge occurred.
       */
      kind: "investigation_ended";
    };

/**
 * What an operator sees before deciding (#155 step 5).
 *
 * The reserved amount is named `reservedAuthorizationAmount` rather than `amount`, because the one
 * mistake this surface must not invite is reading *what Aldus set aside* as *what the provider
 * charged*.
 */
export interface ReservationStatus {
  reservationId: string;
  grantId: string;
  authorizationId: string;
  runId: string;
  stageId: string;
  attemptId: string;
  effectKey: string;
  operation: string;
  status: SpendReservation["status"];
  /** In the **authorization** currency. Never the provider's billing figure. */
  reservedAuthorizationAmount: Money;
  costIds: string[];
  /** The handle a provider lookup needs. Non-secret by contract (§19.2). */
  providerRequestId?: string;
  /** What was true of the execution at dispatch, where it was recorded. */
  execution?: SpendReservation["execution"];
  /** Whether a human decision is what this reservation is waiting on. */
  requiresReconciliation: boolean;
}

/** One human reconciliation decision. */
export interface ReconcileInput {
  /**
   * Who decided. **Human only**, and supplied by the Runtime rather than as a caller string.
   *
   * An agent that could reconcile could release authorization it had itself consumed.
   */
  actor: ActorRef;
  /**
   * What the decision rests on — a provider statement, a support reference, an invoice line.
   *
   * Opaque to Aldus and required for every resolution that changes anything. Recorded so the
   * decision can be re-examined by someone who was not in the room.
   */
  evidenceRef: string;
  resolution: ReconciliationResolution;
  /** Stable across retries, so reconciling twice is one decision rather than two. */
  decisionId: string;
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

    const unknown = written.some((record) => record.billingStatus === "unknown");
    const kind: SpendTransitionKind = unknown
      ? "reservation.billing_unknown"
      : written.length === 0 || written.every((record) => record.billingStatus === "voided")
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
  ): Promise<SpendReservation> {
    return this.#appendOne(reservation, "reservation.billing_unknown", { costIds: [...costIds] });
  }

  /**
   * Everything an operator needs to reconcile safely (#155 step 5).
   *
   * Deliberately complete rather than minimal: `spend list` and `spend inspect` are not built yet,
   * so this is the only surface, and a reconciliation decided from a partial view is the thing the
   * evidence requirement exists to prevent.
   *
   * Carries no credentials and no secret provider material. `providerRequestId` is included only
   * because it is the handle a provider lookup needs; everything redacted stays redacted.
   */
  async status(runId: string): Promise<readonly ReservationStatus[]> {
    const reservations = await this.#store.listByRun(runId);
    return reservations.map((reservation) => ({
      reservationId: reservation.reservationId,
      grantId: reservation.grantId,
      authorizationId: reservation.authorizationId,
      runId: reservation.runId,
      stageId: reservation.stageId,
      attemptId: reservation.attemptId,
      effectKey: reservation.effectKey,
      operation: reservation.operation,
      status: reservation.status,
      // Labelled, not merely typed. A reader who takes this for the provider's charge has made
      // exactly the substitution the rejected third resolution would have institutionalised.
      reservedAuthorizationAmount: reservation.reserved,
      costIds: [...reservation.costIds],
      ...(reservation.providerRequestId === undefined
        ? {}
        : { providerRequestId: reservation.providerRequestId }),
      ...(reservation.execution === undefined ? {} : { execution: reservation.execution }),
      requiresReconciliation: reservation.status === "billing_unknown",
    }));
  }

  /**
   * Resolve a charge of unknown size, by a human, on the record (ADR-0044; #155 step 5).
   *
   * Ordering is the contract, and it is audit-before-effect: the reconciliation decision is
   * appended **first**, then the cost record is written, and only then does the reservation reach
   * a terminal state. A cost write that fails therefore leaves the reservation active and
   * non-retryable with the human decision already durable — which is the state #152 exists to
   * recover, not a new one.
   *
   * @throws {AldusError} when the actor is not human, the evidence is absent, or the reservation
   * is not in a state a decision can resolve.
   */
  async reconcile(
    reservation: SpendReservation,
    input: ReconcileInput,
  ): Promise<{ reservation: SpendReservation; costs: readonly CostRecord[] }> {
    if (input.actor.kind !== "human") {
      throw serviceError(
        ServiceErrorCodes.SPEND_NOT_AUTHORIZED,
        `Reconciliation is a human decision and this actor is a "${input.actor.kind}". An agent ` +
          "that could reconcile could release authorization it had itself consumed (§13.3, §19.3).",
        {
          category: "policy",
          retryable: false,
          details: { reservationId: reservation.reservationId },
        },
      );
    }
    if (input.evidenceRef.trim().length === 0) {
      throw serviceError(
        ServiceErrorCodes.SPEND_NOT_AUTHORIZED,
        "A reconciliation must cite what it rests on. An unevidenced decision about an external " +
          "system is an assertion, and this one can restore authorization (§19.3).",
        {
          category: "validation",
          retryable: false,
          details: { reservationId: reservation.reservationId },
        },
      );
    }
    // Read from the store, not from the argument. A caller holding a reservation it fetched before
    // someone else resolved it would otherwise pass this check on a stale copy and be refused
    // later by the transition machinery, with a message about state machines rather than about the
    // decision it was trying to make.
    const current = await this.#require(reservation.grantId, reservation.reservationId);
    if (current.status !== "billing_unknown") {
      throw serviceError(
        ServiceErrorCodes.SPEND_NOT_AUTHORIZED,
        `Reservation "${current.reservationId}" is "${current.status}" and only an ` +
          "unresolved charge can be reconciled. A terminal reservation never resumes (ADR-0044).",
        {
          category: "conflict",
          retryable: false,
          details: { reservationId: reservation.reservationId },
        },
      );
    }

    // Appended before anything changes, so the decision survives even if the effect below fails.
    const audited = await this.#appendOne(current, "reservation.reconciled", {
      decisionId: input.decisionId,
      resolution: input.resolution.kind,
      evidenceRef: input.evidenceRef,
      decidedBy: { kind: input.actor.kind, id: input.actor.id },
      ...(input.resolution.kind === "settled_with_amount"
        ? { amount: input.resolution.amount }
        : {}),
    });

    if (input.resolution.kind === "investigation_ended") {
      // Resolves nothing on purpose. The reservation stays active, keeps consuming its reserved
      // amount, and reports stay indeterminate — further spend needs a new authorization rather
      // than headroom this decision manufactured.
      return { reservation: audited, costs: [] };
    }

    if (input.resolution.kind === "released_as_uncharged") {
      return {
        reservation: await this.#appendOne(audited, "reservation.released", {
          reason: `reconciled as uncharged: ${input.evidenceRef}`,
        }),
        costs: [],
      };
    }

    // `settled_with_amount`: the record is durable before authorization is released.
    const costId = `${current.reservationId}:reconciled`;
    const record: CostRecord = {
      schemaVersion: SCHEMA_VERSION,
      costId,
      runId: current.runId,
      stageId: current.stageId,
      attemptId: current.attemptId,
      reservationId: current.reservationId,
      provider: "reconciled",
      operation: "reconciliation",
      billingStatus: "charged",
      actual: input.resolution.amount,
      recordedAt: this.#now().toISOString(),
    };
    await this.#costs.append(current.runId, record);

    const settled = await this.#appendOne(audited, "reservation.settled", { costIds: [costId] });
    return { reservation: settled, costs: [record] };
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
