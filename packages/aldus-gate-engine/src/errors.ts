/**
 * Failures specific to gate evaluation and spend authorization.
 *
 * Aldus Core deliberately keeps no central error-code registry, so that a package can name a new
 * failure without forking Core. These codes are this package's contribution; they carry the same
 * `ALDUS_` prefix and `SCREAMING_SNAKE_CASE` shape so production trace (contract §20) stays
 * uniform across packages.
 */

import { AldusError, type ErrorCategory } from "@aldus/core";

/** Error codes raised by the gate engine. */
export const GateEngineErrorCodes = {
  /** A gate was referenced that is not registered. */
  GATE_NOT_FOUND: "ALDUS_GATE_NOT_FOUND",
  /** A gate definition is internally inconsistent and was refused at registration. */
  GATE_DEFINITION_INVALID: "ALDUS_GATE_DEFINITION_INVALID",
  /**
   * Gate dependencies form a cycle.
   *
   * A configuration fault, not a data fault: contract §13.1's cascade is only meaningful over a
   * directed acyclic graph, and a cycle would make "what does this invalidate" unanswerable.
   */
  GATE_DEPENDENCY_CYCLE: "ALDUS_GATE_DEPENDENCY_CYCLE",
  /**
   * A decision was submitted by an actor the gate does not accept.
   *
   * Contract §13.3 keeps final performance approval human-owned, and §12 reserves the human
   * oracle level for subjective and asymmetric-risk judgements. A machine actor satisfying such
   * a gate would present a machine pass as semantic correctness, which §12 forbids outright.
   */
  GATE_ACTOR_NOT_PERMITTED: "ALDUS_GATE_ACTOR_NOT_PERMITTED",
  /** A decision was submitted that does not bind the subjects its gate requires. */
  GATE_SUBJECTS_INCOMPLETE: "ALDUS_GATE_SUBJECTS_INCOMPLETE",
  /**
   * An operation requiring authorization was attempted without a valid one.
   *
   * Contract §13.2: paid TTS MUST NOT run until the operator approves. This is the refusal that
   * enforces it.
   */
  AUTHORIZATION_MISSING: "ALDUS_AUTHORIZATION_MISSING",
  /**
   * An authorization exists but no longer binds the current inputs.
   *
   * Contract §13.2: "The authorization MUST be invalidated if any bound value changes."
   */
  AUTHORIZATION_STALE: "ALDUS_AUTHORIZATION_STALE",
  /** A spend request would exceed the authorized maximum (contract §19.3 stop-on-budget). */
  SPEND_LIMIT_EXCEEDED: "ALDUS_SPEND_LIMIT_EXCEEDED",
  /** Two monetary values in different currencies were combined or compared. */
  CURRENCY_MISMATCH: "ALDUS_CURRENCY_MISMATCH",
  /** A monetary amount was not a well-formed decimal string. */
  MONEY_MALFORMED: "ALDUS_MONEY_MALFORMED",
} as const;

/** @see GateEngineErrorCodes */
export type GateEngineErrorCode = (typeof GateEngineErrorCodes)[keyof typeof GateEngineErrorCodes];

/** Construct an {@link AldusError} with a gate-engine code. */
export function gateEngineError(
  code: GateEngineErrorCode,
  message: string,
  options: { category: ErrorCategory; retryable?: boolean; details?: Record<string, unknown> },
): AldusError {
  return new AldusError(code, message, options);
}
