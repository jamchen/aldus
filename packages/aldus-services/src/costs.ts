/**
 * Cost summarisation (architecture contract §19.3).
 *
 * Separated from the services so the arithmetic is testable without a workspace, and so the one
 * judgement call in it is visible: **unknown billing status is never folded into a total.**
 *
 * §19.3 requires "safe handling of unknown provider billing status". A summary that adds an
 * unconfirmed charge into the same number as a settled one produces a figure that looks
 * authoritative and is not — and the direction of the error is the dangerous one, because an
 * operator reading a total that is lower than reality will authorize more spend.
 */

import type { CostRecord, Money } from "@aldus-runtime/core";
import { addMoney, zeroMoney } from "@aldus-runtime/gate-engine";

import type { CostSummary } from "./reports.js";

/** Statuses that mean money has actually been committed (contract §19.3). */
const CHARGED_STATUSES = new Set(["charged", "unknown"]);

/**
 * Summarise a Run's cost records.
 *
 * A record's `actual` is counted when its billing status says money was committed; otherwise its
 * `estimated` is counted, so an in-flight request is visible against a budget rather than
 * appearing free until it settles. A `voided` record counts as neither: §19.3's ledger is what
 * was spent, and a voided charge was not.
 */
export function summariseCosts(records: readonly CostRecord[]): CostSummary {
  const actual = new Map<string, Money>();
  const estimated = new Map<string, Money>();
  const unknown = new Set<string>();
  let unknownBillingRecordCount = 0;
  let unquantifiedUnknownBillingRecordCount = 0;

  for (const record of records) {
    if (record.billingStatus === "voided" || record.billingStatus === "free") continue;

    if (record.billingStatus === "unknown") {
      unknownBillingRecordCount += 1;
      const currency = record.actual?.currency ?? record.estimated?.currency;
      if (currency !== undefined) unknown.add(currency);
      // A charge whose amount nobody knows and whose currency nobody knows either. It has no
      // `Money` to derive a currency from, so `currenciesWithUnknownBilling` cannot represent it
      // — and a reader relying on that field alone would see an empty list and read it as "no
      // unconfirmed billing" (#150).
      else unquantifiedUnknownBillingRecordCount += 1;
    }

    const committed = CHARGED_STATUSES.has(record.billingStatus) ? record.actual : undefined;
    if (committed !== undefined) {
      accumulate(actual, committed);
      continue;
    }
    if (record.estimated !== undefined) accumulate(estimated, record.estimated);
  }

  return {
    recordCount: records.length,
    actualByCurrency: toAmounts(actual),
    estimatedByCurrency: toAmounts(estimated),
    currenciesWithUnknownBilling: [...unknown].sort(),
    unknownBillingRecordCount,
    unquantifiedUnknownBillingRecordCount,
  };
}

/** Add one amount into a per-currency running total. */
function accumulate(totals: Map<string, Money>, amount: Money): void {
  const running = totals.get(amount.currency) ?? zeroMoney(amount.currency);
  totals.set(amount.currency, addMoney(running, amount));
}

/** Render per-currency totals as decimal strings, currency-sorted for stable output. */
function toAmounts(totals: ReadonlyMap<string, Money>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const currency of [...totals.keys()].sort()) {
    const money = totals.get(currency);
    if (money !== undefined) result[currency] = money.amount;
  }
  return result;
}
