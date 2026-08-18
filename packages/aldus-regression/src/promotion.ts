/**
 * Evaluator promotion (architecture contract §12.1, §25 item 9; ADR-0010).
 *
 * §12.1: "An evaluator MAY become blocking only after it is calibrated against human-labeled
 * examples." This module turns that permission into an evidence check.
 *
 * Two decisions shape everything here, both recorded in ADR-0010:
 *
 * 1. **Promotion is always scoped.** There is no such thing as promoting an evaluator outright.
 *    A verdict names the slices where the bar is met, and §12.1's own list of scope dimensions
 *    is why: calibration on one host, voice, or script form is not evidence about another.
 * 2. **The whole-corpus figure never decides anything.** It is computed and reported because a
 *    reader wants the corpus's shape, but no threshold is applied to it. An evaluator that looks
 *    excellent in aggregate while failing one slice must not read as promotable, and the surest
 *    way to guarantee that is to give the aggregate no vote.
 */

import type { BlindSpot, BlindSpotRegistry } from "./blindspots.js";
import type { ComparisonReport, SliceMetrics } from "./metrics.js";
import type { PolicyOrigin, PromotionPolicy } from "./policy.js";
import type { ScopeSelector } from "./scope.js";

/** Why a slice did not clear the bar. */
export interface PromotionShortfall {
  /** Machine-readable reason. */
  code: PromotionShortfallCode;
  /** What the slice needed. */
  required: number | string;
  /** What it had. `undefined` when the metric was unmeasurable. */
  observed: number | string | undefined;
  /** Operator-facing explanation. */
  message: string;
}

/** Reasons a slice can fail (contract §12.1). */
export type PromotionShortfallCode =
  | "insufficient_cases"
  | "insufficient_defective_cases"
  | "insufficient_clean_cases"
  | "insufficient_labellers"
  | "recall_below_threshold"
  | "severity_weighted_recall_below_threshold"
  | "false_positive_rate_above_threshold"
  | "unnecessary_correction_harm_above_threshold"
  | "open_blind_spot"
  | "unmeasurable";

/** Whether one slice clears the bar, and why not when it does not. */
export interface SliceVerdict {
  /** Which slice. */
  selector: ScopeSelector;
  /** Stable key for the slice. */
  key: string;
  /** Metrics the verdict was computed from. */
  metrics: SliceMetrics;
  /**
   * Whether this slice clears the §12.1 bar.
   *
   * Named for what it is: evidence sufficient to *permit* promotion, not proof the evaluator is
   * right. §12 forbids presenting a machine pass as semantic correctness.
   */
  meetsPromotionBar: boolean;
  /** Every reason it does not, empty when it does. */
  shortfalls: readonly PromotionShortfall[];
  /** Open blind spots applying to this slice (contract §12.1, §9.3). */
  openBlindSpots: readonly BlindSpot[];
}

/** The full promotion verdict. */
export interface PromotionVerdict {
  /** Evaluator assessed. */
  evaluatorId: string;
  /** Version assessed. */
  evaluatorVersion: string;
  /** Corpus assessed against. */
  corpusId: string;
  /**
   * Where the policy's numbers came from.
   *
   * `default-uncalibrated` means the bar itself has never been validated against a real corpus
   * (ADR-0010). A verdict is only as trustworthy as the thresholds it was measured against, and
   * hiding that would be its own dishonesty.
   */
  policyOrigin: PolicyOrigin;
  /** Per-slice verdicts (contract §12.1). */
  slices: readonly SliceVerdict[];
  /** Slices that clear the bar. May be empty. */
  promotableScopes: readonly string[];
  /** Slices that do not. */
  blockedScopes: readonly string[];
  /**
   * Whole-corpus metrics, for context only.
   *
   * Deliberately not accompanied by a whole-corpus verdict: no threshold is applied to it
   * (ADR-0010 decision 3).
   */
  wholeCorpus: SliceMetrics;
  /**
   * True when the aggregate would flatter the evaluator relative to its worst slice.
   *
   * Surfaced so a report can say so out loud rather than leaving a reader to compare the numbers
   * themselves — this is the specific failure §12.1's scope requirement exists to prevent.
   */
  aggregateFlattersWorstScope: boolean;
  /** Cases the run never reported on. */
  unevaluatedCaseIds: readonly string[];
}

