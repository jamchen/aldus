/**
 * `@aldus/core` — the generic contracts of the Aldus production runtime.
 *
 * This package implements architecture contract §22 **WP-01 Core schema and testkit**: the
 * domain types, their JSON schemas and validators, identifier generation, schema-version
 * policy, and redaction helpers.
 *
 * What this package deliberately does **not** contain (contract §4.2): show identities, host
 * personas, editorial rules, provider credentials, TTS voices or models, publishing platforms,
 * cloud services, or any adopter-specific filename or convention. Anything provider- or
 * platform-shaped is an opaque string supplied by the caller, never an enumeration defined
 * here. The dependency direction is `Adopter Integration → Aldus public contracts` and never
 * the reverse (§4.3).
 *
 * Not implemented here, by design — each is a separate work package (§22): the file state and
 * event store (WP-02), the artifact registry (WP-03), the stage runner (WP-04), the gate and
 * authorization engine (WP-05), the Knowledge Pack loader (WP-09), the CLI (WP-08), and the
 * Production MCP (WP-11).
 *
 * @packageDocumentation
 */

// --- Errors (§19.1) ---------------------------------------------------------------------------
export {
  AldusError,
  CoreErrorCodes,
  ERROR_CATEGORIES,
  MAX_ERROR_CAUSE_DEPTH,
  structuredErrorSchema,
  toStructuredError,
  truncateCauses,
  type AldusErrorOptions,
  type CoreErrorCode,
  type ErrorCategory,
  type StructuredError,
} from "./errors.js";

// --- Schema version policy (ADR-0003) ---------------------------------------------------------
export {
  SCHEMA_VERSION,
  assertSchemaVersionReadable,
  checkSchemaVersion,
  compareSchemaVersions,
  formatSchemaVersion,
  isSchemaVersion,
  parseSchemaVersion,
  type SchemaCompatibility,
  type SchemaVersion,
} from "./schema-version.js";

// --- Domain schemas and inferred types (§6, §8, §9, §13, §17, §19.3) --------------------------
export * from "./schema/index.js";

// --- Validation (§11, §19.2) ------------------------------------------------------------------
export {
  assertValid,
  assertValidRecord,
  formatIssuePath,
  fromStructuredError,
  validate,
  validateRecord,
  validateWith,
  type RecordValidationResult,
  type ValidationIssue,
  type ValidationResult,
} from "./validate.js";

// --- JSON Schema projection (ADR-0002) --------------------------------------------------------
export {
  JSON_SCHEMA_TARGET,
  SCHEMAS_WITH_UNEXPRESSIBLE_CONSTRAINTS,
  SCHEMA_FILE_NAMES,
  allJsonSchemas,
  schemaId,
  serializeJsonSchema,
  toJsonSchema,
} from "./json-schema.js";

// --- Identifiers (§6.1, §8.1) -----------------------------------------------------------------
export {
  CROCKFORD_ALPHABET,
  ID_PREFIXES,
  ID_PREFIX_VALUES,
  MAX_IDENTITY_SEGMENT_LENGTH,
  MAX_ULID_TIMESTAMP,
  ULID_LENGTH,
  assertId,
  createIdFactory,
  decodeUlidTimestamp,
  defaultIdFactory,
  formatCanonicalId,
  formatEpisodeId,
  isCanonicalId,
  isIdentitySegment,
  isUlid,
  isValidId,
  newArtifactId,
  newCostId,
  newEventId,
  newGateDecisionId,
  newGateId,
  newId,
  newReleaseId,
  newRunId,
  newStageAttemptId,
  newStageExecutionId,
  newUlid,
  parseCanonicalId,
  parseEpisodeId,
  parseId,
  slugify,
  type CanonicalIdParts,
  type IdFactory,
  type IdFactoryOptions,
  type IdPrefix,
  type ParsedId,
} from "./ids.js";

// --- Redaction (§19.2) ------------------------------------------------------------------------
export {
  DEFAULT_MAX_ARRAY_LENGTH,
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_STRING_LENGTH,
  DEFAULT_REDACTION_PLACEHOLDER,
  DEFAULT_SENSITIVE_KEY_PATTERNS,
  DEFAULT_SENSITIVE_VALUE_PATTERNS,
  isSensitiveKey,
  redact,
  redactError,
  redactHeaders,
  redactRecord,
  redactUri,
  type RedactableHeaders,
  type RedactionOptions,
} from "./redaction.js";

// --- Knowledge Packs (§9) ---------------------------------------------------------------------
export {
  authorityRank,
  comparePackStrength,
  DEFAULT_PRECEDENCE_LADDER,
  effectivePrecedence,
  isResolutionClean,
  isResolvable,
  KnowledgeErrorCodes,
  knowledgePackManifestSchema,
  normalizeManifestDocument,
  packApplies,
  packDependencySchema,
  packResourcePath,
  parseJsonManifestSource,
  parsePackManifest,
  parsePackManifestDocument,
  placeOnLadder,
  PRECEDENCE_TIER_STRIDE,
  resolveKnowledgePacks,
  toKnowledgePackRefs,
  type KnowledgeErrorCode,
  type KnowledgePackManifest,
  type ManifestSourceParser,
  type PackConflict,
  type PackDependency,
  type PackIntegrityIssue,
  type PackResolution,
  type ParseManifestOptions,
  type PlacedPack,
  type PrecedenceTier,
  type ResolvedClaim,
  type ResolveOptions,
  type ResourceResolver,
  type TierPlacement,
} from "./knowledge/index.js";
