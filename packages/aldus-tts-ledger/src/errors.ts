/**
 * Failures specific to the TTS ledger.
 *
 * Aldus Core deliberately keeps no central error-code registry, so a package can name a new
 * failure without forking Core. These carry the same `ALDUS_` prefix and `SCREAMING_SNAKE_CASE`
 * shape as every other package's, so production trace (contract §20) stays uniform.
 */

import { AldusError, type ErrorCategory } from "@aldus/core";

/** Error codes raised by the TTS ledger. */
export const TtsLedgerErrorCodes = {
  /**
   * A paid take was recorded without a valid authorization (contract §13.2).
   *
   * §13.2 forbids paid synthesis until the operator approves, and voids that approval once any
   * bound value changes. Recording a charge under a void approval would leave the ledger
   * asserting that spend was authorized when it was not.
   */
  UNAUTHORIZED_CHARGE: "ALDUS_TTS_UNAUTHORIZED_CHARGE",
  /**
   * A take was recorded against a request plan whose digest does not match the authorized one.
   *
   * Distinct from {@link UNAUTHORIZED_CHARGE}: the authorization is valid, but it authorized a
   * different request. §13.2 binds the request plan, so substituting one after approval is the
   * failure the binding exists to catch.
   */
  PLAN_MISMATCH: "ALDUS_TTS_PLAN_MISMATCH",
  /** A request plan, take, or segment was referenced that the ledger has never recorded. */
  NOT_FOUND: "ALDUS_TTS_NOT_FOUND",
  /** A record was registered twice under one identity with different content. */
  IDENTITY_CONFLICT: "ALDUS_TTS_IDENTITY_CONFLICT",
  /** Stored ledger bytes were not valid JSON, or not the expected shape. */
  LEDGER_MALFORMED: "ALDUS_TTS_LEDGER_MALFORMED",
  /** A PerformanceScript could not be derived from its authored source. */
  DERIVATION_FAILED: "ALDUS_TTS_DERIVATION_FAILED",
  /**
   * A take lineage query found a cycle, which cannot occur in correct data.
   *
   * A take supersedes an earlier take, so the chain is strictly backwards in time. A cycle means
   * a writer produced impossible data, and a query that looped forever would be worse than one
   * that says so.
   */
  LINEAGE_CYCLE: "ALDUS_TTS_LINEAGE_CYCLE",
  /** Two normative lexicon entries claim the same written form at the same specificity. */
  LEXICON_CONFLICT: "ALDUS_TTS_LEXICON_CONFLICT",
  /** A decision was recorded on a take that already carries one. */
  TAKE_ALREADY_DECIDED: "ALDUS_TTS_TAKE_ALREADY_DECIDED",
} as const;

/** @see TtsLedgerErrorCodes */
export type TtsLedgerErrorCode = (typeof TtsLedgerErrorCodes)[keyof typeof TtsLedgerErrorCodes];

/** Construct an {@link AldusError} with a TTS-ledger code. */
export function ttsLedgerError(
  code: TtsLedgerErrorCode,
  message: string,
  options: { category: ErrorCategory; retryable?: boolean; details?: Record<string, unknown> },
): AldusError {
  return new AldusError(code, message, options);
}
