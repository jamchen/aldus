/**
 * Cost records (architecture contract §19.3, §15).
 */

import { z } from "zod";
import { iso8601, moneySchema, nonEmptyString, schemaVersionString } from "./common.js";

/**
 * Billing state of a cost record (contract §19.3).
 *
 * `unknown` exists because contract §19.3 requires "safe handling of unknown provider billing
 * status": a request whose billing outcome could not be confirmed must be representable, or
 * implementations will guess — and a guess that under-reports spend defeats the stop-on-budget
 * behaviour the same section requires.
 */
export const BILLING_STATUSES = ["estimated", "charged", "free", "unknown", "voided"] as const;

/** @see BILLING_STATUSES */
export type BillingStatus = (typeof BILLING_STATUSES)[number];

/**
 * A unit of consumption, e.g. characters synthesised or seconds rendered (contract §19.3).
 */
export const costQuantitySchema = z
  .object({
    /**
     * Unit of measure.
     *
     * An OPEN string. Contract §4.2 keeps provider semantics out of Core, and what a provider
     * bills by is a provider's business.
     */
    unit: nonEmptyString,
    /** Quantity consumed in `unit`. */
    amount: z.number().min(0),
  })
  .meta({
    id: "CostQuantity",
    title: "CostQuantity",
    description:
      "A unit of consumption underlying a cost (architecture contract §19.3). `unit` is an open " +
      "string because what a provider bills by belongs to the provider, not to Core (§4.2).",
  });

/** @see costQuantitySchema */
export type CostQuantity = z.infer<typeof costQuantitySchema>;

/**
 * A recorded or projected cost attributable to a Run (contract §19.3, §15).
 *
 * The contract does not give a field list for this type; the shape below is decided in GitHub
 * issue #1, driven by the six capabilities contract §19.3 requires of cost-incurring stages.
 */
export const costRecordSchema = z
  .object({
    /** Schema version of this record (ADR-0003). */
    schemaVersion: schemaVersionString,
    /** Identity of this cost record. */
    costId: nonEmptyString,
    /**
     * Run this cost is attributable to.
     *
     * Added beyond the contract's prose: contract §6's class diagram makes CostRecord a child of
     * ProductionRun, and per-run spend limits (§19.3) cannot be computed without this edge.
     */
    runId: nonEmptyString,
    /** Stage that incurred the cost, if attributable to one. */
    stageId: nonEmptyString.optional(),
    /** Attempt that incurred the cost, if attributable to one. */
    attemptId: nonEmptyString.optional(),
    /**
     * Which provider was billed.
     *
     * An OPEN string, never a Core-defined enum. Contract §4.2 states Core does not own a
     * particular TTS voice or model, and contract §1.2 rules out prescribing any one provider.
     * Do not narrow this to a union.
     */
    provider: nonEmptyString,
    /**
     * Which operation was billed, e.g. a synthesis request or a render.
     *
     * An OPEN string, for the same reason as `provider`. Do not narrow this to a union.
     */
    operation: nonEmptyString,
    /** What was consumed, where the provider exposes a billable quantity. */
    quantity: costQuantitySchema.optional(),
    /** Projected cost before execution (contract §19.3 "dry-run or cost preview where possible"). */
    estimated: moneySchema.optional(),
    /** Cost actually incurred (contract §19.3 "actual cost recording"). */
    actual: moneySchema.optional(),
    /** Billing state. @see BILLING_STATUSES */
    billingStatus: z.enum(BILLING_STATUSES),
    /**
     * The `GateDecision` that authorised this spend (contract §13.2).
     *
     * Contract §13.2 forbids paid synthesis before an operator approves a maximum authorised
     * cost; this field is how an incurred cost is traced back to that authorization.
     */
    authorizationId: nonEmptyString.optional(),
    /** Provider-side request identifier, for reconciliation (contract §15). */
    providerRequestId: nonEmptyString.optional(),
    /** When this record was written. */
    recordedAt: iso8601,
  })
  .refine((record) => record.estimated !== undefined || record.actual !== undefined, {
    message:
      "at least one of `estimated` or `actual` must be present (architecture contract §19.3: a cost record must state either a preview or an incurred amount).",
    path: ["actual"],
  })
  .meta({
    id: "CostRecord",
    title: "CostRecord",
    description:
      "A recorded or projected cost attributable to a Run (architecture contract §19.3, §15). " +
      "ADDITIONAL CONSTRAINT NOT EXPRESSIBLE IN JSON SCHEMA: at least one of `estimated` or " +
      "`actual` must be present — a cost record that states neither carries no information and " +
      "would silently under-report spend against a budget. Validators generated from this " +
      "schema will NOT enforce that; the normative Zod schema does. `provider` and `operation` " +
      "are open strings because Core names no provider (§4.2). `billingStatus: unknown` exists " +
      "so an unconfirmed billing outcome is representable rather than guessed (§19.3).",
  });

/** @see costRecordSchema */
export type CostRecord = z.infer<typeof costRecordSchema>;
