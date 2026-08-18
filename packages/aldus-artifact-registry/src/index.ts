/**
 * `@aldus-runtime/artifact-registry` — artifact identity, provenance, lineage, archival, and cleanup
 * policy for the Aldus runtime.
 *
 * Implements architecture contract §22 **WP-03 Artifact registry**: SHA-256 and metadata
 * collection, reconstructability policy, an archive adapter, collision-safe paths, and lineage
 * queries, over contract §8.
 *
 * The rules it exists to enforce (§8.1):
 *
 * - a path or filename is never identity — `artifactId` plus `sha256` is;
 * - an artifact records which stage, run, code revision, and configuration produced it;
 * - irreplaceable artifacts are archived **before** disposable working files are cleaned;
 * - a provider seed is recorded but never treated as a reproducibility guarantee;
 * - generic names such as `req-00.wav` cannot overwrite accepted audio from another Episode.
 *
 * This package records and retains. It does not decide which take is accepted (§13.3, WP-05 and
 * WP-07), bundle a release (WP-12), or enforce a retention schedule — it reports what retention
 * would permit and leaves the decision to a caller.
 *
 * @packageDocumentation
 */

export {
  LocalDirectoryArchive,
  MemoryArtifactArchive,
  joinPath,
  localPathFromUri,
  writeBytes,
  type ArchiveRequest,
  type ArtifactArchive,
  type LocalDirectoryArchiveOptions,
} from "./archive.js";

export {
  isArchived,
  planCleanup,
  requiresArchiveBeforeCleanup,
  type CleanupBlock,
  type CleanupPlan,
} from "./cleanup.js";

export {
  digestConfiguration,
  digestFile,
  isSha256Hex,
  normaliseDigest,
  sha256Bytes,
  sha256File,
  verifyFileDigest,
  type FileDigest,
} from "./digest.js";

export {
  ArtifactRegistryErrorCodes,
  artifactRegistryError,
  type ArtifactRegistryErrorCode,
} from "./errors.js";

export {
  LineageGraph,
  type LineageEdge,
  type LineageResult,
  type ProducerInfo,
} from "./lineage.js";

export {
  ARCHIVE_DIRECTORY,
  ARTIFACTS_DIRECTORY,
  ARTIFACT_INDEX_FILE,
  ARTIFACT_INDEX_LOCK_RESOURCE,
  ArtifactLayout,
  objectPath,
  objectRelativePath,
  readableFileName,
  sanitiseFileName,
} from "./paths.js";

export {
  archiveReceiptSchema,
  artifactIndexSchema,
  artifactProvenanceSchema,
  artifactRecordSchema,
  emptyIndex,
  type ArchiveReceipt,
  type ArtifactIndex,
  type ArtifactProvenance,
  type ArtifactRecord,
} from "./record.js";

export {
  ArtifactRegistry,
  type ArtifactRegistryOptions,
  type CleanupOutcome,
  type RegisterArtifactInput,
} from "./registry.js";

export { FileArtifactStore, type ArtifactStore } from "./store.js";
