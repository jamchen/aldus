/**
 * Failures specific to release execution.
 *
 * Aldus Core deliberately keeps no central error-code registry, so that a package can name a new
 * failure without forking Core. These codes are this package's contribution; they carry the same
 * `ALDUS_` prefix and `SCREAMING_SNAKE_CASE` shape so production trace (contract §20) stays
 * uniform across packages.
 */

import { AldusError, type ErrorCategory } from "@aldus-runtime/core";

/** Error codes raised by the release executor. */
export const ReleaseErrorCodes = {
  /**
   * An operation was attempted that no gate authorizes.
   *
   * Contract §13.4 binds release approval to the final render, captions, metadata, destination,
   * and visibility policy, and §17 requires uploading and making public to be separate
   * operations. An unauthorized release is refused rather than warned about: a warning that
   * still publishes is not a gate.
   */
  RELEASE_NOT_AUTHORIZED: "ALDUS_RELEASE_NOT_AUTHORIZED",
  /** No adapter is registered for an operation's destination. */
  ADAPTER_NOT_REGISTERED: "ALDUS_RELEASE_ADAPTER_NOT_REGISTERED",
  /** A bundle declared two operations with the same `operationId`. */
  DUPLICATE_OPERATION: "ALDUS_RELEASE_DUPLICATE_OPERATION",
  /** A bundle was constructed with no operations at all. */
  EMPTY_BUNDLE: "ALDUS_RELEASE_EMPTY_BUNDLE",
  /**
   * An operation declaration is not usable as written (#169).
   *
   * Today: a repeatable declaration with no reason. It licenses performing an external effect more
   * than once, and an approver cannot accept that from a bare flag (§13.4, §17).
   */
  OPERATION_INVALID: "ALDUS_RELEASE_OPERATION_INVALID",
  /**
   * A required operation failed, so the release did not complete.
   *
   * Distinct from a best-effort failure, which is recorded and does not fail the release
   * (contract §17: "Pre-release hard gates and post-upload best-effort operations MUST be
   * distinguished").
   */
  REQUIRED_OPERATION_FAILED: "ALDUS_RELEASE_REQUIRED_OPERATION_FAILED",
  /**
   * A stored receipt disagrees with the bundle that produced it.
   *
   * The identity of an operation is its `operationId` plus its idempotency key. A receipt whose
   * key no longer matches describes a different operation than the one about to run, and reusing
   * it would let changed inputs inherit an old approval's outcome.
   */
  RECEIPT_MISMATCH: "ALDUS_RELEASE_RECEIPT_MISMATCH",
  /**
   * Reconciliation was required but the adapter cannot look up remote state.
   *
   * Contract §17 requires operations to be resumable "where the platform allows it". Where it
   * does not, the honest outcome is to say so rather than to re-execute and risk a duplicate
   * publish.
   */
  RECONCILIATION_UNAVAILABLE: "ALDUS_RELEASE_RECONCILIATION_UNAVAILABLE",
} as const;

/** @see ReleaseErrorCodes */
export type ReleaseErrorCode = (typeof ReleaseErrorCodes)[keyof typeof ReleaseErrorCodes];

/** Construct an {@link AldusError} with a release code. */
export function releaseError(
  code: ReleaseErrorCode,
  message: string,
  options: { category: ErrorCategory; retryable?: boolean; details?: Record<string, unknown> },
): AldusError {
  return new AldusError(code, message, options);
}
