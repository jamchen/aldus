/**
 * `@aldus-runtime/release` — release bundles, resumable operations, and external-state reconciliation.
 *
 * Implements architecture contract §22 **WP-12 Release adapters** and §17.
 *
 * Contract §22's own wording for this work package names two publishing platforms. This package
 * names none, and that is deliberate: §4.2 keeps publishing platforms out of the runtime, §1.2
 * explicitly rules out prescribing particular release targets, and §4.3 places release
 * configuration in Integration. What ships here is the **adapter contract and the resumable
 * machinery**; an adopter supplies the client that talks to a destination.
 *
 * Not implemented here, by design: any real platform client, the CLI (WP-08), the Production MCP
 * (WP-11), and the TTS ledger (WP-07).
 *
 * @packageDocumentation
 */

export {
  AdapterRegistry,
  RecordingReleaseAdapter,
  type AdapterOutcome,
  type RecordingAdapterOptions,
  type ReleaseAdapter,
  type ReleaseRequest,
  type RemoteState,
} from "./adapter.js";

export {
  gateEngineAuthorizer,
  permitAllAuthorizer,
  type AuthorityVerdict,
  type ReleaseAuthorizer,
} from "./authorization.js";

export {
  assertBundleValid,
  deriveIdempotencyKey,
  operationsOf,
  type ReleaseBundle,
} from "./bundle.js";

export { ReleaseErrorCodes, releaseError, type ReleaseErrorCode } from "./errors.js";

export {
  OPERATION_STATES,
  ReleaseExecutor,
  type BundleStatus,
  type ExecuteOptions,
  type OperationState,
  type OperationStatus,
  type ReconciliationFinding,
  type ReconciliationReport,
  type ReleaseExecutorOptions,
  type ReleaseOutcome,
} from "./executor.js";

export {
  bestEffortOperation,
  requiredOperation,
  type BestEffortOperation,
  type OperationCriticality,
  type ReleaseOperation,
  type ReleaseOperationBase,
  type RequiredOperation,
} from "./operation.js";

export {
  MemoryReleaseEventSink,
  MemoryReleaseReceiptStore,
  eventStoreSink,
  latestByKey,
  runStoreReceipts,
  type ReleaseEventSink,
  type ReleaseReceiptStore,
} from "./ports.js";
