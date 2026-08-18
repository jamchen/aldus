/**
 * The promotion report (architecture contract §12, §12.1).
 *
 * §12 states: "Machine pass MUST NOT be presented as semantic correctness." That is a constraint
 * on *this file* more than any other, because this is where numbers become prose a human acts
 * on. Three rules follow, and each is pinned by a test:
 *
 * 1. **The aggregate is never rendered alone.** Every rendering that shows the whole-corpus
 *    figure also shows the per-scope breakdown, and labels the aggregate as descriptive. §12.1
 *    requires scope be considered; an aggregate-only report is how that requirement gets
 *    quietly dropped.
 * 2. **No word implying correctness.** The report says "agreed with human labels", never
 *    "accurate", "correct", or "passed". A reader skimming for a verdict must not find one that
 *    was never established.
 * 3. **Blocked means explained.** A slice that fails lists every shortfall with the observed and
 *    required values. "0.94" tells nobody whether to promote.
 */

import type { PromotionVerdict, SliceVerdict } from "./promotion.js";
import type { SliceMetrics } from "./metrics.js";
import { scopeLabel } from "./scope.js";

/** Words this report must never use about an evaluator's output (contract §12). */
const FORBIDDEN_CLAIM_WORDS: readonly string[] = [
  "accurate",
  "accuracy",
  "correctness",
  "correct",
  "proven",
  "verified",
  "guarantees",
];

/**
 * The standing caveat, printed on every report.
 *
 * Not decoration. §12 forbids presenting a machine pass as semantic correctness, and §12.1's
 * scope requirement exists because corpora do not generalise. A reader who takes only the
 * headline away should still have been told both.
 */
export const REPORT_CAVEAT =
  "This report measures agreement with human labels on one corpus. It is not evidence that the " +
  "evaluator is semantically right (architecture contract §12), and it says nothing about " +
  "scopes the corpus does not contain — those were not evaluated and must not be assumed covered.";

function formatRate(value: number | undefined): string {
  return value === undefined ? "unmeasurable" : value.toFixed(3);
}

function renderMetrics(metrics: SliceMetrics, indent: string): string[] {
  return [
    `${indent}cases ${metrics.cases} (${metrics.defectiveCases} labelled defective, ${metrics.cleanCases} labelled clean, ${metrics.labellers} labeller(s))`,
    `${indent}recall ${formatRate(metrics.recall)}   severity-weighted recall ${formatRate(metrics.severityWeightedRecall)}`,
    `${indent}false-positive rate ${formatRate(metrics.falsePositiveRate)}   mean unnecessary-correction harm ${formatRate(metrics.meanUnnecessaryCorrectionHarm)}`,
    `${indent}missed ${metrics.falseNegatives} (weighted ${metrics.severityWeightedFalseNegatives}), spurious flags ${metrics.falsePositives}, wrong-category detections ${metrics.categoryMismatches}`,
    `${indent}agreement with human labels ${formatRate(metrics.agreementWithHumanLabels)}`,
  ];
}

function renderSlice(slice: SliceVerdict): string[] {
  const lines: string[] = [];
  const status = slice.meetsPromotionBar ? "MEETS PROMOTION BAR" : "BLOCKED";
  lines.push(`  [${status}] ${scopeLabel(slice.selector)}`);
  lines.push(...renderMetrics(slice.metrics, "    "));
  if (slice.shortfalls.length > 0) {
    lines.push("    why it is blocked:");
    for (const item of slice.shortfalls) lines.push(`      - ${item.message}`);
  }
  if (slice.openBlindSpots.length > 0) {
    lines.push("    open blind spots:");
    for (const record of slice.openBlindSpots) {
      lines.push(`      - ${record.blindSpotId}: ${record.description}`);
    }
  }
  return lines;
}

/**
 * Render a promotion verdict as plain text (contract §12.1).
 *
 * The whole-corpus figure appears **after** the per-scope breakdown and is explicitly labelled
 * descriptive, so a reader reaches the scope detail first. Ordering is part of the guarantee: a
 * summary at the top is the one people quote.
 */
export function renderPromotionReport(verdict: PromotionVerdict): string {
  const lines: string[] = [];

  lines.push(
    `Evaluator promotion evidence — ${verdict.evaluatorId} @ ${verdict.evaluatorVersion}`,
    `Corpus: ${verdict.corpusId}`,
    "",
    REPORT_CAVEAT,
    "",
  );

  if (verdict.policyOrigin === "default-uncalibrated") {
    lines.push(
      "NOTE: assessed against this package's default thresholds, which have not themselves been " +
        "calibrated against any real corpus (ADR-0010). Treat the bar as provisional.",
      "",
    );
  }

  lines.push(`Scopes assessed: ${verdict.slices.length}`);
  if (verdict.slices.length === 0) {
    lines.push(
      "  none — the corpus declares no scope dimensions, so nothing could be assessed per scope.",
      "  Promotion is scoped (ADR-0010); with no scopes there is no promotion decision to make.",
    );
  }
  lines.push("");

  for (const slice of verdict.slices) lines.push(...renderSlice(slice), "");

  lines.push("Whole corpus (descriptive only — no threshold is applied to it, ADR-0010):");
  lines.push(...renderMetrics(verdict.wholeCorpus, "  "));

  if (verdict.aggregateFlattersWorstScope) {
    lines.push(
      "",
      "WARNING: the whole-corpus figure is better than the worst scope above. Reading the " +
        "aggregate alone would overstate this evaluator (architecture contract §12.1).",
    );
  }

  if (verdict.unevaluatedCaseIds.length > 0) {
    lines.push(
      "",
      `${verdict.unevaluatedCaseIds.length} corpus case(s) the run never reported on; they count ` +
        "as unflagged.",
    );
  }

  lines.push(
    "",
    verdict.promotableScopes.length === 0
      ? "Outcome: no scope meets the promotion bar. The evaluator stays advisory (§12 level 2)."
      : `Outcome: ${verdict.promotableScopes.length} of ${verdict.slices.length} scope(s) meet ` +
          `the bar — ${verdict.promotableScopes.join(", ")}. Promotion applies only to those ` +
          "scopes; every other scope stays advisory.",
  );

  return lines.join("\n");
}

/**
 * Words the report must not use, exported so a test can enforce rule 2 above.
 *
 * Exported rather than kept private because the guarantee is only real if something checks it,
 * and a test importing the same list cannot drift from the implementation.
 */
export function forbiddenClaimWords(): readonly string[] {
  return FORBIDDEN_CLAIM_WORDS;
}
