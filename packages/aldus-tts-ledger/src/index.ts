/**
 * `@aldus/tts-ledger` — performance scripts, synthesis request and take lineage, the
 * pronunciation lexicon, and repair scoping for the Aldus runtime.
 *
 * Implements architecture contract §22 **WP-07** (generic half), covering §14 (the Performance
 * Layer) and §15 (the TTS quality loop and ledger).
 *
 * What this package is for, in one sentence: making it impossible to end up with paid audio
 * nobody can account for.
 *
 * Three properties carry that weight, and each is a thing the package *cannot* do:
 *
 * - **It cannot synthesise.** No method calls anything, and the package imports no network
 *   module. §15.1 forbids Aldus from silently retrying paid requests, and the strongest form of
 *   that guarantee is a component with no way to make a request. A Worker supplied by an
 *   integration performs the call (§3.2, §4.3) and reports back.
 * - **It cannot authorize.** §13.2 makes paid synthesis conditional on a human gate decision, and
 *   `@aldus/gate-engine` owns it. This package asks, records the answer, and refuses to record a
 *   charge that answer did not permit.
 * - **It cannot forget.** §15.1 requires rejected paid takes to be retained with unique identity,
 *   so nothing deletes a take and the store port has no delete to call. A rejected take is
 *   evidence of what was tried — the input to §15.1's repair strategies and WP-10's corpus.
 *
 * Nothing here names a provider, a voice, or a model. §4.2 states Core does not own "a particular
 * TTS voice or model" and §1.2 rules out prescribing a provider, so every such value is an opaque
 * caller-supplied string and a provider adapter owns the mapping outward (§14.1).
 *
 * The *adoption* half of WP-07 — wrapping an adopter's existing synthesis commands — needs WP-06,
 * which cannot proceed without a real adopter integration.
 *
 * @packageDocumentation
 */

export { digestJson, digestText, type ScopeDimensions } from "./common.js";

export { TtsLedgerErrorCodes, ttsLedgerError, type TtsLedgerErrorCode } from "./errors.js";

export {
  PERFORMANCE_PACES,
  SCRIPT_ORIGINS,
  performancePauseSchema,
  performanceScriptSchema,
  performanceSegmentSchema,
  type PerformancePause,
  type PerformancePace,
  type PerformanceScript,
  type PerformanceScriptDerivation,
  type PerformanceScriptDeriver,
  type PerformanceSegment,
  type ScriptOrigin,
} from "./performance.js";

export {
  PERFORMANCE_FREEZE_SUBJECT_KEYS,
  asrFindingSchema,
  parametersDigest,
  plannedSegmentSchema,
  planScopeDigest,
  planSpokenTextDigest,
  planSubjectDigests,
  riskSiteSchema,
  segmentTextSchema,
  synthesisParametersSchema,
  ttsRequestPlanSchema,
  type AsrFinding,
  type PlannedSegment,
  type RiskSite,
  type SegmentText,
  type SynthesisParameters,
  type TtsRequestPlan,
} from "./request.js";

export {
  REPAIR_RUNGS,
  TAKE_DECISIONS,
  invalidatesContentFreeze,
  isAccepted,
  isPaid,
  isRejected,
  repairRungOrder,
  repairSchema,
  takeAuthorizationSchema,
  takeDecisionSchema,
  takeRecordSchema,
  type RepairRung,
  type TakeAuthorization,
  type TakeDecision,
  type TakeDecisionValue,
  type TakeRecord,
  type TakeRepair,
} from "./take.js";

export {
  LEXICON_APPROVAL_STATUSES,
  LEXICON_AUTHORITIES,
  lexiconEntrySchema,
  lexiconExampleSchema,
  requireLexicon,
  resolveLexicon,
  scopeMatches,
  specificityOf,
  type LexiconApprovalStatus,
  type LexiconAuthority,
  type LexiconConflict,
  type LexiconContext,
  type LexiconEntry,
  type LexiconExample,
  type LexiconResolution,
} from "./lexicon.js";

export {
  acceptedTakeFor,
  buildLineage,
  segmentsAwaitingAcceptance,
  type SegmentLineage,
} from "./lineage.js";

export {
  MemoryLedgerEventSink,
  MemoryLexiconStore,
  MemoryPlanStore,
  MemoryScriptStore,
  MemoryTakeStore,
  type AuthorizationOutcome,
  type AuthorizationQuery,
  type LedgerEventSink,
  type LexiconStore,
  type PlanStore,
  type ScriptStore,
  type SpendAuthorizer,
  type TakeStore,
} from "./ports.js";

export {
  TtsLedger,
  repairFor,
  type RecordTakeInput,
  type SynthesisPermission,
  type TtsLedgerOptions,
} from "./ledger.js";
