/**
 * Failures specific to stage execution.
 *
 * Aldus Core deliberately keeps no central error-code registry, so a package can name a new
 * failure without forking Core. These codes are this package's contribution; they carry the same
 * `ALDUS_` prefix and `SCREAMING_SNAKE_CASE` shape so production trace (contract §20) stays
 * uniform across packages.
 */

import { AldusError, type ErrorCategory } from "@aldus-runtime/core";

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
  /**
   * A stage asked for a Worker that is not registered under that exact id and version (ADR-0035).
   *
   * Versions resolve exactly and nothing selects a nearest or latest one: §20 requires a completed
   * Run to stay explicable, and a registry that silently upgraded would make the trace describe an
   * implementation that did not run.
   */
  /**
   * A stage declares a deduplicable external effect and supplies no key derivation (ADR-0036).
   *
   * A configuration error rather than a warning. The alternative is silently handing the stage the
   * runtime-derived invocation fingerprint, which is stable across content the stage read but did
   * not declare — and the consumer is an external system nobody here can ask.
   */
  /**
   * A stage's evaluator declaration is internally inconsistent (contract §12, §12.1; #115).
   *
   * Refused at registration rather than warned about. §12.1 makes blocking a promotion with
   * evidence behind it, and a claim that contradicts itself — an advisory signal declared
   * blocking, a model-assisted channel blocking with no evidence, two claims about one finding
   * class — is not a stricter policy but an unanswerable one.
   */
  STAGE_EVALUATION_INVALID: "ALDUS_STAGE_EVALUATION_INVALID",
  /**
   * An evaluator ran and found something its declared channels say stops work (§12).
   *
   * Deliberately distinct from a stage that failed. §12's four levels are about what a mechanism
   * *decides*, and a checker reporting a defect is the mechanism working — an adopter whose
   * linter crashed on every run had the crash counted as a soft finding for a whole migration
   * because nothing told the two apart.
   */
  STAGE_EVALUATION_BLOCKED: "ALDUS_STAGE_EVALUATION_BLOCKED",
  STAGE_EFFECT_KEY_REQUIRED: "ALDUS_STAGE_EFFECT_KEY_REQUIRED",
  WORKER_NOT_REGISTERED: "ALDUS_WORKER_NOT_REGISTERED",
  /**
   * A different Worker object was registered under an id and version already in use.
   *
   * Rebinding a version is refused for the same reason a stage version cannot be rebound: a Run
   * that executed the earlier implementation would afterwards read as having executed this one.
   */
  WORKER_ALREADY_REGISTERED: "ALDUS_WORKER_ALREADY_REGISTERED",
  /**
   * A Worker does not offer a capability the stage requires (§10, §11).
   *
   * Fails closed: a Worker declaring nothing does not thereby satisfy a requirement. A capability
   * check that passes because it could not run is worse than absent, because a reader counts it
   * as protection that is not there (ADR-0030).
   */
  WORKER_CAPABILITY_UNAVAILABLE: "ALDUS_WORKER_CAPABILITY_UNAVAILABLE",
  /**
   * A stage invoked a Worker in a composition that wired no Worker registry (ADR-0035).
   *
   * Deliberately a refusal rather than a no-op. The capability that exists and is unreachable is
   * the defect #67 was, and a Worker seam nothing wired would repeat it one layer up.
   */
  WORKER_REGISTRY_UNAVAILABLE: "ALDUS_WORKER_REGISTRY_UNAVAILABLE",
  /** The stage's retry budget was exhausted without a success (contract §19.1). */
  STAGE_RETRIES_EXHAUSTED: "ALDUS_STAGE_RETRIES_EXHAUSTED",
  /** Execution was cancelled by an operator or a supervising runtime (contract §19.1). */
  STAGE_CANCELLED: "ALDUS_STAGE_CANCELLED",
  /**
   * A stage called `registerOutput` but no artifact recorder is wired (contract §8, ADR-0027).
   *
   * A wiring error, not a policy refusal: no approval an operator could grant makes a recorder
   * appear, so it is not retryable. Refusing beats silently doing nothing — a stage that
   * believed it registered an irreplaceable take and did not would find out the day a cleanup
   * removed the bytes (§8.1).
   */
  ARTIFACT_RECORDER_UNAVAILABLE: "ALDUS_ARTIFACT_RECORDER_UNAVAILABLE",
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
