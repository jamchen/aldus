/**
 * The composed Runtime's half of a paid Worker invocation (#107, ADR-0046).
 *
 * Implements `stage-runner`'s {@link WorkerSpendController} port over the same `SpendService` and
 * cost store every other paid path uses. There is deliberately no second reservation protocol: a
 * parallel one would be a parallel place for the budget to be wrong.
 *
 * The whole of the Runtime's job here is attribution. A Worker reports provider billing facts; it
 * never states which grant authorized it, which Run it belongs to, or which reservation it drew
 * on. Asking it to would reproduce #107's silent-bypass class — a Worker that forgets produces a
 * charge nothing can hold against a budget, and one that supplies its own could name a grant that
 * did not authorize it.
 */

import { SCHEMA_VERSION, newId, type CostObservation, type CostRecord } from "@aldus-runtime/core";
import type { SpendGrant } from "@aldus-runtime/gate-engine";
import type {
  WorkerDispatchEvidence,
  WorkerSpendController,
  WorkerSpendReservation,
  WorkerSpendReserveInput,
} from "@aldus-runtime/stage-runner";
import type { SpendReservation } from "@aldus-runtime/core";

import type { CostRecordStore } from "./cost-store.js";
import { ServiceErrorCodes, serviceError } from "./errors.js";
import type { SpendService } from "./spend-service.js";

/**
 * Supplies the grant in force for one Worker operation (§13.2).
 *
 * Keyed by operation rather than by Worker, deliberately. A grant authorizes *what may be done*
 * and for how much; which implementation performs it is a substitution the operator did not
 * approve or refuse, and keying on it would let swapping a Worker change what is authorized.
 */
export type WorkerSpendGrantProvider = (
  runId: string,
  operation: string,
) => Promise<SpendGrant | undefined> | SpendGrant | undefined;

/** Wiring for a {@link RuntimeWorkerSpendController}. */
export interface RuntimeWorkerSpendControllerOptions {
  spend: SpendService;
  costs: CostRecordStore;
  grants: WorkerSpendGrantProvider;
  now?: () => Date;
  newCostId?: () => string;
}

/** The reservation the runner holds, with the domain object it stands for. */
interface HeldReservation {
  readonly reservationId: string;
  readonly ceiling?: SpendReservation["reserved"];
  readonly reservation: SpendReservation;
}

/** @see WorkerSpendController */
export class RuntimeWorkerSpendController implements WorkerSpendController {
  readonly #spend: SpendService;
  readonly #costs: CostRecordStore;
  readonly #grants: WorkerSpendGrantProvider;
  readonly #now: () => Date;
  readonly #newCostId: () => string;

  constructor(options: RuntimeWorkerSpendControllerOptions) {
    this.#spend = options.spend;
    this.#costs = options.costs;
    this.#grants = options.grants;
    this.#now = options.now ?? (() => new Date());
    this.#newCostId = options.newCostId ?? (() => newId("cost"));
  }

