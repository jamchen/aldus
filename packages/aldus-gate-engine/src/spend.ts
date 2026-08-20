/**
 * Spend grants and stop-on-budget (architecture contract §19.3, §13.2).
 *
 * §19.3 requires cost-incurring stages to support per-request and per-run limits, explicit spend
 * authorization, stop-on-budget behaviour, and safe handling of unknown provider billing status.
 * §13.2 adds that paid TTS must not run until the operator has approved a **maximum authorized
 * cost**, and that the authorization is void if any bound value changes.
 *
 * Those two requirements pull in different directions, and reconciling them is the whole design
 * problem here. Enforcing a limit needs the limit's *value*; binding it needs its *digest*, and
 * `GateDecision` stores only digests. Carrying the limit in a record beside the decision would
 * let someone raise the ceiling without touching the approval.
 *
 * So a grant does both: it holds the values, and {@link grantLimitsDigest} is included among the
 * gate's bound subjects. Raising a limit changes that digest, which drifts from `subjectHashes`,
 * which voids the authorization exactly as §13.2 requires. The ceiling cannot move without an
 * operator re-approving it.
 */

import {
  reservationExposureIsBounded,
  reservationIsActive,
  type CostRecord,
  type Money,
  type SpendReservation,
} from "@aldus-runtime/core";

import { digestSubjectValue } from "./binding.js";
import {
  addMoney,
  compareMoney,
  formatMoney,
  isNegativeMoney,
  subtractMoney,
  zeroMoney,
} from "./money.js";

/**
 * The subject key under which a grant's limits are bound.
 *
 * A conventional default. A gate definition may bind the limits under any key it likes — §4.3
 * leaves gate composition to adopters — but a shared default means the common case needs no
 * configuration.
 */
export const SPEND_LIMIT_SUBJECT_KEY = "spendLimit";

/** An operator's explicit authorization to spend, bound to a gate decision (§13.2, §19.3). */
export interface SpendGrant {
  /** Identity of this grant. */
  grantId: string;
  /** Run the grant applies to. */
  runId: string;
  /** Gate whose approval established the grant. */
  gateId: string;
  /**
   * The `GateDecision.decisionId` that authorized this spend.
   *
   * `CostRecord.authorizationId` carries the same value, which is what links an incurred cost
   * back to the approval that permitted it (§19.3 "explicit spend authorization").
   */
  decisionId: string;
  /** Maximum total spend authorized across the Run (§13.2 "maximum authorized cost"). */
  maxTotal: Money;
  /** Maximum spend authorized for any single request (§19.3 "per-request ... limits"). */
  maxPerRequest?: Money;
}

/**
 * The digest a gate must bind for the grant's limits to be tamper-evident.
 *
 * Only the limits are digested, not the grant's identity: re-issuing an identical ceiling under a
 * new `grantId` should not read as the operator having approved something different.
 */
export function grantLimitsDigest(grant: SpendGrant): string {
  return digestSubjectValue({
    maxTotal: grant.maxTotal,
    maxPerRequest: grant.maxPerRequest ?? null,
  });
}

/**
 * Whether a cost record consumes budget.
 *
 * `voided` is excluded because a voided charge did not happen. **Everything else counts,
 * including `unknown`** — §19.3 requires safe handling of an unconfirmed billing status, and the
 * only safe direction is to assume an unconfirmed charge landed. Treating `unknown` as free would
 * let a run whose provider never confirmed quietly spend past its ceiling, which is precisely the
 * failure stop-on-budget exists to prevent.
 */
export function consumesBudget(record: CostRecord): boolean {
  return record.billingStatus !== "voided";
}

/**
 * What one cost record draws against a grant.
 *
 * The actual charge when known, the estimate otherwise. An estimate is the best available
 * evidence that money is committed, and ignoring it until confirmation arrives would let a burst
 * of in-flight requests overshoot a ceiling that looked untouched.
 */
export function costRecordDraw(record: CostRecord, currency: string): Money {
  if (!consumesBudget(record)) return zeroMoney(currency);
  return record.actual ?? record.estimated ?? zeroMoney(currency);
}

