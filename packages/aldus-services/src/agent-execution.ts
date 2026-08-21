/**
 * Dispatching an agent execution and recording what it cost (contract §13.2, §19.3, §20; #107).
 *
 * `AgentResult.costs` existed and nothing produced one: `StageRunner` checks a backend's
 * capabilities and never calls `execute`, so a backend that knew what it spent had no path to
 * saying so. An adopter reported $7.05 across six executions that Aldus could not record.
 *
 * This is the composition that closes it. The division of labour is the substance:
 *
 * - the **backend** reports billing facts — provider, operation, amounts, billing status;
 * - the **runtime** states attribution — which Run, Stage, attempt and authorization.
 *
 * Asking a backend to supply `authorizationId` is the silent budget-bypass class #107 reported: a
 * backend that forgets produces a charge nothing can hold against a grant, and a backend that
 * supplies its own could name a grant that did not authorize it.
 */

import {
  newEventId,
  newId,
  redact,
  SCHEMA_VERSION,
  type ActorRef,
  type AldusEvent,
  type CostObservation,
  type CostRecord,
  type SpendReservation,
} from "@aldus-runtime/core";
import type { SpendGrant } from "@aldus-runtime/gate-engine";
import {
  isChargeBearing,
  type AgentBackend,
  type AgentRequest,
  type AgentResult,
} from "@aldus-runtime/stage-runner";

import type { CostRecordStore } from "./cost-store.js";
import type { CostExpectation, SpendService } from "./spend-service.js";
import { ServiceErrorCodes, serviceError } from "./errors.js";

/** What the caller must state about an execution before it is dispatched. */
export interface AgentExecutionInput {
  runId: string;
  episodeId: string;
  stageId: string;
  attemptId: string;
  /** Who is performing this (§19.2). */
  actor: ActorRef;
  /** The request handed to the backend. */
  request: AgentRequest;
  /**
   * What the grant must authorize, e.g. `"agent.execute"` (§4.2).
   *
   * Checked against the grant's declared scope before reserving, so passing a synthesis grant to
   * an agent execution cannot authorize it.
   */
  operation: string;
  /**
   * The grant this execution spends against, from the decision that authorized dispatch.
   *
   * Supplied by the runtime rather than by the backend or the adopter's stage code. Absent means
   * no spend is authorized, and an estimate cannot then be checked against anything — so an
   * execution with an estimate and no grant is refused rather than dispatched hopefully.
   */
  grant?: SpendGrant;
  /**
   * What the Runtime expects this execution to cost (ADR-0044; #155).
   *
   * Required and closed. It replaced `estimated?: Money`, where absence meant both *"nobody
   * stated one"* and *"nothing will be charged"* — so an unestimated execution dispatched with no
   * spend check at all. Declaring `free` is now a statement someone makes, not a field they
   * omitted.
   */
  expectation: CostExpectation;
  /**
   * Identity of the independently billed effect (ADR-0043).
   *
   * Retrying the same effect resolves to the same reservation rather than committing authorization
   * twice.
   */
  effectKey: string;
}

/** What happened, including what it cost. */
export interface AgentExecutionResult {
  /** The backend's own answer, unchanged. */
  result: AgentResult;
  /** Cost records written, with attribution the runtime supplied. */
  costs: readonly CostRecord[];
  /**
   * Whether any recorded charge has an unconfirmed billing status (§19.3).
   *
   * A caller **must not** silently retry when this is true: an unconfirmed charge may have landed,
   * and re-running would spend again on the assumption it did not. `consumesBudget` already treats
   * `unknown` as spent for the same reason, and this surfaces the same fact to a retry decision.
   */
  billingUnconfirmed: boolean;
}

/** Dependencies, injected so a composition supplies them once. */
export interface AgentExecutionOptions {
  backend: AgentBackend;
  /** Reserves before dispatch and settles after (ADR-0044). */
  spend: SpendService;
  costs: CostRecordStore;
  events: { append(runId: string, event: AldusEvent): Promise<unknown> };
  now?: () => Date;
  newCostId?: () => string;
}

/**
 * Dispatch one agent execution, enforce the spend grant, and record what it cost.
 *
 * @throws {AldusError} `ALDUS_SPEND_NOT_AUTHORIZED` before dispatch when the grant will not cover
 * the estimate, or is already exhausted or overspent.
 */
export class AgentExecutionService {
  readonly #options: Required<
    Pick<AgentExecutionOptions, "backend" | "costs" | "events" | "spend">
  > & {
    now: () => Date;
    newCostId: () => string;
  };

