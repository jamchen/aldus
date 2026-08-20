/**
 * Human/evaluator comparison and the §12.1 metrics.
 *
 * Every name here is chosen to keep one distinction visible: these numbers describe **agreement
 * with human labels on one corpus**, not correctness. §12 states that "machine pass MUST NOT be
 * presented as semantic correctness", and the easiest way to violate that is to call a field
 * `accuracy` and let a reader draw the obvious conclusion. So the aggregate is
 * `agreementWithHumanLabels`, and nothing in this module is named `correct`.
 *
 * The metrics are those §12.1 requires be considered: recall, false-positive rate,
 * severity-weighted false negatives, and harm from unnecessary automatic correction — the last
 * kept separate from the false-positive rate on purpose (see `policy.ts`).
 */

import type { DefectCase, DefectCorpus, EvaluatorOutcome, EvaluatorRun } from "./corpus.js";
import { RegressionErrorCodes, regressionError } from "./errors.js";
import { correctionHarm, severityWeight, type PromotionPolicy } from "./policy.js";
import {
  deriveScopeSelectors,
  scopeKey,
  scopeMatches,
  WHOLE_CORPUS_SLICE,
  type ScopeSelector,
} from "./scope.js";

/** How one case and one outcome agreed or disagreed. */
export type CaseVerdict =
  /** Human said defective, evaluator flagged it. */
  | "truePositive"
  /** Human said defective, evaluator did not flag it. A miss. */
  | "falseNegative"
  /** Human said clean, evaluator flagged it. A spurious flag. */
  | "falsePositive"
  /** Human said clean, evaluator did not flag it. */
  | "trueNegative";

/** One case paired with what the evaluator said about it. */
export interface CaseComparison {
  /** The case. */
  caseId: string;
  /** Scope of the case. */
  scope: Readonly<Record<string, string>>;
  /** How they agreed. */
  verdict: CaseVerdict;
  /** Severity of the case, when a human labelled it defective. */
  severity: string | undefined;
  /** Severity weight, when applicable. */
  severityWeight: number;
  /**
   * Whether a true positive was found under a different category than the human assigned.
   *
   * §12.3 structures findings by category, so an evaluator that flags the right case for the
   * wrong reason has not fully agreed. Counted separately rather than downgraded to a false
   * negative — it did catch the case — but a promotion reader should see it.
   */
  categoryMismatch: boolean;
  /**
   * Whether site-level comparison means anything for this case (#140).
   *
   * `false` when the evaluator flagged without enumerating what it found — a wrapped legacy
   * evaluator reporting that it had something to say, and nothing about how much or where.
   *
   * The case-level verdict is still sound: a flag is a flag, and §12's precision and recall over
   * *cases* are computable. What is not computable is anything per site, and the previous code
   * quietly answered it anyway — with no evaluator categories to compare, `categoryMismatch` came
   * out `false`, which reads as *the categories agreed*. An evaluator nobody measured would have
   * scored a clean sheet.
   */
  siteMetricsMeasurable: boolean;
  /** Harm a spurious flag would cause here; zero unless this is a false positive. */
  unnecessaryCorrectionHarm: number;
}

/** Metrics over one slice of the corpus. */
export interface SliceMetrics {
  /** Which slice. */
  selector: ScopeSelector;
  /** Stable key for the slice. */
  key: string;
  /** Total cases in the slice. */
  cases: number;
  /** Cases a human labelled defective. */
  defectiveCases: number;
  /** Cases a human labelled clean. */
  cleanCases: number;
  /** Distinct human labellers represented. */
  labellers: number;
  /** Confusion counts. */
  truePositives: number;
  falseNegatives: number;
  falsePositives: number;
  trueNegatives: number;
  /** True positives found under the wrong category (contract §12.3). */
  categoryMismatches: number;
  /**
   * Cases whose site-level metrics are unmeasurable (#140).
   *
   * Reported rather than folded in, because a slice where this is large is a slice whose
   * category agreement means much less than the other numbers suggest. Zero is the honest value
   * only when it is true.
   */
  unmeasurableSiteMetrics: number;
  /** `truePositives / defectiveCases`; `undefined` when there are no defective cases. */
  recall: number | undefined;
  /** `falsePositives / cleanCases`; `undefined` when there are no clean cases. */
  falsePositiveRate: number | undefined;
  /** Severity-weighted recall (contract §12.1); `undefined` when there is nothing to weigh. */
  severityWeightedRecall: number | undefined;
  /** Total severity weight of missed defects (contract §12.1). */
  severityWeightedFalseNegatives: number;
  /** Total harm from spurious flags (contract §12.1, §12.4). */
  unnecessaryCorrectionHarm: number;
  /** Mean harm per clean case; `undefined` when there are no clean cases. */
  meanUnnecessaryCorrectionHarm: number | undefined;
  /**
   * Fraction of cases where the evaluator and the human agreed.
   *
   * Named for what it measures. This is **not** accuracy, and a reader who treats it as one has
   * made exactly the mistake §12 forbids.
   */
  agreementWithHumanLabels: number | undefined;
  /** Case ids in this slice, for blind-spot cross-referencing. */
  caseIds: readonly string[];
}