/** How much of a grant has been drawn, and by what. */
export interface SpendLedger {
  /** Total drawn against the grant. */
  consumed: Money;
  /** Remaining headroom. Never negative — see {@link SpendLedger.overspent}. */
  remaining: Money;
  /** True if recorded costs already exceed the ceiling. */
  overspent: boolean;
  /** Cost records counted, in the order supplied. */
  counted: CostRecord[];
  /** Cost records excluded because they were voided. */
  excluded: CostRecord[];
  /**
   * Charges whose amount nobody knows yet (§19.3; #150).
   *
   * A provider may charge a request and withhold or delay the figure. While one of these stands
   * against a grant, **Aldus cannot prove how much authorization remains** — the charge is real
   * and its size is not yet a fact.
   *
   * A record here is never treated as free, voided, or a zero draw. Zero is a numerical assertion;
   * this is an uncertainty state, and the two are not interchangeable.
   */
  unresolvedUnknown: CostRecord[];
  /**
   * Whether {@link SpendLedger.remaining} is a number anyone may spend against.
   *
   * `false` while any unresolved unknown charge stands. `remaining` still reports the arithmetic
   * over what is known, because an operator wants the figure — but presenting it as headroom
   * would state a safe amount that nothing establishes.
   */
  remainingIsDeterminate: boolean;
}

/**
 * Whether a record is a charge of unknown size (§19.3; #150).
 *
 * An estimate does not resolve it. An estimate is evidence about what a request was expected to
 * cost, and the ruling on #150 is explicit that it does not confirm the final charge — so a record
 * carrying both an estimate and `billingStatus: "unknown"` is still unresolved.
 */
export function isUnresolvedUnknownCharge(record: CostRecord): boolean {
  return record.billingStatus === "unknown";
}

/**
 * Total what has been drawn against a grant.
 *
 * Only records naming this grant's `decisionId` in `authorizationId` are counted. A cost with no
 * authorization, or one pointing at a different decision, is not this grant's business — and
 * silently absorbing it would make one gate's ceiling depend on another's spending.
 */
export function computeLedger(grant: SpendGrant, costs: readonly CostRecord[]): SpendLedger {
  const currency = grant.maxTotal.currency;
  const mine = costs.filter((record) => record.authorizationId === grant.decisionId);
  const counted: CostRecord[] = [];
  const excluded: CostRecord[] = [];
  let consumed = zeroMoney(currency);

  for (const record of mine) {
    if (!consumesBudget(record)) {
      excluded.push(record);
      continue;
    }
    counted.push(record);
    consumed = addMoney(consumed, costRecordDraw(record, currency));
  }

  const headroom = subtractMoney(grant.maxTotal, consumed);
  const overspent = isNegativeMoney(headroom);
  const unresolvedUnknown = counted.filter(isUnresolvedUnknownCharge);
  return {
    consumed,
    remaining: overspent ? zeroMoney(currency) : headroom,
    overspent,
    counted,
    excluded,
    unresolvedUnknown,
    remainingIsDeterminate: unresolvedUnknown.length === 0,
  };
}

/**
 * Authorization available to commit, derived rather than maintained (ADR-0044; #155).
 *
 * ```text
 * available = authorized maximum − settled charges − active reservations
 * ```
 *
 * Derived on every read, never stored as a balance. A maintained counter is a second source of
 * truth about money, reconciled by hand against the records it summarises — and every defect this
 * repository has fixed in the cost path has been a value asserting more than what established it.
 */
