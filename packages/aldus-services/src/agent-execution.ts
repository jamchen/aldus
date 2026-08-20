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
  type Money,
} from "@aldus-runtime/core";
import { checkSpend, type SpendGrant } from "@aldus-runtime/gate-engine";
import type { AgentBackend, AgentRequest, AgentResult } from "@aldus-runtime/stage-runner";

import { ServiceErrorCodes, serviceError } from "./errors.js";

/** Where cost records are read and appended. */
export interface CostRecordStore {
  list(runId: string): Promise<CostRecord[]>;
  append(runId: string, record: CostRecord): Promise<void>;
}

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
   * The grant this execution spends against, from the decision that authorized dispatch.
   *
   * Supplied by the runtime rather than by the backend or the adopter's stage code. Absent means
   * no spend is authorized, and an estimate cannot then be checked against anything — so an
   * execution with an estimate and no grant is refused rather than dispatched hopefully.
   */
  grant?: SpendGrant;
  /**
   * What this execution is expected to cost, where the caller knows before dispatching.
   *
   * §13.2's check happens here, before the effect. An execution with no estimate is dispatched and
   * its actual cost recorded — the alternative, refusing anything unestimated, would forbid every
   * backend that can only report after the fact.
   */
  estimated?: Money;
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
  readonly #options: Required<Pick<AgentExecutionOptions, "backend" | "costs" | "events">> & {
    now: () => Date;
    newCostId: () => string;
  };

  constructor(options: AgentExecutionOptions) {
    this.#options = {
      backend: options.backend,
      costs: options.costs,
      events: options.events,
      now: options.now ?? (() => new Date()),
      newCostId: options.newCostId ?? (() => newId("cost")),
    };
  }

  async execute(input: AgentExecutionInput): Promise<AgentExecutionResult> {
    const capabilities = await this.#options.backend.capabilities();

    // §13.2, before the effect. Checked here rather than after, because a refusal that arrives
    // once the provider has been billed is not a refusal.
    if (input.estimated !== undefined) {
      if (input.grant === undefined) {
        throw serviceError(
          ServiceErrorCodes.SPEND_NOT_AUTHORIZED,
          `Stage "${input.stageId}" expects to spend ${input.estimated.amount} ` +
            `${input.estimated.currency} and no spend grant authorizes it. §13.2 requires an ` +
            "operator's approval before paid work, and an estimate with nothing to check it " +
            "against is not an authorization.",
          {
            category: "policy",
            retryable: false,
            details: { runId: input.runId, stageId: input.stageId },
          },
        );
      }

      const existing = await this.#options.costs.list(input.runId);
      const check = checkSpend(input.grant, existing, { amount: input.estimated });
      if (!check.allowed) {
        throw serviceError(
          ServiceErrorCodes.SPEND_NOT_AUTHORIZED,
          `Refused before dispatch: ${check.explanation}`,
          {
            category: "policy",
            retryable: false,
            details: {
              runId: input.runId,
              stageId: input.stageId,
              reason: check.reason,
              grantId: input.grant.grantId,
            },
          },
        );
      }
    }

    // A ceiling only where the backend says it enforces one. Passing a limit to a backend that
    // ignores it would record a protection that does not exist (ADR-0030).
    const request: AgentRequest =
      capabilities.enforcesSpendCeiling === true && input.grant?.maxPerRequest !== undefined
        ? { ...input.request, maxSpend: input.grant.maxPerRequest }
        : input.request;

    let result: AgentResult;
    try {
      result = await this.#options.backend.execute(request);
    } catch (thrown) {
      // A backend that threw may still have been billed, and it cannot tell us. Recorded as an
      // unconfirmed outcome rather than as free, because assuming a failed request cost nothing
      // is how a budget is quietly exceeded (§19.3).
      await this.#emit(input, [], { threw: true });
      throw thrown;
    }

    // Costs are recorded whether or not the execution succeeded. A provider may charge for a
    // request that fails, and a channel surviving only success loses exactly the spend an
    // operator most needs to see.
    const records = await this.#record(input, result.costs ?? []);
    await this.#emit(input, records, { ok: result.ok });

    return {
      result,
      costs: records,
      billingUnconfirmed: records.some((record) => record.billingStatus === "unknown"),
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
