/**
 * `@aldus-runtime/services` — the programmatic application API of the Aldus runtime.
 *
 * Architecture contract §18: "Core behavior MUST be available through a programmatic API. CLI and
 * MCP are adapters over the same application services." This package is that API. `@aldus-runtime/cli`
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
  LedgerEventStoreSink,
  RunStoreCostReader,
  RunStoreGateDecisionStore,
} from "./adapters.js";

export { AldusContext, type AldusContextOptions, type SubjectsProvider } from "./context.js";

export {
  hasEdges,
  predecessorsOf,
  resolveRequiredGates,
  terminalStagesOf,
  validateWorkflowGraph,
  type RequiredGatesResolution,
  type WorkflowGraph,
  type WorkflowGraphProblem,
  type WorkflowStageNode,
} from "./workflow.js";

export {
  FileLexiconStore,
  FilePlanStore,
  FileScriptStore,
  FileTakeStore,
  LedgerLayout,
  TTS_DIRECTORY,
  fileLedgerStores,
  type LedgerFileName,
} from "./ledger-store.js";

export {
  SynthesisGateway,
  gateEngineSpendAuthorizer,
  isIssuedSynthesisPermit,
  type SpendGrantProvider,
  type SynthesisAdapter,
  type SynthesisGatewayOptions,
  type SynthesisOutcome,
  type SynthesisPermit,
  type SynthesisRequest,
  type SynthesisResult,
} from "./synthesis.js";

export { summariseCosts } from "./costs.js";

export { ServiceErrorCodes, serviceError, type ServiceErrorCode } from "./errors.js";

export {
  decideActions,
  enforcedBlockerFor,
  enforcedGateBlockerFor,
  gateBlockerFor,
  orderingBlockerFor,
  type ActionPlan,
  type ActionPolicyInput,
  type BlockedAction,
  type BlockEnforcement,
  type NextAction,
  type RunSnapshot,
  type StageBlocker,
  type StageSnapshot,
  type StageSummaryStatus,
} from "./nextaction.js";

export { deriveRunState, goalStagesFor, type RunState, type RunStateSource } from "./runstate.js";

export type {
  ArchiveReport,
  ArtifactLineageReport,
  ArtifactReport,
  CleanupPlanReport,
  CostReport,
  CostSummary,
  EpisodeInspection,
  GateDecisionReport,
  InitReport,
  Inspection,
  PlanReport,
  ReleaseBundleReport,
  ReleaseExecutionReport,
  ReleaseReconciliationReport,
  ReleaseReport,
  RunInspection,
  RunReport,
  RunSummary,
  ScriptReport,
  StageReport,
  StageRunReport,
  StartRunReport,
  StatusReport,
  SynthesisReport,
  TakeDecisionReport,
  TakeReport,
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
  type CancelRunRequest,
  type StartRunRequest,
} from "./services.js";

export {
  AgentExecutionService,
  type AgentExecutionInput,
  type AgentExecutionOptions,
  type AgentExecutionResult,
} from "./agent-execution.js";

export type { CostRecordStore } from "./cost-store.js";
export {
  SpendService,
  type CostExpectation,
  type DispatchEvidence,
  type ReserveInput,
  type ReserveOutcome,
  type SpendServiceOptions,
  openOperatorConsole,
  type OperatorSpendConsole,
  type ReconcileInput,
  type ReconciliationResolution,
  type ReservationStatus,
} from "./spend-service.js";