export interface SpendAvailability {
  /** The ceiling the operator approved. */
  authorized: Money;
  /** Charges already recorded against it. */
  settled: Money;
  /** Authorization committed to effects that have not settled. */
  reserved: Money;
  /**
   * What may still be committed. Never negative.
   *
   * **Read {@link SpendAvailability.determinate} before spending against this.** The figure is the
   * arithmetic over what is known, and while an unresolved charge of unknown size stands, what is
   * known is not all there is.
   */
  available: Money;
  /** Whether {@link SpendAvailability.available} is an amount anyone may commit against. */
  determinate: boolean;
  /**
   * Why it is not, where it is not.
   *
   * Two independent sources, kept apart because they carry different evidence:
   *
   * - reservations in `billing_unknown` whose exposure is not bounded by an enforced ceiling;
   * - cost records of unknown size with no reservation at all, which is every such record written
   *   before this protocol existed (#150).
   */
  indeterminate: {
    unboundedReservations: SpendReservation[];
    unreservedUnknownCharges: CostRecord[];
  };
  /**
   * Reserved-but-unsettled amounts, per **authorization** currency (ADR-0044).
   *
   * Not the provider's billing currency. This states what Aldus set aside; what a provider charged,
   * and in what currency, is a separate fact that may not exist yet. A report may say "USD 2.00
   * remains reserved because billing is unresolved"; it must never restate that as "the provider
   * made an unknown USD charge".
   */
  reservedUnknownByCurrency: Record<string, string>;
}

/**
 * Derive what a grant still authorizes (§19.3; ADR-0044).
 *
 * Composes with #150 rather than replacing it. A charge of unknown size still makes the grant
 * indeterminate — what a reservation adds is the possibility of a *bound*, and only when the
 * execution that produced the charge was actually dispatched under an enforced ceiling. A backend
 * that declares enforcement today is not evidence about a request dispatched by an earlier version
 * (ADR-0030).
 */
export function availableAuthorization(
  grant: SpendGrant,
  costs: readonly CostRecord[],
  reservations: readonly SpendReservation[] = [],
): SpendAvailability {
  const currency = grant.maxTotal.currency;
  const ledger = computeLedger(grant, costs);

  const mine = reservations.filter(
    (reservation) => reservation.authorizationId === grant.decisionId,
  );
  const active = mine.filter(reservationIsActive);

  // Settled reservations are already represented by the cost records that settled them. Counting
  // both would double-count the same money against the ceiling.
  let reserved = zeroMoney(currency);
  const reservedUnknownByCurrency = new Map<string, Money>();
  for (const reservation of active) {
    if (reservation.reserved.currency === currency) {
      reserved = addMoney(reserved, reservation.reserved);
    }
    if (reservation.status === "billing_unknown") {
      const running =
        reservedUnknownByCurrency.get(reservation.reserved.currency) ??
        zeroMoney(reservation.reserved.currency);
      reservedUnknownByCurrency.set(
        reservation.reserved.currency,
        addMoney(running, reservation.reserved),
      );
    }
  }

  const unboundedReservations = active.filter(
    (reservation) =>
      reservation.status === "billing_unknown" && !reservationExposureIsBounded(reservation),
  );
  // #150's rule, narrowed by what a reservation can now establish. A record of unknown size whose
  // reservation is bounded is accounted for; one with no reservation is not, and that is every
  // such record written before this protocol.
  const boundedReservationIds = new Set(
    active
      .filter((reservation) => reservationExposureIsBounded(reservation))
      .map((reservation) => reservation.reservationId),
  );
  const unreservedUnknownCharges = ledger.counted.filter(
    (record) =>
      isUnresolvedUnknownCharge(record) &&
      (record.reservationId === undefined || !boundedReservationIds.has(record.reservationId)),
  );

  const headroom = subtractMoney(subtractMoney(grant.maxTotal, ledger.consumed), reserved);
  return {
    authorized: grant.maxTotal,
    settled: ledger.consumed,
    reserved,
    available: isNegativeMoney(headroom) ? zeroMoney(currency) : headroom,
    determinate: unboundedReservations.length === 0 && unreservedUnknownCharges.length === 0,
    indeterminate: { unboundedReservations, unreservedUnknownCharges },
    reservedUnknownByCurrency: Object.fromEntries(
      [...reservedUnknownByCurrency.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([code, money]) => [code, money.amount]),
    ),
  };
}

/** A request to spend against a grant. */
export interface SpendRequest {
  /** The amount about to be committed. */
  amount: Money;
  /** What the spend is for, for the refusal message. An open string (§4.2). */
  operation?: string;
}