  constructor(options: AgentExecutionOptions) {
    this.#options = {
      backend: options.backend,
      spend: options.spend,
      costs: options.costs,
      events: options.events,
      now: options.now ?? (() => new Date()),
      newCostId: options.newCostId ?? (() => newId("cost")),
    };
  }

  async execute(input: AgentExecutionInput): Promise<AgentExecutionResult> {
    const capabilities = await this.#options.backend.capabilities();

    // The single authoritative pre-dispatch decision (ADR-0044). `checkSpend` is deliberately NOT
    // called first: its answer is stale the moment another writer moves the stream, and only the
    // committed answer protects anything.
    const outcome = await this.#options.spend.reserve({
      grant: input.grant,
      operation: input.operation,
      runId: input.runId,
      stageId: input.stageId,
      attemptId: input.attemptId,
      effectKey: input.effectKey,
      expectation: input.expectation,
    });
    if (outcome.reserved === false && outcome.reason === "refused") {
      throw serviceError(ServiceErrorCodes.SPEND_NOT_AUTHORIZED, outcome.explanation, {
        category: "policy",
        retryable: false,
        details: { runId: input.runId, stageId: input.stageId },
      });
    }
    let reservation = outcome.reserved ? outcome.reservation : undefined;

    // A ceiling only where the backend says it enforces one. Passing a limit to a backend that
    // ignores it would record a protection that does not exist (ADR-0030).
    const enforces = capabilities.enforcesSpendCeiling === true;
    const ceiling = reservation?.reserved;
    // Stripped **unconditionally**, then re-added only where the Runtime has a ceiling and this
    // backend enforces it. The override used to live only in the enforcing branch, so the other
    // passed the caller's object through untouched with any `maxSpend` it carried — a limit in
    // front of a provider that no grant authorized, while `prepareDispatch` recorded
    // `ceilingEnforced: false` and the trace therefore said no ceiling was applied.
    //
    // Omitting the key from the caller-facing type does not close this: a request assembled from
    // configuration, or written in JavaScript, carries it regardless.
    const { maxSpend: _callerSupplied, ...stated } = input.request;
    const request: AgentRequest =
      enforces && ceiling !== undefined ? { ...stated, maxSpend: ceiling } : stated;

    // Before the provider call, so the window in which dispatch may have begun is visible rather
    // than inferred (ADR-0044). What is recorded is what was true of *this* execution: a
    // backend's current capabilities are not evidence about an earlier request.
    if (reservation !== undefined) {
      reservation = await this.#options.spend.prepareDispatch(reservation, {
        backendId: this.#options.backend.id,
        backendVersion: this.#options.backend.version,
        ceilingEnforced: enforces && ceiling !== undefined,
        ...(enforces && ceiling !== undefined ? { appliedCeiling: ceiling } : {}),
      });
    }

    let result: AgentResult;
    try {
      result = await this.#options.backend.execute(request);
    } catch (thrown) {
      // A backend that threw may still have been billed, and it cannot tell us. Recorded as an
      // unconfirmed outcome rather than as free, because assuming a failed request cost nothing
      // is how a budget is quietly exceeded (§19.3).
      // A backend that threw may still have been billed, and it cannot tell us. The reservation
      // stays committed and the effect becomes non-retryable: assuming a failed request cost
      // nothing is how a budget is quietly exceeded (§19.3), and after `dispatch_prepared` a
      // failure is not proof of no charge (ADR-0044).
      if (reservation !== undefined) await this.#options.spend.markUnknown(reservation);
      await this.#emit(input, [], { threw: true });
      throw thrown;
    }

    // Costs are recorded whether or not the execution succeeded. A provider may charge for a
    // request that fails, and a channel surviving only success loses exactly the spend an
    // operator most needs to see.
    //
    // Through the reservation where one exists, so the cost record is durable *before* the
    // reservation stops consuming authorization. The reverse would release authorization while
    // the charge is absent (ADR-0044).
    const observations = result.costs ?? [];
    // Billing semantics, not array length. `free` and `voided` are a provider stating that nothing
    // is owed — evidence of no spend rather than a charge to account for. The same predicate the
    // Worker path uses, so the two cannot answer this differently (ADR-0046).
    const charges = observations.filter((observation) =>
      isChargeBearing(observation.billingStatus),
    );
    let records: CostRecord[];
    let settledReservation: SpendReservation | undefined;
    if (reservation !== undefined) {
      // One `effectKey` names one independently billed effect and commits one reservation for it.
      // `AgentResult.costs` is plural because one execution may incur several model, provider or
      // tool charges — and settling several *independent* charges against one authorization would
      // let a single approval cover N (ADR-0043, ADR-0046).
      //
      // The money is already spent, so the facts are persisted and attributed and the reservation
      // is retained unresolved. What is withheld is the claim that it covered them.
      if (charges.length > 1) {
        const written = await this.#record(input, observations);
        await this.#options.spend.markUnknown(
          reservation,
          written.map((record) => record.costId),
          {
            reason:
              `the backend reported ${charges.length} independently billed charges against one ` +
              "declared billing effect; one reservation authorizes one charge",
          },
        );
        await this.#emit(input, written, { ok: result.ok, billingCardinalityExceeded: true });
        throw serviceError(
          ServiceErrorCodes.SPEND_NOT_AUTHORIZED,
          `Stage "${input.stageId}" declared one billing effect and the backend reported ` +
            `${charges.length} independent charges. They are recorded and the reservation is ` +
            "left unresolved: settling them against one authorization would let a single " +
            "approval cover several charges (§13.2, §19.3).",
          {
            category: "conflict",
            retryable: false,
            details: { runId: input.runId, stageId: input.stageId },
          },
        );
      }
      const settled = await this.#options.spend.settle(reservation, observations, {
        ...(input.grant === undefined ? {} : { authorizationId: input.grant.decisionId }),
      });
      records = [...settled.costs];
      settledReservation = settled.reservation;
    } else {
      // Declared free. A charge reported anyway is an unauthorized divergence: it is recorded so
      // §20 can answer what it cost, and it is not laundered through a grant nobody consulted.
      // A `free` or `voided` observation is not one — that is the backend truthfully saying
      // nothing was owed, which is what the declaration claimed.
      records = await this.#record(input, observations);
      if (charges.length > 0) {
        await this.#emit(input, records, { ok: result.ok, unauthorizedDivergence: true });
        throw serviceError(
          ServiceErrorCodes.SPEND_NOT_AUTHORIZED,
          `Stage "${input.stageId}" declared this execution free and the provider reported a ` +
            "charge. The charge is recorded, and no grant is credited with authorizing it — " +
            "attaching one after the fact would invent an approval nobody gave (§13.2, §19.3).",
          {
            category: "policy",
            retryable: false,
            details: { runId: input.runId, stageId: input.stageId },
          },
        );
      }
    }
    await this.#emit(input, records, { ok: result.ok });

    return {
      result,
      costs: records,
      // From the reservation as well as the records. `records.some(unknown)` is a fact about what
      // was written, so it answers correctly when a record exists and cannot answer at all when
      // none does — which is exactly the silent-backend case.
      billingUnconfirmed:
        records.some((record) => record.billingStatus === "unknown") ||
        settledReservation?.status === "billing_unknown",
    };
  }

  /** Turn billing facts into attributed records (§19.3). */
  async #record(
    input: AgentExecutionInput,
    observations: readonly CostObservation[],
  ): Promise<CostRecord[]> {
    const recordedAt = this.#options.now().toISOString();
    const written: CostRecord[] = [];
    for (const observation of observations) {
      const record: CostRecord = {
        ...observation,
        schemaVersion: SCHEMA_VERSION,
        costId: this.#options.newCostId(),
        runId: input.runId,
        stageId: input.stageId,
        attemptId: input.attemptId,
        // The runtime's, from the decision that authorized dispatch. Never the backend's.
        ...(input.grant !== undefined ? { authorizationId: input.grant.decisionId } : {}),
        recordedAt,
      };
      await this.#options.costs.append(input.runId, record);
      written.push(record);
    }
    return written;
  }

  /** Link the execution and its costs in the trace (§20). */
  async #emit(
    input: AgentExecutionInput,
    records: readonly CostRecord[],
    outcome: Record<string, unknown>,
  ): Promise<void> {
    const event: AldusEvent = {
      schemaVersion: SCHEMA_VERSION,
      eventId: newEventId(),
      occurredAt: this.#options.now().toISOString(),
      episodeId: input.episodeId,
      runId: input.runId,
      stageId: input.stageId,
      attemptId: input.attemptId,
      action: "agent.executed",
      // An agent execution consumes and produces nothing the artifact registry knows about; the
      // fields are required by §6.4's event shape and empty is the honest value.
      inputRefs: [],
      outputRefs: [],
      actor: input.actor,
      details: redact({
        ...outcome,
        backendId: this.#options.backend.id,
        costIds: records.map((record) => record.costId),
      }) as Record<string, unknown>,
    };
    await this.#options.events.append(input.runId, event);
  }
}
