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
/**
 * The billing fields, before the record's own refinements.
 *
 * Named so {@link costObservationSchema} can be **derived** from the same source rather than
 * transcribed beside it. A transcribed copy is a second definition that nothing keeps in step —
 * ADR-0031's case, in a place where the two halves describe money.
 */
const costFields = z.object({
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
  /**
   * The reservation this charge settles (ADR-0044).
   *
   * The other half of `SpendReservation.costIds`, so lineage is navigable from either end —
   * reconciliation starts from whichever record survived.
   *
   * Runtime-supplied, exactly like {@link authorizationId}: a backend that could name its own
   * reservation could name one that did not authorize it. Optional **only** for records written
   * before the reservation protocol existed; absent reads as *predates reservations*, never as
   * *unreserved and therefore unauthorized*.
   */
  reservationId: nonEmptyString.optional(),
  /**
   * The take this charge produced, where it produced one (§15, §19.3; #160).
   *
   * The other direction of `TakeRecord.costIds`, so lineage is navigable from either end. The
   * Runtime **preallocates** the take identity before writing costs, so this is knowable at the
   * moment the charge is recorded rather than only after the take exists.
   *
   * Runtime-supplied like {@link authorizationId} and {@link reservationId}: an adapter that could
   * name its own take could name one that describes different audio.
   */
  takeId: nonEmptyString.optional(),
  /** When this record was written. */
  recordedAt: iso8601,
});

/**
 * The one billing-evidence invariant, applied to every composition (contract §19.3; #150).
 *
 * A charge must state an amount **or** state that the amount is unknown. Those are the two ways a
 * billing fact can be true; a record doing neither carries no information and would silently
 * under-report spend against a budget.
 *
 * `billingStatus: "unknown"` with no amount is the third case, and it is the honest one: a
 * provider may charge a request and withhold or delay the figure. Before #150 that observation was
 * **valid to report and fatal to append** — the observation schema accepted it, the record schema
 * refused it, and reporting it threw away the cost record, the event *and* the completed
 * `AgentResult`, after the money was gone. The record schema's own description said the status
 * existed so an unconfirmed outcome was representable, which is what the refinement beside it made
 * impossible.
 *
 * Shared rather than attached to one composition, because `.pick()` does not carry refinements:
 * deriving the observation from the record's fields while refining only the record is how the two
 * came to disagree by construction.
 */
export function hasBillingEvidence(billing: {
  estimated?: unknown;
  actual?: unknown;
  billingStatus: string;
}): boolean {
  return (
    billing.estimated !== undefined ||
    billing.actual !== undefined ||
    billing.billingStatus === "unknown"
  );
}

/** The message both compositions refuse with, so an operator sees one explanation. */
const BILLING_EVIDENCE_MESSAGE =
  "a charge must state an amount or state that the amount is unknown: at least one of " +
  "`estimated` or `actual` must be present, unless `billingStatus` is `unknown` (architecture " +
  "contract §19.3). Do not substitute a zero — zero is a numerical assertion and an unknown " +
  "amount is an uncertainty state, and they are not interchangeable.";

export const costRecordSchema = costFields
  .refine(hasBillingEvidence, { message: BILLING_EVIDENCE_MESSAGE, path: ["actual"] })
  .meta({
    id: "CostRecord",
    title: "CostRecord",
    description:
      "A recorded or projected cost attributable to a Run (architecture contract §19.3, §15). " +
      "ADDITIONAL CONSTRAINT NOT EXPRESSIBLE IN JSON SCHEMA: a charge must state an amount or " +
      "state that the amount is unknown — at least one of `estimated` or `actual` must be " +
      "present unless `billingStatus` is `unknown`. A record doing neither carries no " +
      "information and would silently under-report spend against a budget. Validators generated " +
      "from this schema will NOT enforce that; the normative Zod schema does. `provider` and `operation` " +
      "are open strings because Core names no provider (§4.2). `billingStatus: unknown` exists " +
      "so an unconfirmed billing outcome is representable rather than guessed (§19.3).",
  });

/** @see costRecordSchema */
export type CostRecord = z.infer<typeof costRecordSchema>;

/**
 * What a backend or Worker knows it was charged (contract §19.3; #107).
 *
 * Derived from {@link costRecordSchema} by picking exactly the billing facts, so the two cannot
 * drift into disagreeing about what a charge is. The complement — `costId`, `runId`, `stageId`,
 * `attemptId`, `authorizationId`, `recordedAt` — is **runtime attribution** and is deliberately
 * absent: the backend reports what was charged, and the Runtime states which Run, Stage, attempt
 * and authorization the charge belongs to.
 *
 * That split is the fix rather than a tidiness. #107 reported an adopter with real agent spend
 * that Aldus could not record; asking each backend to remember to copy an `authorizationId` is
 * the silent budget-bypass class the same issue reported, so the Runtime supplies it from the
 * decision that authorized dispatch.
 *
 * Reportable on a **failed** result as well as a successful one — a provider may charge for a
 * request that ultimately fails, and a cost channel that only survives success would lose exactly
 * the spend an operator most needs to see.
 */
export const costObservationSchema = costFields
  .pick({
    provider: true,
    operation: true,
    quantity: true,
    estimated: true,
    actual: true,
    billingStatus: true,
    providerRequestId: true,
  })
  // The same invariant the record applies, re-attached because `.pick()` drops refinements. That
  // omission is exactly what let an observation be valid to report and fatal to append (#150).
  .refine(hasBillingEvidence, { message: BILLING_EVIDENCE_MESSAGE, path: ["actual"] });

/** @see costObservationSchema */
export type CostObservation = z.infer<typeof costObservationSchema>;