function shortfall(
  code: PromotionShortfallCode,
  required: number | string,
  observed: number | string | undefined,
  message: string,
): PromotionShortfall {
  return { code, required, observed, message };
}

/** Assess one slice against the policy. */
function assessSlice(
  metrics: SliceMetrics,
  policy: PromotionPolicy,
  openBlindSpots: readonly BlindSpot[],
): SliceVerdict {
  const { thresholds } = policy;
  const shortfalls: PromotionShortfall[] = [];

  if (metrics.cases < thresholds.minCases) {
    shortfalls.push(
      shortfall(
        "insufficient_cases",
        thresholds.minCases,
        metrics.cases,
        `Only ${metrics.cases} labelled cases; the bar is ${thresholds.minCases}.`,
      ),
    );
  }
  if (metrics.defectiveCases < thresholds.minDefectiveCases) {
    shortfalls.push(
      shortfall(
        "insufficient_defective_cases",
        thresholds.minDefectiveCases,
        metrics.defectiveCases,
        `Only ${metrics.defectiveCases} cases a human labelled defective; recall over so few is ` +
          "not a measurement.",
      ),
    );
  }
  if (metrics.cleanCases < thresholds.minCleanCases) {
    shortfalls.push(
      shortfall(
        "insufficient_clean_cases",
        thresholds.minCleanCases,
        metrics.cleanCases,
        `Only ${metrics.cleanCases} cases a human labelled clean, so the false-positive rate is ` +
          "barely constrained.",
      ),
    );
  }
  if (metrics.labellers < thresholds.minLabellers) {
    shortfalls.push(
      shortfall(
        "insufficient_labellers",
        thresholds.minLabellers,
        metrics.labellers,
        `Labels come from ${metrics.labellers} person(s); the bar is ${thresholds.minLabellers}.`,
      ),
    );
  }

  // An unmeasurable metric is a shortfall, never a pass. A slice with no defective cases has an
  // undefined recall, and treating undefined as satisfied would promote an evaluator that was
  // never tested on a single defect.
  if (metrics.recall === undefined) {
    shortfalls.push(
      shortfall(
        "unmeasurable",
        thresholds.minRecall,
        undefined,
        "Recall is unmeasurable here: no case in this slice was labelled defective.",
      ),
    );
  } else if (metrics.recall < thresholds.minRecall) {
    shortfalls.push(
      shortfall(
        "recall_below_threshold",
        thresholds.minRecall,
        metrics.recall,
        `Recall ${metrics.recall.toFixed(3)} is below the required ${thresholds.minRecall}; the ` +
          `evaluator missed ${metrics.falseNegatives} defect(s) a human found.`,
      ),
    );
  }

  if (metrics.severityWeightedRecall === undefined) {
    if (metrics.recall !== undefined) {
      shortfalls.push(
        shortfall(
          "unmeasurable",
          thresholds.minSeverityWeightedRecall,
          undefined,
          "Severity-weighted recall is unmeasurable: the defective cases carry no severity weight.",
        ),
      );
    }
  } else if (metrics.severityWeightedRecall < thresholds.minSeverityWeightedRecall) {
    shortfalls.push(
      shortfall(
        "severity_weighted_recall_below_threshold",
        thresholds.minSeverityWeightedRecall,
        metrics.severityWeightedRecall,
        `Severity-weighted recall ${metrics.severityWeightedRecall.toFixed(3)} is below the ` +
          `required ${thresholds.minSeverityWeightedRecall}. Weighted misses total ` +
          `${metrics.severityWeightedFalseNegatives}, so what it missed was disproportionately ` +
          "severe (architecture contract §12.1).",
      ),
    );
  }

  if (metrics.falsePositiveRate === undefined) {
    shortfalls.push(
      shortfall(
        "unmeasurable",
        thresholds.maxFalsePositiveRate,
        undefined,
        "False-positive rate is unmeasurable here: no case in this slice was labelled clean.",
      ),
    );
  } else if (metrics.falsePositiveRate > thresholds.maxFalsePositiveRate) {
    shortfalls.push(
      shortfall(
        "false_positive_rate_above_threshold",
        thresholds.maxFalsePositiveRate,
        metrics.falsePositiveRate,
        `False-positive rate ${metrics.falsePositiveRate.toFixed(3)} exceeds the permitted ` +
          `${thresholds.maxFalsePositiveRate}.`,
      ),
    );
  }

  if (
    metrics.meanUnnecessaryCorrectionHarm !== undefined &&
    metrics.meanUnnecessaryCorrectionHarm > thresholds.maxUnnecessaryCorrectionHarm
  ) {
    shortfalls.push(
      shortfall(
        "unnecessary_correction_harm_above_threshold",
        thresholds.maxUnnecessaryCorrectionHarm,
        metrics.meanUnnecessaryCorrectionHarm,
        `Mean unnecessary-correction harm ${metrics.meanUnnecessaryCorrectionHarm.toFixed(3)} ` +
          `exceeds the permitted ${thresholds.maxUnnecessaryCorrectionHarm}. Its false positives ` +
          "trigger expensive repairs, which §12.1 weighs separately from how often they occur.",
      ),
    );
  }

  if (policy.openBlindSpotDisqualifies && openBlindSpots.length > 0) {
    shortfalls.push(
      shortfall(
        "open_blind_spot",
        0,
        openBlindSpots.length,
        `${openBlindSpots.length} open blind spot(s) apply here: ` +
          `${openBlindSpots.map((record) => record.blindSpotId).join(", ")}. Corpus metrics are ` +
          "not evidence against a blind spot — a blind spot is what the corpus did not sample " +
          "(architecture contract §12.1, §9.3).",
      ),
    );
  }

  return {
    selector: metrics.selector,
    key: metrics.key,
    metrics,
    meetsPromotionBar: shortfalls.length === 0,
    shortfalls,
    openBlindSpots,
  };
}

