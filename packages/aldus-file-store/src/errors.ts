/**
 * Failures specific to file-backed storage.
 *
 * Aldus Core deliberately keeps no central error-code registry, so that a package can name a new
 * failure without forking Core. These codes are this package's contribution; they carry the same
 * `ALDUS_` prefix and `SCREAMING_SNAKE_CASE` shape so production trace (contract §20) stays
 * uniform across packages.
 */

import { AldusError, type ErrorCategory } from "@aldus-runtime/core";

/** Error codes raised by the file store. */
export const FileStoreErrorCodes = {
  /** The `.aldus` workspace directory does not exist, or is not a directory. */
  WORKSPACE_NOT_FOUND: "ALDUS_WORKSPACE_NOT_FOUND",
  /** A record was requested that has never been written. */
  RECORD_NOT_FOUND: "ALDUS_RECORD_NOT_FOUND",
  /** A stored file held bytes that are not valid JSON. */
  RECORD_MALFORMED: "ALDUS_RECORD_MALFORMED",
  /**
   * An event log line in the interior of the file could not be parsed.
   *
   * Distinct from a torn tail: a bad line in the middle means bytes were lost or overwritten
   * inside an append-only file, which is corruption. See {@link FileStoreErrorCodes.EVENT_LOG_TORN_TAIL}.
   */
  EVENT_LOG_CORRUPT: "ALDUS_EVENT_LOG_CORRUPT",
  /**
   * The final line of an event log was truncated, and the caller asked for strict reads.
   *
   * Recoverable by design: a process that died mid-append leaves exactly this, and everything
   * before the torn line is intact (contract §19.1 "recovery from partial success").
   */
  EVENT_LOG_TORN_TAIL: "ALDUS_EVENT_LOG_TORN_TAIL",
  /** An event was appended out of sequence order (ADR-0005). */
  EVENT_OUT_OF_SEQUENCE: "ALDUS_EVENT_OUT_OF_SEQUENCE",
  /** An event was appended whose `eventId` already exists in the log. */
  EVENT_DUPLICATE: "ALDUS_EVENT_DUPLICATE",
  /** A lock could not be acquired before the caller's deadline. */
  LOCK_TIMEOUT: "ALDUS_LOCK_TIMEOUT",
  /** A lock was released or renewed by something that no longer holds it. */
  LOCK_LOST: "ALDUS_LOCK_LOST",
  /** A reservation transition does not satisfy its schema (ADR-0044). */
  RESERVATION_TRANSITION_INVALID: "ALDUS_RESERVATION_TRANSITION_INVALID",
  /** One transition id was reused for a different fact (ADR-0044). */
  RESERVATION_TRANSITION_CONFLICT: "ALDUS_RESERVATION_TRANSITION_CONFLICT",
  /** A reservation stream has a gap, which no correct writer can produce (ADR-0044). */
  RESERVATION_STREAM_CORRUPT: "ALDUS_RESERVATION_STREAM_CORRUPT",
  /**
   * A lock was re-acquired inside a scope that already holds it.
   *
   * File locks are not re-entrant, so this can never succeed: the acquirer is waiting on itself
   * and would spin until the acquisition deadline. Distinct from {@link LOCK_TIMEOUT}, which
   * means another session genuinely holds the lock — this one means the caller's own design is
   * wrong, and no amount of retrying will fix it.
   */
  LOCK_REENTRANT: "ALDUS_LOCK_REENTRANT",
  /** A write was attempted against a record whose identity does not match its location. */
  RECORD_IDENTITY_MISMATCH: "ALDUS_RECORD_IDENTITY_MISMATCH",
} as const;

/** @see FileStoreErrorCodes */
export type FileStoreErrorCode = (typeof FileStoreErrorCodes)[keyof typeof FileStoreErrorCodes];

/** Construct an {@link AldusError} with a file-store code. */
export function fileStoreError(
  code: FileStoreErrorCode,
  message: string,
  options: { category: ErrorCategory; retryable?: boolean; details?: Record<string, unknown> },
): AldusError {
  return new AldusError(code, message, options);
}
