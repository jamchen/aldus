/**
 * Exact decimal arithmetic (architecture contract §19.3).
 *
 * Core models an amount as a decimal string because TTS costs are fractional-cent and IEEE-754
 * accumulation silently corrupts a total. Honouring that decision only pays off if the arithmetic
 * here never reaches for `Number`, so these tests use values chosen to expose it if it ever does.
 */

import { describe, expect, it } from "vitest";

import { GateEngineErrorCodes } from "../src/errors.js";
import {
  addMoney,
  compareMoney,
  formatMoney,
  isNegativeMoney,
  isPositiveMoney,
  subtractMoney,
  sumMoney,
  zeroMoney,
} from "../src/money.js";

const usd = (amount: string) => ({ amount, currency: "USD" });

describe("exactness", () => {
  it("adds the classic float-error pair exactly", () => {
    // 0.1 + 0.2 === 0.30000000000000004 in IEEE-754. A budget check built on that drifts.
    expect(addMoney(usd("0.1"), usd("0.2"))).toEqual(usd("0.3"));
  });

  it("accumulates ten thousand fractional-cent charges without drift", () => {
    // A realistic TTS pattern: many tiny per-request charges against one ceiling.
    const charges = Array.from({ length: 10_000 }, () => usd("0.0001"));
    expect(sumMoney(charges, "USD")).toEqual(usd("1.0000"));
  });

  it("keeps precision beyond what a double can represent", () => {
    const huge = usd("9007199254740993.0001"); // > Number.MAX_SAFE_INTEGER
    expect(addMoney(huge, usd("0.0001"))).toEqual(usd("9007199254740993.0002"));
  });

  it("aligns operands with different scales", () => {
    expect(addMoney(usd("1.5"), usd("0.25"))).toEqual(usd("1.75"));
    expect(subtractMoney(usd("1"), usd("0.001"))).toEqual(usd("0.999"));
  });
});

describe("comparison", () => {
  it("treats trailing zeros as presentation, not difference", () => {
    // Otherwise a budget check would depend on how a provider happened to format its invoice.
    expect(compareMoney(usd("1.5"), usd("1.50"))).toBe(0);
    expect(compareMoney(usd("1.50000"), usd("1.5"))).toBe(0);
  });

  it("orders correctly across scales", () => {
    expect(compareMoney(usd("0.9"), usd("0.10"))).toBe(1);
    expect(compareMoney(usd("0.10"), usd("0.9"))).toBe(-1);
  });

  it("handles negative amounts", () => {
    expect(isNegativeMoney(subtractMoney(usd("1.00"), usd("2.00")))).toBe(true);
    expect(subtractMoney(usd("1.00"), usd("2.00"))).toEqual(usd("-1.00"));
    expect(isPositiveMoney(usd("0"))).toBe(false);
    expect(isPositiveMoney(usd("0.0001"))).toBe(true);
  });

  it("starts from a zero of the right currency", () => {
    expect(zeroMoney("EUR")).toEqual({ amount: "0", currency: "EUR" });
    expect(sumMoney([], "EUR")).toEqual({ amount: "0", currency: "EUR" });
  });
});

describe("refusals", () => {
  it("refuses to combine different currencies", () => {
    // Converting would need a rate this runtime does not hold, and a guessed rate misstates a
    // budget an operator authorised.
    expect(() => addMoney(usd("1.00"), { amount: "1.00", currency: "EUR" })).toThrowError(
      expect.objectContaining({ code: GateEngineErrorCodes.CURRENCY_MISMATCH }) as Error,
    );
    expect(() => compareMoney(usd("1.00"), { amount: "1.00", currency: "EUR" })).toThrowError(
      expect.objectContaining({ code: GateEngineErrorCodes.CURRENCY_MISMATCH }) as Error,
    );
  });

  it.each(["1e5", "1.2.3", "abc", "", " 1.0", "1,000", "Infinity", "NaN"])(
    "refuses the malformed amount %o",
    (amount) => {
      expect(() => addMoney({ amount, currency: "USD" }, usd("0"))).toThrowError(
        expect.objectContaining({ code: GateEngineErrorCodes.MONEY_MALFORMED }) as Error,
      );
    },
  );

  it("formats for an operator message", () => {
    expect(formatMoney(usd("12.34"))).toBe("12.34 USD");
  });
});
