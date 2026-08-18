/**
 * `@aldus/gate-engine` — hash-bound human gates, cascading invalidation, and spend authorization.
 *
 * Implements architecture contract §22 **WP-05**, covering §12 (quality levels), §13 (human gates
 * and freezes), and §19.3 (cost governance).
 *
 * What this package is for, in one sentence: making it impossible to spend money or publish
 * anything on the strength of an approval that no longer describes what is about to happen.
 *
 * Three properties carry that weight:
 *
 * - **A decision binds to digests.** §3.6 requires human review to produce a durable record "tied
 *   to exact inputs", and §13.2 voids an authorization if any bound value changes.
 * - **Invalidation is derived, never stored.** A gate's state is recomputed from its decision,
 *   its current inputs, and its dependencies. There is no "valid" flag for a stale approval to
 *   survive in, so §13.1's cascade cannot be half-applied.
 * - **A grant's ceiling is itself bound.** §13.2 requires the operator to approve a maximum
 *   authorized cost, so the limits' digest sits among the decision's subject hashes and raising
 *   the ceiling voids the approval that permitted the spend.
 *
 * What it deliberately does not do: run any check that feeds a gate. §12's evaluators, §12.1's
 * calibration metrics (WP-10), the TTS ledger (WP-07), and the release adapters (WP-12) are
 * elsewhere. This package models the decisions; it does not make them.
 *
 * Contract §13 names four gates — Content Freeze, Performance Freeze, Human Ear, Final Release —
 * and none is hardcoded. They are the definitions an adopter is most likely to write (§4.2, §4.3).
 *
 * @packageDocumentation
 */

export {
  GATE_ENFORCEMENTS,
  GATE_LEVELS,
  GateRegistry,
  validateGateDefinition,
  type GateDefinition,
  type GateEnforcement,
  type GateLevel,
  type PromotionEvidence,
  type ResolvedGateDefinition,
} from "./definition.js";

export {
  assertSubjectsCover,
  detectDrift,
  digestBytes,
  digestSubjectValue,
  toSubjectHashes,
  type GateSubject,
  type SubjectDrift,
} from "./binding.js";

export {
  GATE_STATES,
  GateEngine,
  type AuthorizationGrant,
  type AuthorizationRefusal,
  type AuthorizationResult,
  type DecideInput,
  type GateEngineOptions,
  type GateState,
  type GateStatus,
  type SpendAuthorization,
  type SubjectsByGate,
} from "./engine.js";

export {
  SPEND_LIMIT_SUBJECT_KEY,
  checkSpend,
  computeLedger,
  consumesBudget,
  costRecordDraw,
  grantLimitsDigest,
  type SpendCheck,
  type SpendGrant,
  type SpendLedger,
  type SpendRefusalReason,
  type SpendRequest,
} from "./spend.js";

export {
  addMoney,
  assertMoney,
  compareMoney,
  formatMoney,
  isNegativeMoney,
  isPositiveMoney,
  subtractMoney,
  sumMoney,
  zeroMoney,
} from "./money.js";

export {
  MemoryCostReader,
  MemoryGateDecisionStore,
  MemoryGateEventSink,
  type CostReader,
  type GateDecisionStore,
  type GateEventSink,
} from "./ports.js";

export { GateEngineErrorCodes, gateEngineError, type GateEngineErrorCode } from "./errors.js";
