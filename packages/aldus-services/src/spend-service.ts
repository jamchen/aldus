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
import type { GrantReservationStream, SpendReservationStore } from "@aldus-runtime/file-store";

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
      /**
       * Who charged, and for what — required unless a linked unknown observation already says.
       *
       * The first implementation wrote `provider: "reconciled"`, which describes **how Aldus
       * learned a fact** rather than who charged for what: a fabricated provider that also
       * silently removed the charge from per-provider reporting. Where an unresolved observation
       * survives, these come from it; where nothing was ever written, the evidence has to supply
       * them or the reconciliation is refused.
       */
      provider?: string;
      billedOperation?: string;
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
  /** Charges linked to this reservation whose money amount nobody established (#150). */
  unquantifiedUnknownBillingCount: number;
  /** Every human finding so far, terminal or audit-only, in order. */
  reconciliationHistory: readonly {
    decisionId: string;
    resolution: string;
    evidenceRef: string;
    decidedBy: ActorRef | undefined;
    at: string;
    outcome: "terminal" | "audit_only";
  }[];
  /** Why this reservation is unresolved and non-retryable, in the operator's terms. */
  unresolvedReason?: string;
}

/**
 * Proof that a reconciliation was initiated by a trusted operator invocation (#155 step 5).
 *
 * A caller-supplied `ActorRef` proves nothing: any caller can write `{ kind: "human" }`, so a check
 * on that field tests whether a caller is *honest about being an agent*, not whether a human
 * decided. The brand is a phantom — declared as a type, absent at runtime — and the runtime proof
 * is membership of a set only {@link OperatorSpendConsole} can add to, following the same pattern
 * `SynthesisPermit` uses for the same reason.
 */
export type OperatorAuthority = { readonly actor: ActorRef } & {
  readonly __operatorAuthority: unique symbol;
};

/** Authorities this process minted. A cast cannot manufacture membership. */
const ISSUED_AUTHORITIES = new WeakSet<object>();

/** Whether an authority was minted here rather than assembled by a caller. */
export function isIssuedOperatorAuthority(authority: OperatorAuthority): boolean {
  return ISSUED_AUTHORITIES.has(authority);
}

/**
 * The only path to a reconciliation (#155 step 5).
 *
 * Constructed by the composition root with the actor it already trusts, so the decision's identity
 * comes from the invocation rather than from an argument. `reconcile` takes no actor: there is
 * nothing for a caller to claim.
 */
export class OperatorSpendConsole {
  readonly #spend: SpendService;
  readonly #actor: ActorRef;

  constructor(options: { spend: SpendService; actor: ActorRef }) {
    this.#spend = options.spend;
    this.#actor = options.actor;
  }

