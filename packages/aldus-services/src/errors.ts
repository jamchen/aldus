/**
 * Failures specific to the application-service layer.
 *
 * Aldus Core deliberately keeps no central error-code registry, so a package can name a new
 * failure without forking Core. These are this package's contribution, carrying the same
 * `ALDUS_` prefix and `SCREAMING_SNAKE_CASE` shape so production trace (contract §20) stays
 * uniform across packages.
 */

import { AldusError, type ErrorCategory } from "@aldus-runtime/core";

/** Error codes raised by the application services. */
export const ServiceErrorCodes = {
  /**
   * A paid execution was refused before it ran (contract §13.2, §19.3).
   *
   * Raised before dispatch, deliberately: a refusal that arrives once the provider has been
   * billed is not a refusal. Covers an estimate with no grant to check it against, a grant
   * already exhausted, and one already overspent.
   */
  SPEND_NOT_AUTHORIZED: "ALDUS_SPEND_NOT_AUTHORIZED",
  /**
   * A mutating operation was attempted without a recorded actor.
   *
   * Contract §19.2: "Mutating actions MUST record actor identity." An anonymous mutation is
   * refused outright rather than attributed to a placeholder, because a decision recorded
   * against "unknown" is indistinguishable from one nobody made (§3.6).
   */
  ACTOR_REQUIRED: "ALDUS_ACTOR_REQUIRED",
  /** An actor was supplied but is not a well-formed `ActorRef`. */
  ACTOR_INVALID: "ALDUS_ACTOR_INVALID",
  /** The named Run does not exist in this workspace. */
  RUN_NOT_FOUND: "ALDUS_RUN_NOT_FOUND",
  /** The workspace has no Episode, so there is nothing to produce. */
  EPISODE_NOT_FOUND: "ALDUS_EPISODE_NOT_FOUND",
  /** An identifier was supplied that names neither an Episode nor a Run. */
  SUBJECT_NOT_FOUND: "ALDUS_SUBJECT_NOT_FOUND",
  /** A workspace already holds an Episode and `init` was asked to create another. */
  EPISODE_ALREADY_EXISTS: "ALDUS_EPISODE_ALREADY_EXISTS",
  /** Arguments were internally inconsistent or incomplete. */
  INVALID_REQUEST: "ALDUS_INVALID_REQUEST",
  /**
   * An operation needs an injected adapter that was never wired.
   *
   * ADR-0015 makes Aldus responsible for composing its packages and the adopter responsible for
   * supplying concrete adapters. A missing adapter is therefore a wiring error, not a policy
   * refusal: nothing an operator can approve will make it appear.
   */
  ADAPTER_NOT_WIRED: "ALDUS_ADAPTER_NOT_WIRED",
  /** A stored TTS ledger file is not the shape it should be. */
  LEDGER_FILE_MALFORMED: "ALDUS_LEDGER_FILE_MALFORMED",
  /** A take was addressed that the ledger does not hold. */
  LEDGER_TAKE_NOT_FOUND: "ALDUS_LEDGER_TAKE_NOT_FOUND",
  /** A plan was addressed that the ledger does not hold. */
  LEDGER_PLAN_NOT_FOUND: "ALDUS_LEDGER_PLAN_NOT_FOUND",
  /** An artifact was addressed that the registry does not hold. */
  ARTIFACT_NOT_REGISTERED: "ALDUS_ARTIFACT_NOT_REGISTERED",
} as const;

/** @see ServiceErrorCodes */
export type ServiceErrorCode = (typeof ServiceErrorCodes)[keyof typeof ServiceErrorCodes];

/** Construct an {@link AldusError} with a service code. */
export function serviceError(
  code: ServiceErrorCode,
  message: string,
  options: { category: ErrorCategory; retryable?: boolean; details?: Record<string, unknown> },
): AldusError {
  return new AldusError(code, message, options);
}
