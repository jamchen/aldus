/**
 * `@aldus/services` — the programmatic application API of the Aldus runtime.
 *
 * Architecture contract §18: "Core behavior MUST be available through a programmatic API. CLI and
 * MCP are adapters over the same application services." This package is that API. `@aldus/cli`
 * adapts it to a terminal; the Production MCP (WP-11) adapts it to typed tool calls; neither owns
 * a decision the other lacks.
 *
 * Nothing here formats for a human or reads `process.argv`. Every method returns a structured
 * {@link ServiceResult} an adapter renders, serialises, or maps to an exit code.
 *
 * @packageDocumentation
 */

export { parseActor, requireActor } from "./actor.js";

export {
  EventStoreGateEventSink,
  RunStoreCostReader,
  RunStoreGateDecisionStore,
} from "./adapters.js";

export { AldusContext, type AldusContextOptions, type SubjectsProvider } from "./context.js";

export { summariseCosts } from "./costs.js";

export { ServiceErrorCodes, serviceError, type ServiceErrorCode } from "./errors.js";

export {
  decideActions,
  type ActionPlan,
  type ActionPolicyInput,
  type BlockedAction,
  type NextAction,
  type RunSnapshot,
  type StageSnapshot,
  type StageSummaryStatus,
} from "./nextaction.js";

export type {
  ArtifactReport,
  CostReport,
  CostSummary,
  EpisodeInspection,
  GateDecisionReport,
  InitReport,
  Inspection,
  ReleaseReport,
  RunInspection,
  RunReport,
  RunSummary,
  StageReport,
  StageRunReport,
  StartRunReport,
  StatusReport,
} from "./reports.js";

export {
  hasData,
  ok,
  refused,
  unsuccessful,
  type Refusal,
  type ServiceOk,
  type ServiceRefused,
  type ServiceResult,
  type ServiceUnsuccessful,
} from "./results.js";

export {
  AldusServices,
  type GateDecisionRequest,
  type InitRequest,
  type RunStageRequest,
  type StartRunRequest,
} from "./services.js";
