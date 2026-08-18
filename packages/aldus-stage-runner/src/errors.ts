/**
 * Failures specific to stage execution.
 *
 * Aldus Core deliberately keeps no central error-code registry, so a package can name a new
 * failure without forking Core. These codes are this package's contribution; they carry the same
 * `ALDUS_` prefix and `SCREAMING_SNAKE_CASE` shape so production trace (contract §20) stays
 * uniform across packages.
 */

import { AldusError, type ErrorCategory } from "@aldus/core";

/** Error codes raised by the stage runner. */
export const StageRunnerErrorCodes = {
  /** A stage was requested that is not registered. */
  STAGE_NOT_REGISTERED: "ALDUS_STAGE_NOT_REGISTERED",
  /** A stage was registered under an `id` and `version` pair that is already taken. */
  STAGE_ALREADY_REGISTERED: "ALDUS_STAGE_ALREADY_REGISTERED",
  /** Input did not satisfy the stage's declared input schema (contract §11). */
  STAGE_INPUT_INVALID: "ALDUS_STAGE_INPUT_INVALID",
  /**
   * A stage returned a value that does not satisfy its own declared output schema (contract §11).
   *
   * A stage failure, not a runner failure: §11 requires a stage to "produce declared outputs or a
   * structured failure", and a value that satisfies neither is the stage breaking its contract.
   */
  STAGE_OUTPUT_INVALID: "ALDUS_STAGE_OUTPUT_INVALID",
  /** A stage's `execute` threw or rejected. */
  STAGE_EXECUTION_FAILED: "ALDUS_STAGE_EXECUTION_FAILED",
  /**
   * The backend does not offer a capability the stage declared as required (contract §10).
   *
   * Raised before execution: a stage that needs filesystem access and is handed a backend without
   * it should fail on the declaration, not halfway through its side effects.
   */
  STAGE_CAPABILITY_UNAVAILABLE: "ALDUS_STAGE_CAPABILITY_UNAVAILABLE",
  /** The stage's retry budget was exhausted without a success (contract §19.1). */
  STAGE_RETRIES_EXHAUSTED: "ALDUS_STAGE_RETRIES_EXHAUSTED",
  /** Execution was cancelled by an operator or a supervising runtime (contract §19.1). */
  STAGE_CANCELLED: "ALDUS_STAGE_CANCELLED",
  /**
   * A stage execution was asked to advance from a state it cannot advance from.
   *
   * For example, retrying a stage whose latest attempt is `waiting_for_gate`: the gate has to be
   * decided first (WP-05), and running anyway would step past a human decision §13 requires.
   */
  STAGE_STATE_INVALID: "ALDUS_STAGE_STATE_INVALID",
  /** Stored stage state could not be parsed or did not validate. */
  STAGE_STATE_MALFORMED: "ALDUS_STAGE_STATE_MALFORMED",
} as const;

/** @see StageRunnerErrorCodes */
export type StageRunnerErrorCode =
  (typeof StageRunnerErrorCodes)[keyof typeof StageRunnerErrorCodes];

/** Construct an {@link AldusError} with a stage-runner code. */
export function stageRunnerError(
  code: StageRunnerErrorCode,
  message: string,
  options: { category: ErrorCategory; retryable?: boolean; details?: Record<string, unknown> },
): AldusError {
  return new AldusError(code, message, options);
}
