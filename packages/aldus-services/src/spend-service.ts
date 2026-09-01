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
  stageDispatchEvidence,
  newSpendReservationId,
  SCHEMA_VERSION,
  type BillingStatus,
  type CostExpectation,
  type CostObservation,
  type ActorRef,
  type CostRecord,
  type Money,
  type SpendReservation,
  type SpendReservationTransition,
  type StageDispatchEvidence,
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
import type { GrantReservationStream, SpendReservationStore } from "@aldus-runtime/file-store";
import { digestJson } from "@aldus-runtime/stage-runner";

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

/**
 * How a human resolved a charge nobody could measure (ADR-0044; #155 step 5).
 *
 * **Two terminal resolutions, and one that resolves nothing.** A third — accepting the reservation
 * amount as the charge — was proposed and rejected: a reservation amount is an *authorization*
 * fact, not a provider billing fact, and copying it into a `CostRecord` would present what Aldus
 * set aside as what a provider charged. §19.3 already says an estimate does not resolve an unknown
 * charge, and this is the same substitution wearing a human's signature.
 */
/**
 * One billing observation that was dispatched and never durably recorded (#152, #155 step 5).
 *
 * Identity plus the two non-secret facts the provider already stated. A count told an operator
 * *how many* charges were unrecorded and nothing about *which*, so reconciling "the remainder"
 * meant reconstructing it from an English sentence — and a reservation holding several
 * observations from different providers cannot be reconciled from prose without either losing one
 * or double-counting a record that is already durable.
 *
 * `observationId` is the cost id the failed write would have used, so a pending observation and
 * the record that eventually resolves it share one identity. That is what makes settling the
 * missing portion idempotent rather than additive.
 */
export interface PendingObservation {
  /** Stable identity, and the `costId` its eventual record carries. */
  observationId: string;
  /** Who charged. From the backend's own observation, never invented. */
  provider: string;
  /** What was billed. From the backend's own observation. */
  operation: string;
}

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
       * Which unrecorded observation this settles, when the reservation has pending ones.
       *
       * Required whenever {@link ReservationStatus.pendingObservations} is non-empty, and refused
       * when it names something not pending. Without it a decision would settle "the remainder" as
       * a single figure while the remainder is several charges from different providers — and the
       * operator would have to reconstruct which from prose.
       */
      observationId?: string;
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
      /**
       * Which unrecorded observation this proves uncharged, when the reservation has pending ones.
       *
       * Required on the same terms as {@link ReconciliationResolution.observationId} for a
       * settlement, and for a sharper reason: without it one human's finding about observation A
       * released the whole reservation while B was still unaccounted for.
       */
      observationId?: string;
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
    /**
     * `audit_only` resolves nothing; `decision_recorded` is durable and unfinished;
     * `completed` reached a terminal lifecycle state.
     */
    outcome: "audit_only" | "decision_recorded" | "completed";
  }[];
  /** Why this reservation is unresolved and non-retryable, in the operator's terms. */
  unresolvedReason?: string;
  /**
   * Charges that are durably recorded, with who charged and for what (#152).
   *
   * The other half of {@link pendingObservations}. An operator reconciling a partial settlement
   * needs to see what is already on the books, or the figure they state will cover it twice.
   */
  durableCosts: readonly { costId: string; provider: string; operation: string }[];
  /**
   * Charges dispatched and never recorded, each identified (#152).
   *
   * Empty for the ordinary unresolved charge, where the record exists and its amount is unknown.
   * Non-empty only after a settlement failed partway, and then each entry needs its own
   * reconciliation decision naming its `observationId`.
   */
  pendingObservations: readonly PendingObservation[];
}

