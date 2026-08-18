/**
 * Service results.
 *
 * Contract §18 requires core behaviour to be available through a programmatic API, with the CLI
 * and Production MCP as adapters over the same services. That only holds if a service returns
 * **data**, never a formatted string: the moment a service renders, one adapter's presentation
 * has been baked into the shared layer and the other adapter has to unpick it.
 *
 * So every service returns a {@link ServiceResult} — a discriminated union an adapter renders,
 * serialises, or maps to an exit code without re-querying anything.
 *
 * The three outcomes are deliberately distinct, and the distinction is the point:
 *
 * - `ok` — the operation completed and its result is what was asked for.
 * - `refused` — the operation is understood and **not permitted right now**: a gate is not
 *   satisfied, spend is not authorized, an actor may not decide (§13, §18.1, §19.3). This is a
 *   normal, expected answer, not a malfunction.
 * - `unsuccessful` — the operation **ran** and reached a terminal state that is not success: a
 *   stage failed, was cancelled, or halted at a gate (§6.3).
 *
 * Anything genuinely broken — a missing workspace, an unknown stage, an IO failure — throws an
 * `AldusError` instead. Collapsing "not allowed" into "broke" is what makes a CLI unscriptable,
 * because a caller cannot tell a policy answer from a bug.
 */

import type { StructuredError } from "@aldus-runtime/core";

/** Why an operation was refused (contract §13, §18.1, §19.3). */
export interface Refusal {
  /**
   * Machine-readable reason.
   *
   * An OPEN string. What can refuse an operation is adopter process — a gate an adopter defined,
   * a budget an adopter set — so Core-side code names no closed set (§4.2).
   */
  reason: string;
  /** Operator-facing explanation of what is blocking and what would unblock it. */
  explanation: string;
  /** Structured detail, already redacted. */
  details?: Record<string, unknown>;
}

/** The operation completed as asked. */
export interface ServiceOk<T> {
  outcome: "ok";
  data: T;
}

/** The operation is not permitted right now (contract §13, §18.1, §19.3). */
export interface ServiceRefused {
  outcome: "refused";
  refusal: Refusal;
}

/** The operation ran and reached a terminal state that is not success (contract §6.3). */
export interface ServiceUnsuccessful<T> {
  outcome: "unsuccessful";
  data: T;
  /** Why it did not succeed. */
  explanation: string;
  /** The structured failure, when one was recorded. */
  error?: StructuredError;
}

/** What every service method returns. */
export type ServiceResult<T> = ServiceOk<T> | ServiceRefused | ServiceUnsuccessful<T>;

/** Build an `ok` result. */
export function ok<T>(data: T): ServiceOk<T> {
  return { outcome: "ok", data };
}

/** Build a `refused` result. */
export function refused(refusal: Refusal): ServiceRefused {
  return { outcome: "refused", refusal };
}

/** Build an `unsuccessful` result. */
export function unsuccessful<T>(
  data: T,
  explanation: string,
  error?: StructuredError,
): ServiceUnsuccessful<T> {
  return { outcome: "unsuccessful", data, explanation, ...(error !== undefined ? { error } : {}) };
}

/** True when the result carries data, i.e. it is not a refusal. */
export function hasData<T>(
  result: ServiceResult<T>,
): result is ServiceOk<T> | ServiceUnsuccessful<T> {
  return result.outcome !== "refused";
}
