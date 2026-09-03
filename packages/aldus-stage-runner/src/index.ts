/**
 * `@aldus-runtime/stage-runner` — stage definitions and the attempt lifecycle for the Aldus runtime.
 *
 * Implements architecture contract §22 **WP-04 Stage runner**: stage definition and registry,
 * lifecycle events, input/output validation, retry and idempotency policy, cancellation, and
 * structured errors.
 *
 * The runner owns control flow and durable state (§3.1). It does not decide anything editorial: a
 * gate halts a stage and is recorded, but *evaluating* it is WP-05's, and the runner never steps
 * past a pending decision. §10's Agent Backend is a boundary this package consumes and does not
 * implement — §10 opens with "The Runtime MUST NOT equal Claude Code or Codex", and §4.2 keeps
 * backend identities out of the runtime entirely.
 *
 * @packageDocumentation
 */

export {
  GateRequiredSignal,
  isGateRequiredSignal,
  type ArtifactRecorder,
  type ArtifactRecorderRequest,
  type CostPolicy,
  type RetryBackoff,
  type RetryPolicy,
  type StageContext,
  type StageGateStatus,
  type StageDefinition,
  type StageRetrySafety,
  type WorkerEffect,
  type StageOutcome,
  type StageOutputRegistration,
  type StageProvenanceExtras,
  type StageRunResult,
  type StageSchema,
  type StageSchemaResult,
  deriveInvocationKey,
  resolveArtifactContract,
  checkArtifactContract,
  asEnumeratedFinding,
  countEvaluationEvidence,
  type ArtifactObligation,
  type ArtifactContractContext,
  type ArtifactContractBreach,
  type StageArtifactDeclaration,
  type EffectKeyContext,
  type StageEvaluationChannel,
  type StageEvaluationDeclaration,
  type EvaluationFinding,
  type EvaluationEvidenceCount,
  type AggregateReport,
  type EvaluationObservation,
  type StageWorkerRequest,
  type StageAgentRequest,
  type StageAgentOutcome,
} from "./definition.js";

export {
  assertCapabilities,
  backendActor,
  type AgentBackend,
  type AgentCapabilities,
  type AgentRequest,
  type AgentResult,
  type AgentSessionRef,
} from "./backend.js";

export { StageRunnerErrorCodes, stageRunnerError, type StageRunnerErrorCode } from "./errors.js";

export { StageRegistry } from "./registry.js";

export { StageRunner, type RunStageOptions, type StageRunnerOptions } from "./runner.js";

export {
  STAGE_EVENT_ACTIONS,
  STAGE_STATE_FORMAT_VERSION,
  applyLifecycleEvent,
  canonicalJson,
  digestJson,
  emptyStageState,
  isTerminal,
  outputsOf,
  readStageState,
  rebuildStageState,
  reconcileStageState,
  redactConfiguration,
  writeStageState,
  type AttemptMetadata,
  type StageEventAction,
  type StageLifecycleDetails,
  type StageStateFile,
  type StoredStageExecution,
} from "./state.js";

export { STAGE_STATE_FILE, stageStatePathFor, createStageRunner } from "./workspace.js";

export {
  WorkerRegistry,
  assertWorkerCapabilities,
  type Worker,
  type WorkerCapabilities,
  type WorkerRef,
  type WorkerRequest,
  type WorkerResult,
} from "./worker.js";

export {
  recordingWorker,
  failingWorker,
  cancellableWorker,
  type RecordingWorker,
  type RecordingWorkerOptions,
} from "./doubles.js";

export { isChargeBearing } from "./paid-dispatch.js";
export { recordingSpendController, type RecordingSpendController } from "./doubles.js";

export type {
  PaidDispatchEvidence,
  PaidDispatchController,
  PaidDispatchReservation,
  PaidDispatchReserveInput,
} from "./paid-dispatch.js";

export type {
  StageAgentDispatcher,
  StageAgentDispatchInput,
  StageAgentDispatchResult,
  StageOwnedAgentRequest,
} from "./agent-dispatch.js";
