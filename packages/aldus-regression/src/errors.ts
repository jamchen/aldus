/**
 * Failures specific to the regression harness.
 *
 * Aldus Core deliberately keeps no central error-code registry, so a package can name a new
 * failure without forking Core. These codes carry the same `ALDUS_` prefix and
 * `SCREAMING_SNAKE_CASE` shape so production trace (contract §20) stays uniform across packages.
 */

import { AldusError, type ErrorCategory } from "@aldus/core";

/** Error codes raised by the regression harness. */
export const RegressionErrorCodes = {
  /** A defect corpus contained a case that does not validate. */
  CORPUS_MALFORMED: "ALDUS_CORPUS_MALFORMED",
  /** Two cases in one corpus share a `caseId`. */
  CORPUS_DUPLICATE_CASE: "ALDUS_CORPUS_DUPLICATE_CASE",
  /** An evaluator outcome referenced a `caseId` the corpus does not contain. */
  OUTCOME_UNKNOWN_CASE: "ALDUS_OUTCOME_UNKNOWN_CASE",
  /** Two outcomes in one run reported on the same `caseId`. */
  OUTCOME_DUPLICATE: "ALDUS_OUTCOME_DUPLICATE",
  /**
   * A case carries a severity the policy assigns no weight to.
   *
   * Refused rather than defaulted: silently weighting an unknown severity as zero would drop a
   * missed defect out of the severity-weighted recall that contract §12.1 requires be
   * considered, and the metric would still report a number.
   */
  SEVERITY_UNWEIGHTED: "ALDUS_SEVERITY_UNWEIGHTED",
  /** A correction class was referenced that the policy assigns no harm weight to. */
  CORRECTION_CLASS_UNWEIGHTED: "ALDUS_CORRECTION_CLASS_UNWEIGHTED",
  /** A blind-spot record does not validate. */
  BLIND_SPOT_MALFORMED: "ALDUS_BLIND_SPOT_MALFORMED",
  /** Two blind spots share a `blindSpotId`. */
  BLIND_SPOT_DUPLICATE: "ALDUS_BLIND_SPOT_DUPLICATE",
  /** A promotion policy is internally inconsistent — a threshold outside its valid range. */
  POLICY_INVALID: "ALDUS_POLICY_INVALID",
} as const;

/** @see RegressionErrorCodes */
export type RegressionErrorCode = (typeof RegressionErrorCodes)[keyof typeof RegressionErrorCodes];

/** Construct an {@link AldusError} with a regression-harness code. */
export function regressionError(
  code: RegressionErrorCode,
  message: string,
  options: { category: ErrorCategory; retryable?: boolean; details?: Record<string, unknown> },
): AldusError {
  return new AldusError(code, message, options);
}
