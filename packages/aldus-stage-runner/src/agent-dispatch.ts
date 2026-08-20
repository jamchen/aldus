/**
 * The seam a Stage dispatches an agent execution through (§10, §13.2, §19.3; #107, ADR-0047).
 *
 * `AldusConfig.agentBackend` reached `StageRunner`, which called `assertCapabilities` on it and
 * never `execute`. The only caller of `AgentBackend.execute()` was `AgentExecutionService`, which
 * no composition constructed. `StageContext` had no member that reached a backend, so an adopter
 * who configured one could not dispatch it even deliberately.
 *
 * The fix is **not** for the runner to dispatch because a backend is present. A configured backend
 * is a capability source, not an execution instruction. The Stage asks; the Runtime supplies
 * everything else.
 *
 * This port exists so `stage-runner` can offer `runAgent` without depending on the services layer
 * that owns backend execution (§4.3). Its implementation there adapts `AgentExecutionService`
 * rather than reimplementing it — a second implementation of the reserve/dispatch/settle flow
 * would be a second answer to one billing boundary.
 */

import type { ActorRef, CostExpectation } from "@aldus-runtime/core";

import type { AgentRequest, AgentResult } from "./backend.js";

/**
 * What a Stage may say about an agent execution.
 *
 * `executionId`, `signal` and `maxSpend` are **omitted deliberately**. They are Runtime authority:
 * the runner mints the execution id, passes its own cancellation signal, and applies the reserved
 * ceiling only when the exact backend version enforces one. A Stage that could set `maxSpend`
 * would choose its own limit, and one that could set `executionId` could correlate its execution
 * with somebody else's attempt.
 *
 * `requiredCapabilities` stays where it already is, inside the request — a second field beside it
 * would be two places to state one thing.
 */
export type StageOwnedAgentRequest = Omit<AgentRequest, "executionId" | "signal" | "maxSpend">;

/** Everything the Runtime knows, handed to the implementation that owns backend execution. */
export interface StageAgentDispatchInput {
  /** The Stage's half, unchanged. */
  request: StageOwnedAgentRequest;
  /** Minted by the runner. A Stage cannot correlate its execution with another attempt. */
  executionId: string;
  /** The attempt's signal (§19.1). Cancellation after dispatch never proves no charge. */
  signal: AbortSignal;
  runId: string;
  episodeId: string;
  stageId: string;
  attemptId: string;
  /** Who is performing this (§19.2). From the runner, never from the Stage. */
  actor: ActorRef;
  /** What the grant must authorize. Absent for a free declaration. */
  operation?: string;
  /** Identity of the independently billed effect (ADR-0043). Absent for a free declaration. */
  billingEffectKey?: string;
  /** What it is expected to cost. Closed; absence is not a state (ADR-0044). */
  expectation: CostExpectation;
}

/**
 * What a dispatch came back as, including the lifecycle fact a Stage cannot see for itself.
 *
 * Implemented in the services layer over `AgentExecutionService`, which already owns reservation,
 * `CostRecord` attribution, unauthorized-free divergence, unknown billing and settlement ordering.
 */
export interface StageAgentDispatchResult {
  /** The backend's own answer, unchanged. */
  result: AgentResult;
  /**
   * Whether any recorded charge has an unconfirmed billing status (§19.3).
   *
   * **Carried, not derived.** The services layer owns settlement and is the only party that knows
   * whether billing resolved; a Stage re-deriving it from raw `AgentResult.costs` would be
   * guessing at the reservation's state from the provider's report. The adapter returning only
   * `result` erased exactly this fact, and the Stage then saw a completion for an execution whose
   * reservation was still `billing_unknown` and non-retryable.
   */
  billingUnconfirmed: boolean;
}

/**
 * Executes an agent request under the Runtime's authorization and attribution.
 */
export interface StageAgentDispatcher {
  /**
   * Resolve the grant, reserve, dispatch, attribute and settle.
   *
   * @throws {AldusError} when no grant authorizes the operation or the reservation is refused.
   * Every refusal that can happen before the provider call happens before it. Unresolved billing
   * is **not** thrown: the charge is durable and the caller has to see it, so it comes back on
   * {@link StageAgentDispatchResult.billingUnconfirmed}.
   */
  execute(input: StageAgentDispatchInput): Promise<StageAgentDispatchResult>;
  /**
   * Cancel an execution that cannot observe {@link StageAgentDispatchInput.signal} (§19.1).
   *
   * Invoked by the Runtime when the attempt aborts. Cancelling does **not** release the
   * reservation: a cancelled request may already have been billed, and treating cancellation as
   * proof of no charge is the assumption §19.3 exists to prevent.
   */
  cancel?(executionId: string): Promise<void>;
}