/**
 * Proof that a reconciliation was initiated by a boundary that established a human (#155 step 5).
 *
 * A caller-supplied `ActorRef` proves nothing: any caller can write `{ kind: "human" }`, so a check
 * on that field tests whether a caller is *honest about being an agent*, not whether a human
 * decided. The brand is a phantom — declared as a type, absent at runtime — and the runtime proof
 * is membership of a set only {@link OperatorSpendConsole} can add to.
 *
 * **Nothing public mints one.** Aldus has no boundary that authenticates an operator: the CLI's
 * actor comes from `--actor` or `ALDUS_ACTOR`, which is an attribution convention rather than
 * evidence of human presence. Two earlier attempts got this wrong in the same way — first a public
 * constructor taking an `ActorRef`, then a public factory taking one — and both amounted to
 * minting authority from the caller's own assertion while the `WeakSet` made it look established.
 *
 * So the mint is package-internal and reconciliation is unreachable from the published surface.
 * That is the honest state: `status` answers what is unresolved, and no API claims a human
 * enforced anything. When a boundary exists that genuinely establishes operator identity or human
 * presence, **that** boundary becomes the mint, and this type is what it hands over.
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
 * **Package-internal, and neither this nor {@link openOperatorConsole} is exported from the package
 * index.** It exists so the reconciliation protocol can be built and tested against the boundary
 * that will eventually establish a human, not so a caller can reach it today.
 */
class OperatorSpendConsole {
  readonly #spend: SpendService;
  readonly #actor: ActorRef;

  /** @internal Reachable only through {@link openOperatorConsole}. */
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

  /**
   * Record that a dispatch is not coming back (#226).
   *
   * A process killed between `reserve` and any billing outcome leaves the reservation `reserved`:
   * nothing survived to classify it. ADR-0044's terminal states do not describe it and neither
   * does `billing_unknown` on its own — *stuck* is a third thing, and the only party who can say
   * which it is, is a person who knows the process died.
   *
   * The resolution it records is **unknown, not zero**. The execution may have run for minutes
   * before it was killed, so a verb that released the reservation as uncharged would convert an
   * unknown into a settled fact — the failure this whole protocol exists to prevent. What this
   * says is only "somebody decided this is not coming back"; what it cost is then the ordinary
   * reconciliation question, answered through {@link reconcile}.
   */
  abandonDispatch(
    reservation: SpendReservation,
    input: { reason: string; transcription?: { recordedBy: ActorRef; verbatim: string } },
  ): Promise<SpendReservation> {
    return this.#spend.markUnknown(reservation, [], {
      reason: input.reason,
      decidedBy: this.#actor,
      ...(input.transcription === undefined ? {} : { transcription: input.transcription }),
    });
  }

  /** @see SpendService.status */
  status(runId: string): Promise<readonly ReservationStatus[]> {
    return this.#spend.status(runId);
  }
}

/**
 * @internal Deliberately absent from `@aldus-runtime/services`. Naming the type publicly would
 * advertise a console no published surface can hand out.
 */
export type { OperatorSpendConsole };

/**
 * Mint an operator console from an actor a trusted boundary established (#155 step 5).
 *
 * @internal **Not exported from `@aldus-runtime/services`, and it must not become so while its
 * only caller would be a composition root reading a self-declared actor.** The `actor` parameter
 * is not evidence; it is what a boundary that *has* evidence passes along. Exporting this would
 * put the evidence-free half of the pair in a caller's hands, which is the defect twice corrected.
 *
 * The kind check below is therefore a consistency check on a trusted boundary's output, not the
 * proof. Nothing here can tell a chosen `{ kind: "human" }` from an established one — which is
 * exactly why the function stays inside the package.
 *
 * @throws {AldusError} when no actor is established, or the established actor is not a human.
 */