/**
 * Decide whether an evaluator may be promoted to blocking, per scope (contract §12.1).
 *
 * Returns a verdict rather than throwing. A blocked promotion is information an operator needs
 * rendered — several slices may fail for different reasons at once, and an exception would carry
 * one and discard the rest. This follows ADR-0006 decision 5's reasoning for pack resolution.
 */
export function assessPromotion(
  comparison: ComparisonReport,
  policy: PromotionPolicy,
  blindSpots?: BlindSpotRegistry,
): PromotionVerdict {
  const slices = comparison.slices.map((metrics) =>
    assessSlice(
      metrics,
      policy,
      blindSpots?.openFor(comparison.evaluatorId, metrics.selector) ?? [],
    ),
  );

  const promotable = slices.filter((slice) => slice.meetsPromotionBar);
  const blocked = slices.filter((slice) => !slice.meetsPromotionBar);

  // Does the aggregate look better than the worst slice? Compared on agreement because that is
  // the figure a reader is most likely to skim and mistake for a verdict.
  const worstAgreement = comparison.slices.reduce<number | undefined>((worst, slice) => {
    const value = slice.agreementWithHumanLabels;
    if (value === undefined) return worst;
    return worst === undefined || value < worst ? value : worst;
  }, undefined);
  const aggregate = comparison.wholeCorpus.agreementWithHumanLabels;
  const aggregateFlattersWorstScope =
    aggregate !== undefined && worstAgreement !== undefined && aggregate > worstAgreement;

  return {
    evaluatorId: comparison.evaluatorId,
    evaluatorVersion: comparison.evaluatorVersion,
    corpusId: comparison.corpusId,
    policyOrigin: policy.origin,
    slices,
    promotableScopes: promotable.map((slice) => slice.key),
    blockedScopes: blocked.map((slice) => slice.key),
    wholeCorpus: comparison.wholeCorpus,
    aggregateFlattersWorstScope,
    unevaluatedCaseIds: comparison.unevaluatedCaseIds,
  };
}

/**
 * True when every measured slice clears the bar **and** at least one slice was measured.
 *
 * The second half is not pedantry: an empty slice list would otherwise satisfy `every` and read
 * as universal approval of an evaluator nothing was measured about.
 */
export function isPromotableEverywhereMeasured(verdict: PromotionVerdict): boolean {
  return verdict.slices.length > 0 && verdict.blockedScopes.length === 0;
}