  async reserve(input: WorkerSpendReserveInput): Promise<WorkerSpendReservation> {
    const grant = await this.#grants(input.runId, input.operation);
    const outcome = await this.#spend.reserve({
      grant,
      operation: input.operation,
      runId: input.runId,
      stageId: input.stageId,
      attemptId: input.attemptId,
      // Per billed charge, never the destination key and never the invocation fingerprint
      // (ADR-0036, ADR-0043). Qualified by the Worker so two Workers billed for one logical step
      // do not resolve to one reservation.
      effectKey: `${input.workerId}@${input.workerVersion}:${input.billingEffectKey}`,
      expectation: input.expectation,
    });
    if (!outcome.reserved) {
      throw serviceError(
        ServiceErrorCodes.SPEND_NOT_AUTHORIZED,
        `Worker "${input.workerId}@${input.workerVersion}" was not authorized to spend on ` +
          `"${input.operation}": ${outcome.reason === "refused" ? outcome.explanation : outcome.reason}`,
        {
          category: "policy",
          retryable: false,
          details: { runId: input.runId, stageId: input.stageId, operation: input.operation },
        },
      );
    }
    return this.#held(outcome.reservation);
  }

  async prepareDispatch(
    reservation: WorkerSpendReservation,
    evidence: WorkerDispatchEvidence,
  ): Promise<WorkerSpendReservation> {
    const held = this.#require(reservation);
    const updated = await this.#spend.prepareDispatch(held.reservation, {
      backendId: evidence.workerId,
      backendVersion: evidence.workerVersion,
      ceilingEnforced: evidence.ceilingEnforced,
      ...(evidence.appliedCeiling === undefined ? {} : { appliedCeiling: evidence.appliedCeiling }),
    });
    return this.#held(updated);
  }

  async settle(
    reservation: WorkerSpendReservation,
    observations: readonly CostObservation[],
  ): Promise<readonly CostRecord[]> {
    const held = this.#require(reservation);
    const settled = await this.#spend.settle(held.reservation, observations, {
      ...(held.reservation.authorizationId === undefined
        ? {}
        : { authorizationId: held.reservation.authorizationId }),
    });
    return settled.costs;
  }

  async markUnknown(
    reservation: WorkerSpendReservation,
    reason: string,
    observations: readonly CostObservation[] = [],
  ): Promise<readonly CostRecord[]> {
    const held = this.#require(reservation);
    // Records first, then the unresolved state — the same ordering settlement uses, and for the
    // same reason: a reservation that stops describing the charge before the charge is durable
    // leaves the money invisible.
    const written = await this.#write(held.reservation, observations, {
      ...(held.reservation.authorizationId === undefined
        ? {}
        : { authorizationId: held.reservation.authorizationId }),
    });
    await this.#spend.markUnknown(
      held.reservation,
      written.map((record) => record.costId),
      { reason },
    );
    return written;
  }

  async releaseBeforeDispatch(reservation: WorkerSpendReservation, reason: string): Promise<void> {
    const held = this.#require(reservation);
    await this.#spend.releaseBeforeDispatch(held.reservation, reason);
  }

  async recordUnauthorized(
    input: {
      runId: string;
      stageId: string;
      attemptId: string;
      workerId: string;
      workerVersion: string;
    },
    observations: readonly CostObservation[],
  ): Promise<readonly CostRecord[]> {
    // No `authorizationId`, deliberately and permanently. Nothing authorized this, and a record
    // naming a grant would make an unapproved charge look approved.
    return this.#write(input, observations, {});
  }

  /** Write attributed records. Attribution is the Runtime's; the facts are the provider's. */
  async #write(
    input: { runId: string; stageId: string; attemptId: string; reservationId?: string },
    observations: readonly CostObservation[],
    attribution: { authorizationId?: string },
  ): Promise<readonly CostRecord[]> {
    const recordedAt = this.#now().toISOString();
    const written: CostRecord[] = [];
    for (const observation of observations) {
      const record: CostRecord = {
        ...observation,
        schemaVersion: SCHEMA_VERSION,
        costId: this.#newCostId(),
        runId: input.runId,
        stageId: input.stageId,
        attemptId: input.attemptId,
        ...(input.reservationId === undefined ? {} : { reservationId: input.reservationId }),
        ...(attribution.authorizationId === undefined
          ? {}
          : { authorizationId: attribution.authorizationId }),
        recordedAt,
      };
      await this.#costs.append(input.runId, record);
      written.push(record);
    }
    return written;
  }

  #held(reservation: SpendReservation): HeldReservation {
    return {
      reservationId: reservation.reservationId,
      // The grant's per-request limit, carried through the reservation. Never the Worker's claim.
      ...(reservation.reserved === undefined ? {} : { ceiling: reservation.reserved }),
      reservation,
    };
  }

  #require(reservation: WorkerSpendReservation): HeldReservation {
    const held = reservation as HeldReservation;
    if (held.reservation === undefined) {
      throw serviceError(
        ServiceErrorCodes.SPEND_NOT_AUTHORIZED,
        "This reservation did not come from the spend controller, so nothing establishes that " +
          "authorization was committed for it (§13.2).",
        { category: "policy", retryable: false, details: {} },
      );
    }
    return held;
  }
}
