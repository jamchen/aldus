/**
 * `@aldus-runtime/file-store` — file-backed state and event storage for the Aldus runtime.
 *
 * Implements architecture contract §22 **WP-02 File state and event store**: atomic manifest
 * writes, an append-only JSONL event log, file locking, materialized current state, and recovery
 * from interrupted writes, over the local layout §7 recommends.
 *
 * This package stores and retrieves records. It does not interpret them: stage execution is
 * WP-04, gate evaluation is WP-05, and artifact lineage is WP-03.
 *
 * Physical storage stays behind {@link EpisodeStore}, {@link RunStore}, and {@link EventStore}
 * so that §7's requirement is structural rather than aspirational: the databases, object stores,
 * and cloud drives §7 lists must remain possible as adapters instead of becoming assumptions.
 * Core deliberately names none of them, and neither does this package (§4.2).
 *
 * @packageDocumentation
 */

export {
  appendLineSynced,
  createExclusive,
  isAlreadyExists,
  isNotFound,
  overwrite,
  readFileOrUndefined,
  removeIfPresent,
  writeFileAtomic,
  type AtomicWriteHooks,
  type AtomicWriteOptions,
} from "./atomic.js";

export { appendToCollection, readCollection, type StoredCollection } from "./collections.js";

export {
  isPlainObject,
  mergeForWrite,
  preserveUnknown,
  readDocument,
  writeDocument,
  type StoredDocument,
} from "./document.js";

export { FileStoreErrorCodes, fileStoreError, type FileStoreErrorCode } from "./errors.js";

export {
  parseJsonLines,
  readJsonLines,
  toJsonLine,
  type JsonLinesReadResult,
  type ReadJsonLinesOptions,
} from "./jsonl.js";

export {
  ALDUS_DIRECTORY,
  EPISODE_LOCK_RESOURCE,
  RUN_FILES,
  WorkspaceLayout,
  runLockResource,
  type RunFileName,
} from "./layout.js";

export {
  DEFAULT_LOCK_RETRY_MS,
  DEFAULT_LOCK_TIMEOUT_MS,
  DEFAULT_LOCK_TTL_MS,
  FileLockManager,
  type AcquireOptions,
  type FileLockManagerOptions,
  type Lease,
  type LockManager,
} from "./lock.js";

export type {
  EpisodeStore,
  EventReadOptions,
  EventReadResult,
  EventStore,
  RunCollectionName,
  RunCollectionTypes,
  RunStore,
} from "./ports.js";

export {
  FileEpisodeStore,
  FileEventStore,
  FileRunStore,
  RUN_COLLECTION_SCHEMAS,
  nextSequenceOf,
} from "./stores.js";

export {
  FileWorkspace,
  initWorkspace,
  openWorkspace,
  type OpenWorkspaceOptions,
} from "./workspace.js";

export {
  FileSpendReservationStore,
  type CompareAndAppendResult,
  type FileSpendReservationStoreOptions,
  type GrantReservationStream,
  type SpendReservationStore,
} from "./reservation-store.js";
