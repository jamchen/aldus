/**
 * The composed Runtime's half of `StageContext.runAgent` (#107, ADR-0047).
 *
 * An adapter over {@link AgentExecutionService}, **not** a second implementation of it. That
 * service already owns backend execution, reservation, `CostRecord` attribution, the
 * unauthorized-free divergence, unknown billing and settlement ordering; writing that flow again
 * behind `runAgent` would give one billing boundary two answers, and the two would diverge on the
 * first fix applied to only one.
 *
 * What this adds is the part a Stage must not supply: the grant, resolved from the operation the
 * Stage declared, through the same `dispatchSpendGrants` provider a paid Worker uses.
 */

import type { ActorRef, AldusEvent } from "@aldus-runtime/core";
import type {
  AgentBackend,
  AgentRequest,
  AgentResult,
  StageAgentDispatcher,
  StageAgentDispatchInput,
} from "@aldus-runtime/stage-runner";

import { AgentExecutionService } from "./agent-execution.js";
import type { CostRecordStore } from "./cost-store.js";
import { ServiceErrorCodes, serviceError } from "./errors.js";
import type { DispatchSpendGrantProvider } from "./paid-dispatch.js";
import type { SpendService } from "./spend-service.js";

/** Wiring for a {@link RuntimeStageAgentDispatcher}. */
export interface RuntimeStageAgentDispatcherOptions {
  backend: AgentBackend;
  spend: SpendService;
  costs: CostRecordStore;
  events: { append(runId: string, event: AldusEvent): Promise<unknown> };
  /** The same provider a paid Worker resolves through — one question, one answer. */
  grants: DispatchSpendGrantProvider;
  now?: () => Date;
}

/** @see StageAgentDispatcher */
export class RuntimeStageAgentDispatcher implements StageAgentDispatcher {
  readonly #backend: AgentBackend;
  readonly #execution: AgentExecutionService;
  readonly #grants: DispatchSpendGrantProvider;

  constructor(options: RuntimeStageAgentDispatcherOptions) {
    this.#backend = options.backend;
    this.#grants = options.grants;
    this.#execution = new AgentExecutionService({
      backend: options.backend,
      spend: options.spend,
      costs: options.costs,
      events: options.events,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  }

  async execute(input: StageAgentDispatchInput): Promise<AgentResult> {
    const paid = input.expectation.kind !== "free";
    if (paid && (input.operation === undefined || input.billingEffectKey === undefined)) {
      throw serviceError(
        ServiceErrorCodes.SPEND_NOT_AUTHORIZED,
        "A paid agent execution must name the operation a grant authorizes and the identity of " +
          "the billed effect. Without them nothing can be checked and a retry cannot resolve to " +
          "the reservation it already committed (§13.2, ADR-0043).",
        {
          category: "validation",
          retryable: false,
          details: { runId: input.runId, stageId: input.stageId },
        },
      );
    }

    // Resolved here, never supplied by the Stage. A caller that names its own authorization can
    // name one that did not authorize it — #107's silent-bypass class.
    const grant =
      input.operation === undefined ? undefined : await this.#grants(input.runId, input.operation);

    // The Runtime's fields go on last, so a Stage cannot have set them.
    const request: AgentRequest = {
      ...input.request,
      executionId: input.executionId,
      signal: input.signal,
    };

    const outcome = await this.#execution.execute({
      runId: input.runId,
      episodeId: input.episodeId,
      stageId: input.stageId,
      attemptId: input.attemptId,
      actor: input.actor as ActorRef,
      request,
      operation: input.operation ?? "agent.execute",
      ...(grant === undefined ? {} : { grant }),
      expectation: input.expectation,
      // Qualified by the backend, so two backends billed for one logical step do not resolve to
      // one reservation. Absent for a free execution, which commits none.
      effectKey: `${this.#backend.id}@${this.#backend.version}:${input.billingEffectKey ?? input.executionId}`,
    });
    return outcome.result;
  }

  async cancel(executionId: string): Promise<void> {
    // Only where the backend offers the seam. Cancelling does not release the reservation: a
    // cancelled request may already have been billed (§19.3).
    await this.#backend.cancel?.(executionId);
  }
}
