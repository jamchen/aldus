/**
 * `@aldus/regression` — the regression harness (architecture contract §22 WP-10).
 *
 * §12.1 permits an evaluator to become blocking "only after it is calibrated against
 * human-labeled examples". This package is what makes that an evidence-based decision instead of
 * a judgement call: it holds the defect corpus, compares an evaluator's outcomes against human
 * labels, computes the metrics §12.1 names, and reports whether the bar is met — **per scope**.
 *
 * It does **not** run evaluators. Outcomes are produced elsewhere and handed here.
 *
 * Two things are load-bearing and easy to lose in a refactor:
 *
 * - **Promotion is scoped.** No API here returns "this evaluator is promotable". §12.1 lists
 *   show, host, voice, model, and script-form scope because calibration does not generalise.
 * - **The aggregate never decides.** The whole-corpus figure is descriptive; no threshold is
 *   applied to it (ADR-0010).
 *
 * @packageDocumentation
 */

// --- Defect corpus (§12.1, §12.3, §24) --------------------------------------------------------
export {
  REGRESSION_SCHEMA_VERSION,
  defectCaseSchema,
  defectCorpusSchema,
  evaluatorFindingSchema,
  evaluatorOutcomeSchema,
  evaluatorRunSchema,
  findingCategory,
  humanFindingSchema,
  parseDefectCorpus,
  parseEvaluatorRun,
  scopeDimensions,
  severityLevel,
  type DefectCase,
  type DefectCorpus,
  type EvaluatorFinding,
  type EvaluatorOutcome,
  type EvaluatorRun,
  type HumanFinding,
  type ScopeDimensions,
} from "./corpus.js";

// --- Scope slicing (§12.1) --------------------------------------------------------------------
export {
  WHOLE_CORPUS_SLICE,
  deriveScopeSelectors,
  observedDimensions,
  scopeKey,
  scopeLabel,
  scopeMatches,
  type ScopeSelector,
} from "./scope.js";

// --- Promotion policy (§12.1, §25.9; ADR-0010) ------------------------------------------------
export {
  DEFAULT_CORRECTION_HARM_WEIGHTS,
  DEFAULT_PROMOTION_THRESHOLDS,
  assertPolicyValid,
  correctionHarm,
  defaultPromotionPolicy,
  severityWeight,
  type CorrectionHarmWeights,
  type PolicyOrigin,
  type PromotionPolicy,
  type PromotionThresholds,
  type SeverityWeights,
} from "./policy.js";

// --- Comparison and metrics (§12.1) -----------------------------------------------------------
export {
  compareRun,
  type CaseComparison,
  type CaseVerdict,
  type CompareOptions,
  type ComparisonReport,
  type SliceMetrics,
} from "./metrics.js";

// --- Known blind spots (§12.1, §9.3) ----------------------------------------------------------
export {
  BLIND_SPOT_STATUSES,
  BlindSpotRegistry,
  blindSpotCoversCase,
  blindSpotSchema,
  type BlindSpot,
  type BlindSpotStatus,
} from "./blindspots.js";

// --- Promotion verdict (§12.1; ADR-0010) ------------------------------------------------------
export {
  assessPromotion,
  isPromotableEverywhereMeasured,
  type PromotionShortfall,
  type PromotionShortfallCode,
  type PromotionVerdict,
  type SliceVerdict,
} from "./promotion.js";

// --- Report rendering (§12) -------------------------------------------------------------------
export { REPORT_CAVEAT, forbiddenClaimWords, renderPromotionReport } from "./report.js";

// --- Errors -----------------------------------------------------------------------------------
export { RegressionErrorCodes, regressionError, type RegressionErrorCode } from "./errors.js";
