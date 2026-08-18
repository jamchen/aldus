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

import type { CostRecord, Money } from "@aldus/core";

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
  return {
    consumed,
    remaining: overspent ? zeroMoney(currency) : headroom,
    overspent,
    counted,
    excluded,
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
  "per-request-limit" | "total-limit" | "already-overspent" | "negative-amount";

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
