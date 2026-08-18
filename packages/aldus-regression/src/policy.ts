/**
 * Promotion policy: the evidence bar an evaluator must clear (architecture contract §12.1,
 * §25 item 9; ADR-0010).
 *
 * §12.1 says an evaluator "MAY become blocking only after it is calibrated against human-labeled
 * examples" and lists what promotion should consider. It does not say how much evidence is
 * enough — §25 item 9 records that as an open question. ADR-0010 closes it with the defaults
 * below.
 *
 * **The defaults are uncalibrated.** Nobody has run a real corpus through them. They are a
 * starting point chosen to fail closed, and every verdict computed against them says so in its
 * output — see `PromotionVerdict.policyOrigin`. A threshold presented as authoritative when
 * nothing validated it would be its own failure of the honesty §12 demands.
 */

import { RegressionErrorCodes, regressionError } from "./errors.js";

/**
 * How much a missed defect of each severity costs.
 *
 * §12.1 requires "severity-weighted false negatives", not a count: a missed unsupported claim
 * and a missed cosmetic wobble are not one unit of the same currency. Levels are caller-named
 * (see `severityLevel`), so weights are supplied rather than assumed.
 */
export type SeverityWeights = Readonly<Record<string, number>>;

/**
 * How much harm an unnecessary automatic correction does, by correction class.
 *
 * §12.1 names "asymmetric harm caused by unnecessary automatic correction" as a consideration
 * *separate from* the false-positive rate, and §12.4 explains why: repairs differ by layer. A
 * spurious flag that regenerates one TTS segment costs a request. A spurious flag that revises
 * narration invalidates the Content Freeze and every approval downstream of it (§13.1). Charging
 * both to one precision figure would hide exactly the asymmetry §12.1 asks to be weighed.
 */
export type CorrectionHarmWeights = Readonly<Record<string, number>>;

/** Thresholds a scope slice must clear to be reported as promotable. */
export interface PromotionThresholds {
  /** Minimum labelled cases in the slice. */
  minCases: number;
  /** Minimum cases a human labelled defective. Recall over three positives is not a measurement. */
  minDefectiveCases: number;
  /** Minimum cases a human labelled clean. Without these, the false-positive rate is unmeasured. */
  minCleanCases: number;
  /** Minimum recall, in `[0, 1]` (contract §12.1). */
  minRecall: number;
  /** Minimum severity-weighted recall, in `[0, 1]` (contract §12.1). */
  minSeverityWeightedRecall: number;
  /** Maximum false-positive rate, in `[0, 1]` (contract §12.1). */
  maxFalsePositiveRate: number;
  /**
   * Maximum mean unnecessary-correction harm per clean case (contract §12.1).
   *
   * Separate from `maxFalsePositiveRate` on purpose: an evaluator can clear the rate while every
   * one of its few false positives triggers a cascading rewrite.
   */
  maxUnnecessaryCorrectionHarm: number;
  /**
   * Minimum distinct human labellers in the slice.
   *
   * Defaults to 1 and is documented as a floor rather than a recommendation: a single-labeller
   * corpus has no inter-rater signal at all, so its labels are one person's judgement presented
   * as an oracle. Raise this once more than one labeller exists.
   */
  minLabellers: number;
}

/** A full promotion policy. */
export interface PromotionPolicy {
  /** Thresholds every scope slice must clear. */
  thresholds: PromotionThresholds;
  /** Weight per severity level (contract §12.1). */
  severityWeights: SeverityWeights;
  /** Harm weight per correction class (contract §12.1, §12.4). */
  correctionHarmWeights: CorrectionHarmWeights;
  /** Correction class applied to a case that names none. */
  defaultCorrectionClass: string;
  /**
   * Whether an open blind spot in a slice disqualifies it regardless of metrics.
   *
   * Defaults to `true`. §12.1 lists "known blind spots" alongside the numeric considerations,
   * and a blind spot is by definition a failure the corpus did not sample — so good metrics are
   * not evidence against it, they are evidence that the corpus did not look.
   */
  openBlindSpotDisqualifies: boolean;
  /**
   * Whether the policy came from this package's uncalibrated defaults.
   *
   * Carried into every verdict so a reader can tell an evidence-based bar from a placeholder.
   */
  origin: PolicyOrigin;
}

/** Where a policy's numbers came from. */
export type PolicyOrigin =
  /** This package's defaults. Not validated against any real corpus (ADR-0010). */
  | "default-uncalibrated"
  /** Supplied by an adopter. */
  | "configured";

/**
 * The default correction classes, transcribed from contract §12.4's repair ladder.
 *
 * §12.4 orders repairs by "the smallest safe layer", and the weights follow that ordering: a
 * scoped regeneration is cheap and reversible, a narration rewrite invalidates the Content
 * Freeze and everything downstream (§13.1), and escalating to a human costs attention rather
 * than content. These are defaults an adopter replaces.
 */
export const DEFAULT_CORRECTION_HARM_WEIGHTS: CorrectionHarmWeights = {
  /** Reported, nothing changes automatically. The advisory case (§12 level 2). */
  advisory: 0,
  /** A human is asked to look (§12.4 "escalate to human"). */
  escalate: 0.5,
  /** Regenerate only the affected segment (§12.4). */
  regenerateSegment: 1,
  /** Change provider mapping without rewriting content (§12.4). */
  remapProvider: 2,
  /** Change the PerformanceScript without altering approved claims (§12.4). */
  reperform: 3,
  /** Revise narration, invalidating the Content Freeze and dependent approvals (§12.4, §13.1). */
  reviseNarration: 10,
};

