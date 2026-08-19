/**
 * Failures specific to the artifact registry.
 *
 * Aldus Core deliberately keeps no central error-code registry, so that a package can name a new
 * failure without forking Core. These codes are this package's contribution; they carry the same
 * `ALDUS_` prefix and `SCREAMING_SNAKE_CASE` shape so production trace (contract §20) stays
 * uniform across packages.
 */

import { AldusError, type ErrorCategory } from "@aldus-runtime/core";

/** Error codes raised by the artifact registry. */
export const ArtifactRegistryErrorCodes = {
  /** An artifact was requested that has never been registered. */
  ARTIFACT_NOT_FOUND: "ALDUS_ARTIFACT_NOT_FOUND",
  /**
   * An artifact ID was registered twice with different content.
   *
   * Contract §8.1 makes `artifactId` plus `sha256` the identity of an artifact. Rebinding an ID
   * to different bytes would silently redirect every approval that referenced it (§13).
   */
  ARTIFACT_ID_CONFLICT: "ALDUS_ARTIFACT_ID_CONFLICT",
  /** The registry index held bytes that are not valid JSON, or not the expected shape. */
  REGISTRY_MALFORMED: "ALDUS_REGISTRY_MALFORMED",
  /** A digest did not match the bytes it was supposed to describe. */
  DIGEST_MISMATCH: "ALDUS_DIGEST_MISMATCH",
  /** A digest was not 64 lowercase hexadecimal characters. */
  DIGEST_MALFORMED: "ALDUS_DIGEST_MALFORMED",
  /** An archive operation could not complete, so the artifact remains unarchived. */
  ARCHIVE_FAILED: "ALDUS_ARCHIVE_FAILED",
  /** Bytes read back from the archive did not match the digest they were stored under. */
  ARCHIVE_CORRUPT: "ALDUS_ARCHIVE_CORRUPT",
  /**
   * A cleanup would have removed an irreplaceable artifact that is not archived.
   *
   * Contract §8.1: "Irreplaceable artifacts MUST be archived before disposable working files are
   * cleaned." This is the refusal that makes that ordering real rather than advisory.
   */
  CLEANUP_BLOCKED: "ALDUS_CLEANUP_BLOCKED",
  /**
   * A cleanup plan cleared a file, and the bytes at that path are no longer the bytes it cleared.
   *
   * The plan is computed from a records snapshot; the delete happens later. Between the two, a
   * working path can be rewritten and re-registered — §8.1's `req-00.wav` case exactly. Executing
   * the stale plan would delete bytes nothing ever cleared, which for an `irreplaceable` artifact
   * is unrecoverable.
   */
  CLEANUP_STALE_PLAN: "ALDUS_CLEANUP_STALE_PLAN",
  /** A lineage query found a cycle in recorded edges, which cannot occur in correct data. */
  LINEAGE_CYCLE: "ALDUS_LINEAGE_CYCLE",
} as const;

/** @see ArtifactRegistryErrorCodes */
export type ArtifactRegistryErrorCode =
  (typeof ArtifactRegistryErrorCodes)[keyof typeof ArtifactRegistryErrorCodes];

/** Construct an {@link AldusError} with an artifact-registry code. */
export function artifactRegistryError(
  code: ArtifactRegistryErrorCode,
  message: string,
  options: { category: ErrorCategory; retryable?: boolean; details?: Record<string, unknown> },
): AldusError {
  return new AldusError(code, message, options);
}