/** Why a spend was refused. */
export type SpendRefusalReason =
  | "per-request-limit"
  | "total-limit"
  | "already-overspent"
  | "negative-amount"
  /**
   * A charge of unknown size stands against this grant (§19.3; #150).
   *
   * Refused rather than allowed-with-a-warning: while the size of a real charge is unknown, the
   * remaining headroom is not a fact, and spending against a figure nobody can establish is how a
   * ceiling is exceeded without any single decision being wrong. Resolution is a reconciled amount
   * or a new authorization under an explicit policy — both human acts.
   */
  | "billing-unconfirmed";

/** The outcome of a stop-on-budget check. */
export type SpendCheck =
  | { allowed: true; ledger: SpendLedger; remainingAfter: Money }
  | {
      allowed: false;
      reason: SpendRefusalReason;
      ledger: SpendLedger;
      explanation: string;
    };

/**
 * Decide whether a spend may proceed (§19.3 stop-on-budget).
 *
 * Returns a refusal rather than throwing. A caller needs to *display* why a run stopped — an
 * operator staring at a halted production wants the ceiling and the shortfall, not a stack trace
 * — and the same reasoning ADR-0006 gives for pack resolution applies here.
 *
 * The check is deliberately conservative at every boundary: an exactly-equal request is allowed,
 * but anything beyond is refused, and a grant already overspent refuses everything including a
 * zero-value request, because the correct response to an overspent budget is a new authorization
 * rather than another draw.
 */
export function checkSpend(
  grant: SpendGrant,
  costs: readonly CostRecord[],
  request: SpendRequest,
): SpendCheck {
  const ledger = computeLedger(grant, costs);

  if (isNegativeMoney(request.amount)) {
    return {
      allowed: false,
      reason: "negative-amount",
      ledger,
      explanation:
        `A spend of ${formatMoney(request.amount)} is negative. A refund is recorded as a voided ` +
        "cost record, not as a negative draw, so that the audit trail keeps the original charge.",
    };
  }

  // Before the arithmetic, because the arithmetic is what cannot be trusted. While a charge of
  // unknown size stands against this grant, `remaining` is the total over what is *known* — and
  // spending against it would treat an unresolved charge as a zero draw, which is the one thing
  // the ruling on #150 forbids (§19.3).
  if (!ledger.remainingIsDeterminate) {
    return {
      allowed: false,
      reason: "billing-unconfirmed",
      ledger,
      explanation:
        `${ledger.unresolvedUnknown.length} charge(s) against this authorization have an ` +
        "unconfirmed amount, so the remaining budget is indeterminate rather than " +
        `${formatMoney(ledger.remaining)}. Automatic spend is refused until the amount is ` +
        "reconciled or an operator issues a new authorization: an unknown charge is neither free " +
        "nor zero, and drawing against a figure nobody can establish is how a ceiling is exceeded " +
        "without any single decision being wrong (§19.3).",
    };
  }

  if (ledger.overspent) {
    return {
      allowed: false,
      reason: "already-overspent",
      ledger,
      explanation:
        `Recorded costs of ${formatMoney(ledger.consumed)} already exceed the authorized maximum ` +
        `of ${formatMoney(grant.maxTotal)}. Further spend needs a new authorization (§13.2).`,
    };
  }

  if (grant.maxPerRequest !== undefined && compareMoney(request.amount, grant.maxPerRequest) > 0) {
    return {
      allowed: false,
      reason: "per-request-limit",
      ledger,
      explanation:
        `A single request of ${formatMoney(request.amount)} exceeds the per-request limit of ` +
        `${formatMoney(grant.maxPerRequest)} (§19.3).`,
    };
  }

  const projected = addMoney(ledger.consumed, request.amount);
  if (compareMoney(projected, grant.maxTotal) > 0) {
    return {
      allowed: false,
      reason: "total-limit",
      ledger,
      explanation:
        `Spending ${formatMoney(request.amount)} would bring the total to ` +
        `${formatMoney(projected)}, past the authorized maximum of ` +
        `${formatMoney(grant.maxTotal)}. ${formatMoney(ledger.remaining)} remains (§19.3).`,
    };
  }

  return {
    allowed: true,
    ledger,
    remainingAfter: subtractMoney(grant.maxTotal, projected),
  };
}