/**
 * Default thresholds (ADR-0010, closing contract §25 item 9).
 *
 * Chosen to fail closed. A blocking evaluator that misses defects is worse than an advisory one,
 * because §12 warns that "machine pass MUST NOT be presented as semantic correctness" — and a
 * hard gate that passes is precisely such a presentation. **Uncalibrated:** see the module
 * comment.
 */
export const DEFAULT_PROMOTION_THRESHOLDS: PromotionThresholds = {
  minCases: 50,
  minDefectiveCases: 20,
  minCleanCases: 20,
  minRecall: 0.95,
  minSeverityWeightedRecall: 0.98,
  maxFalsePositiveRate: 0.05,
  maxUnnecessaryCorrectionHarm: 0.1,
  minLabellers: 1,
};

/**
 * A policy built from this package's uncalibrated defaults.
 *
 * `severityWeights` is empty: severity levels are caller-named, so there is nothing to default
 * to. A corpus using an unweighted severity is refused rather than counted as zero — see
 * `ALDUS_SEVERITY_UNWEIGHTED`.
 */
export function defaultPromotionPolicy(
  severityWeights: SeverityWeights,
  overrides: Partial<Omit<PromotionPolicy, "origin">> = {},
): PromotionPolicy {
  const policy: PromotionPolicy = {
    thresholds: { ...DEFAULT_PROMOTION_THRESHOLDS, ...overrides.thresholds },
    severityWeights: overrides.severityWeights ?? severityWeights,
    correctionHarmWeights: overrides.correctionHarmWeights ?? DEFAULT_CORRECTION_HARM_WEIGHTS,
    defaultCorrectionClass: overrides.defaultCorrectionClass ?? "advisory",
    openBlindSpotDisqualifies: overrides.openBlindSpotDisqualifies ?? true,
    // Any override of a threshold or weight means an adopter has taken a position, so the
    // verdict should stop describing itself as uncalibrated.
    origin: Object.keys(overrides).length === 0 ? "default-uncalibrated" : "configured",
  };
  assertPolicyValid(policy);
  return policy;
}

/**
 * Reject a policy whose numbers cannot mean what they claim.
 *
 * @throws {AldusError} `ALDUS_POLICY_INVALID`.
 */
export function assertPolicyValid(policy: PromotionPolicy): void {
  const { thresholds } = policy;
  const rates: [string, number][] = [
    ["minRecall", thresholds.minRecall],
    ["minSeverityWeightedRecall", thresholds.minSeverityWeightedRecall],
    ["maxFalsePositiveRate", thresholds.maxFalsePositiveRate],
  ];
  for (const [name, value] of rates) {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw regressionError(
        RegressionErrorCodes.POLICY_INVALID,
        `Promotion threshold "${name}" must be a rate in [0, 1]; received ${value}.`,
        { category: "validation", details: { threshold: name, value } },
      );
    }
  }
  const counts: [string, number][] = [
    ["minCases", thresholds.minCases],
    ["minDefectiveCases", thresholds.minDefectiveCases],
    ["minCleanCases", thresholds.minCleanCases],
    ["minLabellers", thresholds.minLabellers],
  ];
  for (const [name, value] of counts) {
    if (!Number.isInteger(value) || value < 0) {
      throw regressionError(
        RegressionErrorCodes.POLICY_INVALID,
        `Promotion threshold "${name}" must be a non-negative integer; received ${value}.`,
        { category: "validation", details: { threshold: name, value } },
      );
    }
  }
  if (thresholds.minDefectiveCases + thresholds.minCleanCases > thresholds.minCases) {
    throw regressionError(
      RegressionErrorCodes.POLICY_INVALID,
      "minCases is smaller than minDefectiveCases + minCleanCases, so no slice could ever " +
        "satisfy all three at once.",
      { category: "validation", details: { thresholds } },
    );
  }
  if (
    !Number.isFinite(thresholds.maxUnnecessaryCorrectionHarm) ||
    thresholds.maxUnnecessaryCorrectionHarm < 0
  ) {
    throw regressionError(
      RegressionErrorCodes.POLICY_INVALID,
      "maxUnnecessaryCorrectionHarm must be a non-negative finite number.",
      { category: "validation", details: { thresholds } },
    );
  }
}

/**
 * Weight of a severity level.
 *
 * @throws {AldusError} `ALDUS_SEVERITY_UNWEIGHTED` when the policy has no weight for it. Refused
 * rather than defaulted to zero: a silently unweighted severity drops a missed defect out of the
 * severity-weighted recall §12.1 requires, and the metric still reports a plausible number.
 */
export function severityWeight(policy: PromotionPolicy, severity: string): number {
  const weight = policy.severityWeights[severity];
  if (weight === undefined) {
    throw regressionError(
      RegressionErrorCodes.SEVERITY_UNWEIGHTED,
      `The promotion policy assigns no weight to severity "${severity}". Weighting it as zero ` +
        "would drop every case at that severity out of severity-weighted recall while still " +
        "reporting a number (architecture contract §12.1).",
      {
        category: "validation",
        details: { severity, known: Object.keys(policy.severityWeights).sort() },
      },
    );
  }
  return weight;
}

/**
 * Harm weight of a correction class.
 *
 * @throws {AldusError} `ALDUS_CORRECTION_CLASS_UNWEIGHTED` when the policy has no weight for it.
 */
export function correctionHarm(policy: PromotionPolicy, correctionClass: string): number {
  const weight = policy.correctionHarmWeights[correctionClass];
  if (weight === undefined) {
    throw regressionError(
      RegressionErrorCodes.CORRECTION_CLASS_UNWEIGHTED,
      `The promotion policy assigns no harm weight to correction class "${correctionClass}".`,
      {
        category: "validation",
        details: { correctionClass, known: Object.keys(policy.correctionHarmWeights).sort() },
      },
    );
  }
  return weight;
}