/** The full comparison: per-slice metrics, and a descriptive whole-corpus figure. */
export interface ComparisonReport {
  /** Evaluator compared. */
  evaluatorId: string;
  /** Version compared. Metrics from different versions are not comparable. */
  evaluatorVersion: string;
  /** Corpus compared against. */
  corpusId: string;
  /**
   * Whole-corpus metrics.
   *
   * **Descriptive only.** Promotion is decided per slice and never from this figure — ADR-0010
   * decision 3. It is reported because a reader wants the shape of the corpus, not because it is
   * evidence.
   */
  wholeCorpus: SliceMetrics;
  /** Per-slice metrics (contract §12.1). Promotion is decided from these. */
  slices: readonly SliceMetrics[];
  /** Every case comparison, for callers that need the detail. */
  comparisons: readonly CaseComparison[];
  /** Cases in the corpus the evaluator run did not report on. */
  unevaluatedCaseIds: readonly string[];
}

/** Compare one case to one outcome. */
function compareCase(
  entry: DefectCase,
  outcome: EvaluatorOutcome | undefined,
  policy: PromotionPolicy,
): CaseComparison {
  const flagged = outcome?.flagged ?? false;
  const weight = entry.severity === undefined ? 0 : severityWeight(policy, entry.severity);

  let verdict: CaseVerdict;
  if (entry.defective) verdict = flagged ? "truePositive" : "falseNegative";
  else verdict = flagged ? "falsePositive" : "trueNegative";

  const humanCategories = new Set(entry.findings.map((finding) => finding.category));
  const evaluatorCategories = new Set((outcome?.findings ?? []).map((finding) => finding.category));
  const categoryMismatch =
    verdict === "truePositive" &&
    humanCategories.size > 0 &&
    evaluatorCategories.size > 0 &&
    ![...evaluatorCategories].some((category) => humanCategories.has(category));

  const harm =
    verdict === "falsePositive"
      ? correctionHarm(policy, entry.correctionOnFlag ?? policy.defaultCorrectionClass)
      : 0;

  return {
    caseId: entry.caseId,
    scope: entry.scope,
    verdict,
    severity: entry.severity,
    severityWeight: weight,
    categoryMismatch,
    // A flag with nothing enumerated. Not a contradiction to be repaired by inventing a finding —
    // that would make one report count as one defect, which is exactly the statistic #140 exists
    // to protect.
    siteMetricsMeasurable:
      outcome?.siteMetricsMeasurable ?? !(flagged && (outcome?.findings ?? []).length === 0),
    unnecessaryCorrectionHarm: harm,
  };
}

