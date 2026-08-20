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
  type StageDefinition,
  type StageIdempotency,
  type StageOutcome,
  type StageOutputRegistration,
  type StageProvenanceExtras,
  type StageRunResult,
  type StageSchema,
  type StageSchemaResult,
  deriveInvocationKey,
  type EffectKeyContext,
  type StageEvaluationChannel,
  type StageEvaluationDeclaration,
  type StageWorkerRequest,
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
