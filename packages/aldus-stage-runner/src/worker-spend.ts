/**
 * The seam a Stage Runner reserves through before a Worker is paid (§13.2, §19.3; #107, ADR-0046).
 *
 * `StageContext.runWorker` reached a provider with no expectation, no grant and no reservation,
 * handed `WorkerResult.costs` back to the stage, and recorded nothing. Measured through the
 * composed services: a Worker reporting `actual: 2.00 USD, billingStatus: "charged"` left
 * `services.costs(runId)` at `recordCount: 0`. The money was spent against no grant and the
 * runtime knew the number.
 *
 * The division of labour is the substance, and it is the same one `AgentExecutionService` uses:
 *
 * - the **Worker** reports billing facts — provider, operation, amounts, billing status;
 * - the **Runtime** states attribution — Run, Stage, attempt, authorization, reservation.
 *
 * A Worker that supplied its own `authorizationId` could name a grant that did not authorize it,
 * and one that forgot would produce a charge nothing can hold against a budget. Neither is a
 * Worker's decision to make.
 *
 * This port lives in `stage-runner` and is implemented in the services layer, so the runner can
 * refuse a paid invocation without depending upward (§4.3).
 */

import type { CostObservation, CostRecord, Money } from "@aldus-runtime/core";

/** A committed reservation, as the runner holds it. Opaque beyond what dispatch needs. */
export interface WorkerSpendReservation {
  /** Identity, for attribution and for the trace (§20). */
  readonly reservationId: string;
  /**
   * The ceiling this invocation may be given, derived from the **grant**.
   *
   * Never from the Worker's capability claim. A Worker saying it enforces a ceiling says it will
   * respect a number it is handed; it does not say what the number is, and taking one from it
   * would let the spender choose its own limit.
   */
  readonly ceiling?: Money;
}

/** What the runner states before a potentially paid Worker invocation. */
export interface WorkerSpendReserveInput {
  /** What the grant must authorize. An open string (§4.2). */
  operation: string;
  /** Identity of the independently billed effect, with per-charge cardinality (ADR-0043). */
  billingEffectKey: string;
  /** What it is expected to cost. Closed; absence is not a state (ADR-0044). */
  expectation: Exclude<import("@aldus-runtime/core").CostExpectation, { kind: "free" }>;
  runId: string;
  stageId: string;
  attemptId: string;
  workerId: string;
  workerVersion: string;
}

/** What was true of the dispatch, recorded before the provider call (ADR-0044). */
export interface WorkerDispatchEvidence {
  workerId: string;
  workerVersion: string;
  /** Whether a ceiling was applied *and* this exact Worker version enforces it. */
  ceilingEnforced: boolean;
  /** The ceiling actually passed, present only when it was. */
  appliedCeiling?: Money;
}

/**
 * Reserve, settle, and record — the composed Runtime's half of a paid Worker invocation.
 *
 * Every method takes attribution from the runner and none from the Worker.
 */
export interface WorkerSpendController {
  /**
   * Commit authorization before anything is dispatched.
   *
   * @throws {AldusError} when no grant covers the operation, the grant's scope excludes it, the
   * budget is exhausted, or its policy refuses an unestimated request. A refusal here must happen
   * before `Worker.execute`, because a refusal that arrives after the provider was called is not a
   * refusal.
   */
  reserve(input: WorkerSpendReserveInput): Promise<WorkerSpendReservation>;

  /** Record what the dispatch was, before it begins (ADR-0044). */
  prepareDispatch(
    reservation: WorkerSpendReservation,
    evidence: WorkerDispatchEvidence,
  ): Promise<WorkerSpendReservation>;

  /**
   * Persist the Worker's billing facts as attributed records, then settle.
   *
   * Durability precedes settlement: the reverse would release authorization while the charge is
   * absent from the record.
   */
  settle(
    reservation: WorkerSpendReservation,
    observations: readonly CostObservation[],
  ): Promise<readonly CostRecord[]>;

  /**
   * Retain the reservation and make the effect non-retryable (§19.3).
   *
   * For a Worker that threw after dispatch, or returned without billing facts it declared it
   * reports. Both mean a charge may have landed that nobody can measure, and re-running would
   * spend again on the assumption it did not.
   */
  markUnknown(reservation: WorkerSpendReservation, reason: string): Promise<void>;

  /**
   * Release a reservation whose effect provably did not begin.
   *
   * Only before `prepareDispatch`. After it, a failure is not proof of no charge.
   */
  releaseBeforeDispatch(reservation: WorkerSpendReservation, reason: string): Promise<void>;

  /**
   * Record a charge nothing authorized (§13.2, §19.3).
   *
   * A Worker declared free that reported a charge. The record exists so §20 can answer what the
   * Run cost, and it carries **no** `authorizationId` — attaching one after the fact would invent
   * an approval nobody gave.
   */
  recordUnauthorized(
    input: {
      runId: string;
      stageId: string;
      attemptId: string;
      workerId: string;
      workerVersion: string;
    },
    observations: readonly CostObservation[],
  ): Promise<readonly CostRecord[]>;
}
