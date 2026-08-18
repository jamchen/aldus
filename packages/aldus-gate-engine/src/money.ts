/**
 * Exact decimal arithmetic on {@link Money}.
 *
 * Contract §19.3 requires per-request and per-run limits, actual cost recording, and
 * stop-on-budget behaviour. All three are comparisons and sums over money, and Core deliberately
 * models an amount as a decimal *string* because TTS costs are fractional-cent and IEEE-754
 * accumulation silently corrupts the totals an operator authorises spend against.
 *
 * Honouring that decision means never converting an amount to `number`. Every operation here
 * scales both operands to a common exponent and works in `bigint`, so a sum of ten thousand
 * ten-thousandth-of-a-cent charges is exact rather than approximately exact.
 */

import type { Money } from "@aldus-runtime/core";

import { GateEngineErrorCodes, gateEngineError } from "./errors.js";

/** Matches Core's `decimalAmount`: an optionally signed integer with an optional fraction. */
const DECIMAL_PATTERN = /^-?\d+(\.\d+)?$/;

/** A decimal parsed into an integer significand and a decimal exponent. */
interface Decimal {
  /** The value scaled by `10 ** scale`. */
  units: bigint;
  /** Number of fractional digits. */
  scale: number;
}

function parseDecimal(amount: string, context: Record<string, unknown> = {}): Decimal {
  if (!DECIMAL_PATTERN.test(amount)) {
    throw gateEngineError(
      GateEngineErrorCodes.MONEY_MALFORMED,
      `Monetary amount "${amount}" is not a decimal string. Amounts are exact decimals, never ` +
        "floating-point (contract §19.3).",
      { category: "validation", details: { amount, ...context } },
    );
  }
  const [whole = "0", fraction = ""] = amount.split(".");
  const negative = whole.startsWith("-");
  const digits = `${whole.replace("-", "")}${fraction}`;
  const units = BigInt(digits) * (negative ? -1n : 1n);
  return { units, scale: fraction.length };
}

/** Rescale two decimals to a common exponent so they can be added or compared exactly. */
function align(a: Decimal, b: Decimal): { a: bigint; b: bigint; scale: number } {
  const scale = Math.max(a.scale, b.scale);
  return {
    a: a.units * 10n ** BigInt(scale - a.scale),
    b: b.units * 10n ** BigInt(scale - b.scale),
    scale,
  };
}

function formatDecimal(units: bigint, scale: number): string {
  if (scale === 0) return units.toString();
  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(scale + 1, "0");
  const whole = digits.slice(0, digits.length - scale);
  const fraction = digits.slice(digits.length - scale);
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw gateEngineError(
      GateEngineErrorCodes.CURRENCY_MISMATCH,
      `Cannot combine ${a.currency} with ${b.currency}. Converting between currencies would ` +
        "require a rate this runtime does not hold, and a guessed rate would misstate a budget.",
      { category: "validation", details: { left: a.currency, right: b.currency } },
    );
  }
}

/** A zero amount in the given currency. */
export function zeroMoney(currency: string): Money {
  return { amount: "0", currency };
}

/**
 * Sum two amounts exactly.
 *
 * @throws {AldusError} `ALDUS_CURRENCY_MISMATCH` if the currencies differ.
 */
export function addMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  const aligned = align(parseDecimal(a.amount), parseDecimal(b.amount));
  return { amount: formatDecimal(aligned.a + aligned.b, aligned.scale), currency: a.currency };
}

/**
 * Subtract `b` from `a` exactly. The result may be negative.
 *
 * @throws {AldusError} `ALDUS_CURRENCY_MISMATCH` if the currencies differ.
 */
export function subtractMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  const aligned = align(parseDecimal(a.amount), parseDecimal(b.amount));
  return { amount: formatDecimal(aligned.a - aligned.b, aligned.scale), currency: a.currency };
}

/**
 * Total a list of amounts exactly.
 *
 * @throws {AldusError} `ALDUS_CURRENCY_MISMATCH` if the amounts are not all one currency.
 */
export function sumMoney(amounts: readonly Money[], currency: string): Money {
  return amounts.reduce<Money>((total, amount) => addMoney(total, amount), zeroMoney(currency));
}

/**
 * Compare two amounts: `-1` if `a < b`, `0` if equal, `1` if `a > b`.
 *
 * Numerically equal amounts written differently — `"1.5"` and `"1.50"` — compare equal, because
 * trailing zeros are a presentation choice and treating them as a difference would make a budget
 * check depend on how a provider happened to format its invoice.
 *
 * @throws {AldusError} `ALDUS_CURRENCY_MISMATCH` if the currencies differ.
 */
export function compareMoney(a: Money, b: Money): -1 | 0 | 1 {
  assertSameCurrency(a, b);
  const aligned = align(parseDecimal(a.amount), parseDecimal(b.amount));
  if (aligned.a === aligned.b) return 0;
  return aligned.a < aligned.b ? -1 : 1;
}

/** True if the amount is greater than zero. */
export function isPositiveMoney(money: Money): boolean {
  return parseDecimal(money.amount).units > 0n;
}

/** True if the amount is below zero. */
export function isNegativeMoney(money: Money): boolean {
  return parseDecimal(money.amount).units < 0n;
}

/** Validate an amount, raising `ALDUS_MONEY_MALFORMED` if it is not an exact decimal. */
export function assertMoney(money: Money, context?: Record<string, unknown>): Money {
  parseDecimal(money.amount, context);
  return money;
}

/** Render an amount for an operator-facing message. */
export function formatMoney(money: Money): string {
  return `${money.amount} ${money.currency}`;
}