/** Aggregate comparisons into metrics for one slice. */
function summarise(
  selector: ScopeSelector,
  comparisons: readonly CaseComparison[],
  labellers: ReadonlySet<string>,
): SliceMetrics {
  const count = (verdict: CaseVerdict): number =>
    comparisons.filter((comparison) => comparison.verdict === verdict).length;

  const truePositives = count("truePositive");
  const falseNegatives = count("falseNegative");
  const falsePositives = count("falsePositive");
  const trueNegatives = count("trueNegative");

  const defectiveCases = truePositives + falseNegatives;
  const cleanCases = falsePositives + trueNegatives;
  const cases = comparisons.length;

  const caughtWeight = comparisons
    .filter((comparison) => comparison.verdict === "truePositive")
    .reduce((total, comparison) => total + comparison.severityWeight, 0);
  const missedWeight = comparisons
    .filter((comparison) => comparison.verdict === "falseNegative")
    .reduce((total, comparison) => total + comparison.severityWeight, 0);
  const defectiveWeight = caughtWeight + missedWeight;

  const harm = comparisons.reduce(
    (total, comparison) => total + comparison.unnecessaryCorrectionHarm,
    0,
  );

  return {
    selector,
    key: scopeKey(selector),
    cases,
    defectiveCases,
    cleanCases,
    labellers: labellers.size,
    truePositives,
    falseNegatives,
    falsePositives,
    trueNegatives,
    categoryMismatches: comparisons.filter((comparison) => comparison.categoryMismatch).length,
    unmeasurableSiteMetrics: comparisons.filter((comparison) => !comparison.siteMetricsMeasurable)
      .length,
    recall: defectiveCases === 0 ? undefined : truePositives / defectiveCases,
    falsePositiveRate: cleanCases === 0 ? undefined : falsePositives / cleanCases,
    severityWeightedRecall: defectiveWeight === 0 ? undefined : caughtWeight / defectiveWeight,
    severityWeightedFalseNegatives: missedWeight,
    unnecessaryCorrectionHarm: harm,
    meanUnnecessaryCorrectionHarm: cleanCases === 0 ? undefined : harm / cleanCases,
    agreementWithHumanLabels: cases === 0 ? undefined : (truePositives + trueNegatives) / cases,
    caseIds: comparisons.map((comparison) => comparison.caseId),
  };
}

/** Options for {@link compareRun}. */
export interface CompareOptions {
  /**
   * Dimension groupings to slice by. Defaults to each observed dimension individually.
   *
   * See `deriveScopeSelectors` for why the cross-product is not the default.
   */
  scopeGroupings?: readonly (readonly string[])[];
}

/**
 * Compare an evaluator run against a corpus (contract §12.1).
 *
 * @throws {AldusError} `ALDUS_OUTCOME_UNKNOWN_CASE` when the run reports on a case the corpus
 * does not contain. Refused rather than ignored: an outcome for an unknown case means the run
 * and the corpus disagree about what was tested, and silently dropping it would compute metrics
 * over a set neither party described.
 */
export function compareRun(
  corpus: DefectCorpus,
  run: EvaluatorRun,
  policy: PromotionPolicy,
  options: CompareOptions = {},
): ComparisonReport {
  const byCaseId = new Map(corpus.cases.map((entry) => [entry.caseId, entry]));
  for (const outcome of run.outcomes) {
    if (!byCaseId.has(outcome.caseId)) {
      throw regressionError(
        RegressionErrorCodes.OUTCOME_UNKNOWN_CASE,
        `The evaluator run reports on case "${outcome.caseId}", which corpus ` +
          `"${corpus.corpusId}" does not contain.`,
        {
          category: "validation",
          details: { caseId: outcome.caseId, corpusId: corpus.corpusId },
        },
      );
    }
  }

  const outcomeByCaseId = new Map(run.outcomes.map((outcome) => [outcome.caseId, outcome]));
  const comparisons = corpus.cases.map((entry) =>
    compareCase(entry, outcomeByCaseId.get(entry.caseId), policy),
  );

  const labellersFor = (subset: readonly DefectCase[]): Set<string> =>
    new Set(subset.map((entry) => entry.labelledBy.id));

  const selectors = deriveScopeSelectors(
    corpus.cases.map((entry) => entry.scope),
    options.scopeGroupings,
  );

  const slices = selectors.map((selector) => {
    const matching = corpus.cases.filter((entry) => scopeMatches(entry.scope, selector));
    const matchingIds = new Set(matching.map((entry) => entry.caseId));
    return summarise(
      selector,
      comparisons.filter((comparison) => matchingIds.has(comparison.caseId)),
      labellersFor(matching),
    );
  });

  return {
    evaluatorId: run.evaluatorId,
    evaluatorVersion: run.evaluatorVersion,
    corpusId: corpus.corpusId,
    wholeCorpus: summarise(WHOLE_CORPUS_SLICE, comparisons, labellersFor(corpus.cases)),
    slices,
    comparisons,
    unevaluatedCaseIds: corpus.cases
      .filter((entry) => !outcomeByCaseId.has(entry.caseId))
      .map((entry) => entry.caseId),
  };
}