  /** @see SpendService.reconcile */
  reconcile(
    reservation: SpendReservation,
    input: ReconcileInput,
  ): Promise<{ reservation: SpendReservation; costs: readonly CostRecord[] }> {
    const authority = { actor: this.#actor } as OperatorAuthority;
    ISSUED_AUTHORITIES.add(authority);
    return this.#spend.reconcile(reservation, input, authority);
  }

  /** @see SpendService.status */
  status(runId: string): Promise<readonly ReservationStatus[]> {
    return this.#spend.status(runId);
  }
}

/** One human reconciliation decision. Carries no actor: see {@link OperatorSpendConsole}. */
export interface ReconcileInput {
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
    try {
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
    } catch (thrown) {
      // The provider was called and the charge could not be recorded (#152). The reservation moves
      // to `billing_unknown` **before** the error propagates, so the state a human must act on
      // exists without anyone performing a repair step first. Left `reserved`, it reads as
      // "dispatch not begun", which is exactly the wrong thing to tell an operator here.
      await this.markUnknown(reservation, [], {
        reason:
          "settlement persistence failed after dispatch: the provider may have charged and the " +
          "cost record could not be written, so this is non-retryable until reconciled (#152)",
      });
      throw thrown;
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
    options: { reason?: string } = {},
  ): Promise<SpendReservation> {
    return this.#appendOne(reservation, "reservation.billing_unknown", {
      costIds: [...costIds],
      // Why it is unresolved, in the operator's terms. `budget status` surfaces this, because
      // "non-retryable" with no reason gives a human nothing to act on.
      ...(options.reason === undefined ? {} : { reason: options.reason }),
    });
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
    const costs = await this.#costs.list(runId);
    const byGrant = new Map<string, GrantReservationStream>();
    for (const reservation of reservations) {
      if (!byGrant.has(reservation.grantId)) {
        byGrant.set(reservation.grantId, await this.#store.readGrant(reservation.grantId));
      }
    }

    return reservations.map((reservation) => {
      const transitions = (byGrant.get(reservation.grantId)?.transitions ?? []).filter(
        (transition) => transition.reservationId === reservation.reservationId,
      );
      // Every human finding so far, in order. A reconciliation decided without seeing what a
      // previous investigator already established is the second person repeating the first's work
      // — or contradicting it without knowing.
      const history = transitions
        .filter(
          (transition) =>
            transition.kind === "reservation.reconciled" ||
            transition.kind === "reservation.investigation_recorded",
        )
        .map((transition) => ({
          decisionId: String(transition.detail["decisionId"] ?? ""),
          resolution: String(transition.detail["resolution"] ?? ""),
          evidenceRef: String(transition.detail["evidenceRef"] ?? ""),
          decidedBy: transition.detail["decidedBy"] as ActorRef | undefined,
          at: transition.at,
          outcome:
            transition.kind === "reservation.reconciled"
              ? ("terminal" as const)
              : ("audit_only" as const),
        }));
      const unresolvedReason = transitions
        .filter((transition) => transition.kind === "reservation.billing_unknown")
        .map((transition) => transition.detail["reason"])
        .filter((reason): reason is string => typeof reason === "string")
        .at(-1);

      return {
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
        // From the cost records, not from the reservation: an unresolved charge is a billing fact
        // and the reservation is an authorization one.
        unquantifiedUnknownBillingCount: costs.filter(
          (record) =>
            record.reservationId === reservation.reservationId &&
            record.billingStatus === "unknown" &&
            record.actual === undefined &&
            record.estimated === undefined,
        ).length,
        reconciliationHistory: history,
        ...(unresolvedReason === undefined ? {} : { unresolvedReason }),
      };
    });
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
    authority: OperatorAuthority,
  ): Promise<{ reservation: SpendReservation; costs: readonly CostRecord[] }> {
    // Membership, not shape. A caller that assembled an object with the right fields has proved it
    // can write an object literal.
    if (!isIssuedOperatorAuthority(authority)) {
      throw serviceError(
        ServiceErrorCodes.SPEND_NOT_AUTHORIZED,
        "This reconciliation did not come through an operator console, so nothing establishes " +
          "that a human decided it. A caller-supplied actor is a claim about itself (§19.2).",
        {
          category: "policy",
          retryable: false,
          details: { reservationId: reservation.reservationId },
        },
      );
    }
    if (authority.actor.kind !== "human") {
      throw serviceError(
        ServiceErrorCodes.SPEND_NOT_AUTHORIZED,
        `Reconciliation is a human decision and this actor is a "${authority.actor.kind}". An ` +
          "agent " +
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

    // Resumable by design (#155 step 5). The decision transition is identified by the decision,
    // not by its kind, so retrying the same decision after a failed cost write re-appends nothing
    // and continues from where it stopped. A *different* decision, or the same id carrying
    // different contents, conflicts rather than overwriting.
    const stream = await this.#store.readGrant(current.grantId);
    const priorDecision = stream.transitions.find(
      (transition) =>
        transition.reservationId === current.reservationId &&
        transition.kind === "reservation.reconciled",
    );
    if (priorDecision !== undefined && priorDecision.detail["decisionId"] !== input.decisionId) {
      throw serviceError(
        ServiceErrorCodes.SPEND_NOT_AUTHORIZED,
        `Reservation "${current.reservationId}" already carries reconciliation decision ` +
          `"${String(priorDecision.detail["decisionId"])}". A second, different decision would ` +
          "overwrite a human's recorded finding rather than adding to it (ADR-0044).",
        {
          category: "conflict",
          retryable: false,
          details: { reservationId: current.reservationId },
        },
      );
    }

    const decisionDetail: Record<string, unknown> = {
      decisionId: input.decisionId,
      resolution: input.resolution.kind,
      evidenceRef: input.evidenceRef,
      decidedBy: { kind: authority.actor.kind, id: authority.actor.id },
      ...(input.resolution.kind === "settled_with_amount"
        ? { amount: input.resolution.amount }
        : {}),
    };

    if (input.resolution.kind === "investigation_ended") {
      // Its own non-terminal transition, and repeatable: recording an abandoned investigation on
      // the terminal seam made the first one a dead end for every later decision.
      const recorded = await this.#appendOne(
        current,
        "reservation.investigation_recorded",
        decisionDetail,
        `${current.reservationId}:investigation:${input.decisionId}`,
      );
      return { reservation: recorded, costs: [] };
    }

    // Appended before anything changes, so the decision survives even if the effect below fails.
    const audited =
      priorDecision !== undefined
        ? current
        : await this.#appendOne(
            current,
            "reservation.reconciled",
            decisionDetail,
            `${current.reservationId}:reconciled:${input.decisionId}`,
          );

    if (input.resolution.kind === "released_as_uncharged") {
      return {
        reservation: await this.#appendOne(audited, "reservation.released", {
          reason: `reconciled as uncharged: ${input.evidenceRef}`,
        }),
        costs: [],
      };
    }

    // `settled_with_amount`: the record is durable before authorization is released.
    //
    // Provider and operation are preserved from a surviving unresolved observation where one
    // exists, because that is who actually charged. Where nothing was written, the evidence must
    // supply them — Aldus does not invent a provider to fill a required field.
    const linked = (await this.#costs.list(current.runId)).find(
      (record) =>
        record.reservationId === current.reservationId && record.billingStatus === "unknown",
    );
    const provider = linked?.provider ?? input.resolution.provider;
    const operation = linked?.operation ?? input.resolution.billedOperation;
    if (provider === undefined || operation === undefined) {
      throw serviceError(
        ServiceErrorCodes.SPEND_NOT_AUTHORIZED,
        `Reconciling reservation "${current.reservationId}" with an amount requires who was ` +
          "charged and for what. No unresolved observation survives to take them from, so the " +
          "evidence must state them: a record naming Aldus as the provider would describe how " +
          "the fact was learned rather than who billed (§19.3).",
        {
          category: "validation",
          retryable: false,
          details: { reservationId: current.reservationId },
        },
      );
    }

    const costId = `${current.reservationId}:reconciled`;
    const record: CostRecord = {
      schemaVersion: SCHEMA_VERSION,
      costId,
      runId: current.runId,
      stageId: current.stageId,
      attemptId: current.attemptId,
      reservationId: current.reservationId,
      // Runtime-owned, from the reservation. Never taken from the reconciliation input.
      authorizationId: current.authorizationId,
      provider,
      operation,
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
    transitionId?: string,
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
        transitions: [
          {
            ...this.#transition(current.reservationId, current.grantId, kind, detail),
            // Per decision rather than per kind where one is supplied: a reconciliation must be
            // resumable by the same decision and repeatable across different ones.
            ...(transitionId === undefined ? {} : { transitionId }),
          },
        ],
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