export function openOperatorConsole(options: {
  spend: SpendService;
  /** From a boundary that established it. Never a value a caller or request body supplied. */
  actor: ActorRef | undefined;
}): OperatorSpendConsole {
  if (options.actor === undefined) {
    throw serviceError(
      ServiceErrorCodes.SPEND_NOT_AUTHORIZED,
      "No actor identity is established for this invocation, so no reconciliation can be " +
        "attributed to a human (§19.2).",
      { category: "policy", retryable: false, details: {} },
    );
  }
  if (options.actor.kind !== "human") {
    throw serviceError(
      ServiceErrorCodes.SPEND_NOT_AUTHORIZED,
      `This invocation is attributed to a "${options.actor.kind}", and reconciliation is a human ` +
        "decision. An agent that could reconcile could release authorization it had itself " +
        "consumed (§13.3, §19.3).",
      { category: "policy", retryable: false, details: {} },
    );
  }
  return new OperatorSpendConsole({ spend: options.spend, actor: options.actor });
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
  /**
   * Present when the decider did not type this themselves (§19.2, ADR-0054).
   *
   * The same shape a gate decision carries, for the same reason: nothing here authenticates anyone
   * and it does not claim to. What it does is stop *"a human decided"* and *"a human decided and a
   * machine typed it"* being the same record — the only difference an auditor can act on.
   *
   * Supplied by the composition from the **acting** actor, never by a caller naming itself.
   */
  transcription?: { recordedBy: ActorRef; verbatim: string };
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
      // Every record that *did* land is named. Passing an empty list dropped them from the
      // reservation, so a later reconciliation had no way to know part of the charge was already
      // durable — and could settle a total that double-counted it.
      // Writes are sequential, so every index at or past `written.length` is unrecorded. Each one
      // keeps the identity its record would have had, together with the provider and operation the
      // backend already stated — so the pending portion is described rather than counted, and a
      // reservation holding several observations from different providers can be settled one at a
      // time without either losing one or re-settling a durable record.
      const pendingObservations: PendingObservation[] = observations
        .slice(written.length)
        .map((observation, offset) => ({
          observationId: `${reservation.reservationId}:cost:${written.length + offset}`,
          provider: observation.provider,
          operation: observation.operation,
        }));
      await this.markUnknown(
        reservation,
        written.map((record) => record.costId),
        {
          reason:
            `settlement persistence failed after dispatch: ${written.length} of ` +
            `${observations.length} billing observation(s) were recorded, and the remainder could ` +
            "not be written. The provider may have charged for all of them, so this is " +
            "non-retryable until reconciled; reconcile only the unrecorded portion (#152).",
          pendingObservations,
        },
      );
      throw thrown;
    }

    // Three answers, and the first two were previously one.
    //
    // **Silence is not evidence.** A dispatch that came back reporting nothing has not told us it
    // cost nothing; it has told us nothing, and releasing on an empty array restored authorization
    // on the strength of a provider that said nothing. The Worker path already refused this in
    // `StageRunner` and the agent path reached the same `settle` and released — one question with
    // two answers, one method apart. The rule lives here so every caller gets it, rather than in
    // whichever caller happened to think of it (§19.3).
    //
    // **`free` and `voided` are evidence**, of exactly the opposite: a provider stating that
    // nothing is owed. Those still release.
    const unknown = written.some((record) => record.billingStatus === "unknown");
    const kind: SpendTransitionKind =
      unknown || written.length === 0
        ? "reservation.billing_unknown"
        : written.every((record) => isUncharged(record.billingStatus))
          ? "reservation.released"
          : "reservation.settled";

    const updated = await this.#appendOne(reservation, kind, {
      costIds: written.map((record) => record.costId),
      // Only for the silent case, so an operator reading `budget status` is told why this is
      // unresolved rather than left to infer it from an empty cost list.
      ...(written.length === 0
        ? {
            reason:
              "the dispatch returned no billing observations, so whether it was charged is " +
              "unknown; silence is not evidence that nothing was owed (§19.3)",
          }
        : {}),
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
    options: {
      reason?: string;
      pendingObservations?: readonly PendingObservation[];
      /**
       * Who decided the billing outcome is unknown, when a person did.
       *
       * Absent for the ordinary case — a dispatch that returned without an amount, where the
       * runtime is the only party involved. Present when an operator classified a reservation
       * nothing else could: a process killed mid-dispatch leaves `reserved`, which is neither
       * resolved nor terminal, and only a human can say it is not coming back (#226).
       */
      decidedBy?: ActorRef;
      /** Who wrote it down, where that differs from who decided (ADR-0054). */
      transcription?: { recordedBy: ActorRef; verbatim: string };
    } = {},
  ): Promise<SpendReservation> {
    return this.#appendOne(reservation, "reservation.billing_unknown", {
      costIds: [...costIds],
      ...(options.decidedBy === undefined ? {} : { decidedBy: options.decidedBy }),
      ...(options.transcription === undefined ? {} : { transcription: options.transcription }),
      // Why it is unresolved, in the operator's terms. `budget status` surfaces this, because
      // "non-retryable" with no reason gives a human nothing to act on — and a paid dispatch that
      // came back silent is a different problem from one that threw.
      ...(options.reason === undefined ? {} : { reason: options.reason }),
      // Which charges are unrecorded, structurally. There is deliberately no companion count:
      // the length is the count, and two records of one fact is how they come to disagree.
      ...(options.pendingObservations === undefined
        ? {}
        : { pendingObservations: [...options.pendingObservations] }),
    });
  }

  /**
   * Observations still awaiting a record, from the transition stream (#155 step 5).
   *
   * The last `billing_unknown` states what was pending when settlement failed; every reconciliation
   * decision naming one removes it. Derived rather than stored, so the two cannot drift.
   */
  #pendingObservations(
    transitions: readonly SpendReservationTransition[],
    reservationId: string,
  ): readonly PendingObservation[] {
    const declared = this.#declaredObservations(transitions, reservationId);
    const resolvedIds = new Set(
      transitions
        .filter(
          (transition) =>
            transition.reservationId === reservationId &&
            transition.kind === "reservation.reconciled",
        )
        .map((transition) => transition.detail["observationId"])
        .filter((value): value is string => typeof value === "string"),
    );
    return declared.filter((observation) => !resolvedIds.has(observation.observationId));
  }

  /**
   * The observations the last `billing_unknown` declared unrecorded, **before** subtracting
   * decisions (#152).
   *
   * The source of attribution for a resume. A decision's transition is durable before its cost
   * write — deliberately, so the human's finding survives a failed write — which means every retry
   * re-enters with its own observation already subtracted from the *pending* list. Deriving the
   * covered observation from that recomputed list refused a decision the runtime had already
   * accepted, and the charge it named could then never be recorded at all.
   */
  #declaredObservations(
    transitions: readonly SpendReservationTransition[],
    reservationId: string,
  ): readonly PendingObservation[] {
    return (
      transitions
        .filter(
          (transition) =>
            transition.reservationId === reservationId &&
            transition.kind === "reservation.billing_unknown",
        )
        .map((transition) => transition.detail["pendingObservations"])
        .filter((value): value is PendingObservation[] => Array.isArray(value))
        .at(-1) ?? []
    );
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
          // A recorded decision is not a completed one. A terminal reconciliation whose cost write
          // failed is durable and *not* finished — describing it as completed while the
          // reservation is still `billing_unknown` would tell an operator the matter is closed.
          outcome:
            transition.kind === "reservation.investigation_recorded"
              ? ("audit_only" as const)
              : reservation.status === "billing_unknown"
                ? ("decision_recorded" as const)
                : ("completed" as const),
        }));
      const reservationCosts = costs.filter(
        (record) => record.reservationId === reservation.reservationId,
      );
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
        unquantifiedUnknownBillingCount: reservationCosts.filter(
          (record) =>
            record.billingStatus === "unknown" &&
            // Regardless of an estimate. §19.3 is explicit that an estimate does not resolve an
            // unknown charge, and requiring both to be absent counted an estimated-but-unknown
            // record as quantified.
            record.actual === undefined,
        ).length,
        reconciliationHistory: history,
        durableCosts: reservationCosts.map((record) => ({
          costId: record.costId,
          provider: record.provider,
          operation: record.operation,
        })),
        pendingObservations: this.#pendingObservations(
          byGrant.get(reservation.grantId)?.transitions ?? [],
          reservation.reservationId,
        ),
        ...(unresolvedReason === undefined ? {} : { unresolvedReason }),
      };
    });
  }

  /**
   * What this workspace's reservation store establishes about a stuck stage's dispatch window
   * (ADR-0044; `docs/design/spend-reservation-store.md` §5; #244).
   *
   * Reads **every** grant stream this Run touches and applies the Core rule to the aggregate. Two
   * reasons it cannot be narrower: `reserve` resolves idempotency per grant stream, so one
   * `effectKey` may hold a reservation in each of two grants; and a reservation keeps the
   * `attemptId` of the attempt that first reserved the effect, so the stuck attempt's id is not a
   * key that finds it.
   *
   * **Throws on an unreadable or corrupt stream, deliberately.** Answering "no reservations" for a
   * store this could not read is the failure the whole distinction exists to prevent, so what a
   * failed read means is the caller's decision to make and not a value this returns.
   *
   * @throws {AldusError} when a grant stream cannot be read or is corrupt.
   */
  async stageDispatchEvidence(runId: string, stageId: string): Promise<StageDispatchEvidence> {
    const reservations = await this.#store.listByRun(runId);
    // Sorted so the aggregate stream is the same on every read of an unchanged store; the rule is
    // order-independent, and an answer that depends on directory order is not one worth trusting.
    const grantIds = [...new Set(reservations.map((reservation) => reservation.grantId))].sort();
    const transitions: SpendReservationTransition[] = [];
    for (const grantId of grantIds) {
      transitions.push(...(await this.#store.readGrant(grantId)).transitions);
    }
    return stageDispatchEvidence(transitions, { runId, stageId });
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
    if (
      input.transcription !== undefined &&
      input.transcription.recordedBy.kind === authority.actor.kind &&
      input.transcription.recordedBy.id === authority.actor.id
    ) {
      throw serviceError(
        ServiceErrorCodes.SPEND_NOT_AUTHORIZED,
        "This reconciliation records the decider as its own transcriber. A transcription exists " +
          "to say someone else wrote the record down; naming the same actor for both says nothing " +
          "and makes the field unreadable where it is real (§19.2).",
        {
          category: "validation",
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

    // Resumable by design (#155 step 5). The decision transition is identified by the decision,
    // not by its kind, so retrying the same decision after a failed cost write re-appends nothing
    // and continues from where it stopped. A *different* decision, or the same id carrying
    // different contents, conflicts rather than overwriting.
    const stream = await this.#store.readGrant(current.grantId);
    const pending = this.#pendingObservations(stream.transitions, current.reservationId);
    // **This decision**, by its own stable transition id, looked up first and unconditionally.
    //
    // Scoping the lookup to the pending case was wrong for the sequence it was meant to serve:
    // once the last observation is resolved nothing is pending, so the fallback below took the
    // *first* reconciliation on the reservation. With A resolved by `dec-a` and B terminally
    // resolved by `dec-b`, retrying `dec-b` compared its digest against `dec-a`'s and was refused
    // — the retry path failing precisely in the multi-observation case it exists for.
    const priorById = stream.transitions.find(
      (transition) =>
        transition.reservationId === current.reservationId &&
        transition.transitionId === `${current.reservationId}:reconciled:${input.decisionId}`,
    );

    // Only when nothing is pending does an *unrelated* decision conflict. While observations are
    // unrecorded a second decision is a second charge rather than a rewrite of the first; once
    // none are, a different decision would overwrite a human's recorded finding. Either way a
    // reused id carrying changed contents is refused by digest before any effect.
    const priorDecision =
      priorById ??
      (pending.length === 0
        ? stream.transitions.find(
            (transition) =>
              transition.reservationId === current.reservationId &&
              transition.kind === "reservation.reconciled",
          )
        : undefined);

    // Every field a decision consists of, canonicalised. Comparing only the id let a retry reuse
    // one decision's identity while carrying a different amount — or turn `settled_with_amount`
    // into `released_as_uncharged` — and the resume path would skip the durable append and execute
    // the new payload. Same id and identical payload resumes; same id and anything changed
    // conflicts.
    const decisionDigest = digestJson({
      decisionId: input.decisionId,
      resolution: input.resolution.kind,
      evidenceRef: input.evidenceRef,
      decidedBy: { kind: authority.actor.kind, id: authority.actor.id },
      amount: input.resolution.kind === "settled_with_amount" ? input.resolution.amount : null,
      provider:
        input.resolution.kind === "settled_with_amount"
          ? (input.resolution.provider ?? null)
          : null,
      billedOperation:
        input.resolution.kind === "settled_with_amount"
          ? (input.resolution.billedOperation ?? null)
          : null,
      observationId:
        input.resolution.kind === "investigation_ended"
          ? null
          : (input.resolution.observationId ?? null),
    });

    const decisionDetail: Record<string, unknown> = {
      ...(input.transcription === undefined
        ? {}
        : {
            // Who wrote it down, and what they were told. Recorded beside `decidedBy` rather than
            // replacing it, so the two readings stop being one record (ADR-0054).
            recordedBy: {
              kind: input.transcription.recordedBy.kind,
              id: input.transcription.recordedBy.id,
            },
            verbatim: input.transcription.verbatim,
          }),
      decisionId: input.decisionId,
      decisionDigest,
      resolution: input.resolution.kind,
      evidenceRef: input.evidenceRef,
      decidedBy: { kind: authority.actor.kind, id: authority.actor.id },
      // Recorded on the transition because `#pendingObservations` subtracts by it: a decision that
      // resolves observation A must remove A and nothing else. On **both** terminal arms — a
      // release that did not record which observation it covered left the whole pending list
      // standing, so the reservation could never reach a terminal state.
      ...(input.resolution.kind !== "investigation_ended" &&
      input.resolution.observationId !== undefined
        ? { observationId: input.resolution.observationId }
        : {}),
      ...(input.resolution.kind === "settled_with_amount"
        ? {
            amount: input.resolution.amount,
            ...(input.resolution.provider === undefined
              ? {}
              : { provider: input.resolution.provider }),
            ...(input.resolution.billedOperation === undefined
              ? {}
              : { billedOperation: input.resolution.billedOperation }),
          }
        : {}),
    };

    // Compared *before* any effect: a changed payload must be refused before a cost is written or
    // a lifecycle transition appended.
    if (priorDecision !== undefined) {
      const priorId = priorDecision.detail["decisionId"];
      const priorDigest = priorDecision.detail["decisionDigest"];
      if (priorId !== input.decisionId || priorDigest !== decisionDigest) {
        throw serviceError(
          ServiceErrorCodes.SPEND_NOT_AUTHORIZED,
          `Reservation "${current.reservationId}" already carries reconciliation decision ` +
            `"${String(priorId)}". A different decision — or the same identity carrying different ` +
            "contents — would overwrite a human's recorded finding rather than resuming it " +
            "(ADR-0044).",
          {
            category: "conflict",
            retryable: false,
            details: { reservationId: current.reservationId },
          },
        );
      }
    }

    // Only now, because a decision that is already durable must resume rather than be refused for
    // the state it *itself* produced. A retry across a dropped connection sees the reservation
    // terminal and would otherwise be told a terminal reservation never resumes — true of a new
    // decision, and wrong about a repeat of the recorded one.
    if (current.status !== "billing_unknown") {
      if (priorDecision !== undefined) {
        const durable = (await this.#costs.list(current.runId)).filter(
          (entry) => entry.reservationId === current.reservationId,
        );
        const settledId =
          input.resolution.kind === "settled_with_amount"
            ? (input.resolution.observationId ?? `${current.reservationId}:reconciled`)
            : undefined;
        return {
          reservation: current,
          costs: durable.filter((entry) => entry.costId === settledId),
        };
      }
      throw serviceError(
        ServiceErrorCodes.SPEND_NOT_AUTHORIZED,
        `Reservation "${current.reservationId}" is "${current.status}" and only an ` +
          "unresolved charge can be reconciled. " +
          // Two different refusals, because they are two different situations and the operator's
          // next move differs. Saying "a terminal reservation never resumes" of a `reserved` one
          // was false about the reservation it was printed on — `reserved` is not terminal, it is
          // stuck — and it named no verb the state would accept (#226).
          (current.status === "reserved"
            ? "This one is not terminal: it is still reserved, so a billing outcome was never " +
              "recorded — most often a process killed mid-dispatch. `aldus costs abandon` " +
              "records that it is not coming back, after which it can be reconciled."
            : "A terminal reservation never resumes (ADR-0044)."),
        {
          category: "conflict",
          retryable: false,
          details: { reservationId: reservation.reservationId },
        },
      );
    }

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

    let covered: PendingObservation | undefined;
    const alreadyNamed = priorDecision?.detail["observationId"];
    if (typeof alreadyNamed === "string") {
      // A resume. This decision already named its observation and that naming is durable, so the
      // pending list has subtracted it — re-validating against that list refuses a decision the
      // runtime accepted, and the charge it named could then never be recorded while the terminal
      // projection still presented itself as the whole lineage.
      //
      // Reaching here with a prior decision means `priorById` matched *and* the digest matched, so
      // this is the same decision rather than a different one wearing its id.
      covered = this.#declaredObservations(stream.transitions, current.reservationId).find(
        (entry) => entry.observationId === alreadyNamed,
      );
      if (covered === undefined) {
        throw serviceError(
          ServiceErrorCodes.SPEND_NOT_AUTHORIZED,
          `Reservation "${current.reservationId}" carries decision "${input.decisionId}" naming ` +
            `observation "${alreadyNamed}", and no unrecorded observation by that identity was ` +
            "ever declared. The decision and the reservation describe different charges (#152).",
          {
            category: "conflict",
            retryable: false,
            details: { reservationId: current.reservationId },
          },
        );
      }
    } else if (pending.length > 0) {
      const named = input.resolution.observationId;
      if (named === undefined) {
        throw serviceError(
          ServiceErrorCodes.SPEND_NOT_AUTHORIZED,
          `Reservation "${current.reservationId}" has ${pending.length} unrecorded billing ` +
            `observation(s) — ${pending.map((entry) => entry.observationId).join(", ")} — and a ` +
            "terminal decision must name which one it covers. Resolving them together would " +
            "attribute several providers' charges to one of them, and would let a finding about " +
            "one restore authorization while the others are still unaccounted for (#152).",
          {
            category: "validation",
            retryable: false,
            details: { reservationId: current.reservationId },
          },
        );
      }
      covered = pending.find((entry) => entry.observationId === named);
      if (covered === undefined) {
        throw serviceError(
          ServiceErrorCodes.SPEND_NOT_AUTHORIZED,
          `Observation "${named}" is not awaiting a record on reservation ` +
            `"${current.reservationId}". Either it was already resolved — in which case resolving ` +
            "it again would double-count a durable record — or it never existed (#152).",
          {
            category: "conflict",
            retryable: false,
            details: { reservationId: current.reservationId },
          },
        );
      }
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

    // Which unrecorded charge this decision covers, required of **either** terminal resolution.
    //
    // It was previously checked only inside `settled_with_amount`, so `released_as_uncharged`
    // appended one finding and released the whole reservation — one human's conclusion about
    // observation A restoring authorization while B was still unaccounted for.
    //
    // Who charged comes from the named observation rather than from the operator. Two pending
    // observations can have two providers, and a decision naming neither would resolve "the
    // remainder" against one arbitrary provider.
    // A record is written only by a settlement. `released_as_uncharged` is positive evidence that
    // nothing was charged, so it produces no record — and, when it names a pending observation,
    // resolves exactly that one.
    let record: CostRecord | undefined;
    if (input.resolution.kind === "settled_with_amount") {
      // With nothing pending the record already exists and only its amount is unknown, so provider
      // and operation are preserved from it. Where neither source has them, the evidence must
      // supply them — Aldus does not invent a provider to fill a required field.
      const linked =
        covered === undefined
          ? (await this.#costs.list(current.runId)).find(
              (entry) =>
                entry.reservationId === current.reservationId && entry.billingStatus === "unknown",
            )
          : undefined;
      const provider = covered?.provider ?? linked?.provider ?? input.resolution.provider;
      const operation = covered?.operation ?? linked?.operation ?? input.resolution.billedOperation;
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

      // A resolved pending observation keeps its own identity, so the record that settles it lands
      // where its failed write would have — one record per observation, and a repeat of the same
      // decision writes the same id rather than adding a second.
      record = {
        schemaVersion: SCHEMA_VERSION,
        costId: covered?.observationId ?? `${current.reservationId}:reconciled`,
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
    }

    // Terminal only when nothing is left unrecorded. Resolving observation A while B is still
    // pending would release authorization for a charge nobody has accounted for — the
    // release-before-durable ordering ADR-0044 forbids, one observation over.
    const remaining = pending.filter((entry) => entry.observationId !== covered?.observationId);
    if (remaining.length > 0) {
      return { reservation: audited, costs: record === undefined ? [] : [record] };
    }

    // The terminal transition describes the **whole** reservation, from every durable billing fact
    // linked to it. Writing `costIds: [thisCostId]` lost the earlier ones: `reduceReservations`
    // replaces the array rather than merging, so records that survived a partial settlement
    // disappeared from the canonical projection the moment the last one was reconciled.
    const durable = (await this.#costs.list(current.runId)).filter(
      (entry) => entry.reservationId === current.reservationId,
    );
    const costIds = [...new Set(durable.map((entry) => entry.costId))];

    // `released` means no charge occurred. A reservation where observation A was durably charged
    // and B was later proven uncharged is `settled` — describing it as released would say the
    // money came back.
    //
    // A whole-reservation `released_as_uncharged` is the exception and keeps its meaning: it is a
    // human establishing that the one unresolved charge never happened, and the record standing
    // against it is the unmeasured one their evidence disposes of.
    const wholeReservation = covered === undefined;
    const anyCharge = durable.some(
      (entry) => entry.billingStatus !== "free" && entry.billingStatus !== "voided",
    );
    const kind: SpendTransitionKind =
      input.resolution.kind === "released_as_uncharged" && wholeReservation
        ? "reservation.released"
        : anyCharge
          ? "reservation.settled"
          : "reservation.released";

    const terminal = await this.#appendOne(audited, kind, {
      costIds,
      ...(kind === "reservation.released"
        ? { reason: `reconciled as uncharged: ${input.evidenceRef}` }
        : {}),
    });
    return { reservation: terminal, costs: record === undefined ? [] : [record] };
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
      // An explicit transition id names one decision, and re-recording that decision must be a
      // no-op rather than a conflict. `#transition` stamps a fresh `at`, so a byte comparison in
      // the store sees the same identity carrying different content and refuses — which turned a
      // retry across an advancing clock into a permanent failure. Presence plus an identical
      // payload is a resume; presence plus a changed payload is still refused, because that is a
      // second decision wearing the first one's identity.
      if (transitionId !== undefined) {
        const existing = stream.transitions.find(
          (transition) => transition.transitionId === transitionId,
        );
        if (existing !== undefined) {
          // The detail only, never the transition: `at` is the clock reading that made an
          // identical decision compare unequal in the first place.
          if (digestJson(existing.detail) !== digestJson(detail)) {
            throw serviceError(
              ServiceErrorCodes.SPEND_NOT_AUTHORIZED,
              `Transition "${transitionId}" already exists on reservation ` +
                `"${current.reservationId}" carrying different contents. Re-recording the same ` +
                "decision resumes; changing what it says would overwrite a durable finding " +
                "(ADR-0044).",
              {
                category: "conflict",
                retryable: false,
                details: { reservationId: current.reservationId },
              },
            );
          }
          return current;
        }
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

  /**
   * Read one reservation back.
   *
   * Public because a console needs the record to reconcile it and had no way to obtain one:
   * `status` returns a projection and `reconcile` takes the record. That gap is part of why the
   * reconciliation path existed and nothing could reach it (#215).
   */
  readReservation(grantId: string, reservationId: string): Promise<SpendReservation> {
    return this.#require(grantId, reservationId);
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
