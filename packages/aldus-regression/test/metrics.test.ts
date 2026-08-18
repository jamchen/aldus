import { AldusError } from "@aldus-runtime/core";
import { describe, expect, it } from "vitest";

import { compareRun } from "../src/metrics.js";
import { RegressionErrorCodes } from "../src/errors.js";
import { aCase, aCorpus, anOutcome, aRun, policy, SEVERITY_WEIGHTS } from "./helpers.js";

const scope = { host: "example-host" };

describe("confusion counting", () => {
  it("classifies each of the four outcomes", () => {
    const corpus = aCorpus([
      aCase({ id: "tp", scope, defective: true, severity: "major" }),
      aCase({ id: "fn", scope, defective: true, severity: "major" }),
      aCase({ id: "fp", scope, defective: false }),
      aCase({ id: "tn", scope, defective: false }),
    ]);
    const run = aRun([
      anOutcome("tp", true),
      anOutcome("fn", false),
      anOutcome("fp", true),
      anOutcome("tn", false),
    ]);

    const report = compareRun(corpus, run, policy());
    expect(report.wholeCorpus.truePositives).toBe(1);
    expect(report.wholeCorpus.falseNegatives).toBe(1);
    expect(report.wholeCorpus.falsePositives).toBe(1);
    expect(report.wholeCorpus.trueNegatives).toBe(1);
    expect(report.wholeCorpus.recall).toBeCloseTo(0.5);
    expect(report.wholeCorpus.falsePositiveRate).toBeCloseTo(0.5);
  });

  // A case the run never reported on is not a case that passed. Counting it as unflagged makes a
  // missing outcome show up as a false negative rather than quietly shrinking the denominator.
  it("treats a case the run never reported on as unflagged, and says so", () => {
    const corpus = aCorpus([aCase({ id: "missing", scope, defective: true, severity: "major" })]);
    const report = compareRun(corpus, aRun([]), policy());
    expect(report.wholeCorpus.falseNegatives).toBe(1);
    expect(report.unevaluatedCaseIds).toEqual(["missing"]);
  });

  it("refuses an outcome for a case the corpus does not contain", () => {
    const corpus = aCorpus([aCase({ id: "a", scope, defective: false })]);
    try {
      compareRun(corpus, aRun([anOutcome("ghost", true)]), policy());
      expect.unreachable("expected an unknown-case error");
    } catch (error) {
      expect((error as AldusError).code).toBe(RegressionErrorCodes.OUTCOME_UNKNOWN_CASE);
    }
  });

  // §12.3 structures findings by category, so flagging the right case for the wrong reason is
  // not full agreement. It stays a true positive — it did catch the case — but it is counted.
  it("counts a detection under the wrong category without downgrading it", () => {
    const corpus = aCorpus([
      aCase({ id: "a", scope, defective: true, severity: "major", category: "persona/tone" }),
    ]);
    const report = compareRun(corpus, aRun([anOutcome("a", true, "audio/clipping")]), policy());
    expect(report.wholeCorpus.truePositives).toBe(1);
    expect(report.wholeCorpus.categoryMismatches).toBe(1);
  });
});

describe("severity weighting (contract §12.1)", () => {
  // The point of weighting: two evaluators with identical recall are not equivalent if one
  // misses the critical defect and the other misses a minor one.
  it("separates a missed critical from a missed minor at equal recall", () => {
    const corpus = aCorpus([
      aCase({ id: "crit", scope, defective: true, severity: "critical" }),
      aCase({ id: "min", scope, defective: true, severity: "minor" }),
    ]);

    const missedCritical = compareRun(
      corpus,
      aRun([anOutcome("crit", false), anOutcome("min", true)]),
      policy(),
    );
    const missedMinor = compareRun(
      corpus,
      aRun([anOutcome("crit", true), anOutcome("min", false)]),
      policy(),
    );

    expect(missedCritical.wholeCorpus.recall).toBe(missedMinor.wholeCorpus.recall);
    expect(missedCritical.wholeCorpus.severityWeightedFalseNegatives).toBe(
      SEVERITY_WEIGHTS.critical,
    );
    expect(missedMinor.wholeCorpus.severityWeightedFalseNegatives).toBe(SEVERITY_WEIGHTS.minor);
    expect(missedCritical.wholeCorpus.severityWeightedRecall).toBeLessThan(
      missedMinor.wholeCorpus.severityWeightedRecall ?? 1,
    );
  });

  // Weighting an unknown severity as zero would drop the case out of the weighted metric while
  // still printing a plausible number — worse than failing.
  it("refuses a severity the policy assigns no weight to", () => {
    const corpus = aCorpus([aCase({ id: "a", scope, defective: true, severity: "unheard-of" })]);
    try {
      compareRun(corpus, aRun([anOutcome("a", true)]), policy());
      expect.unreachable("expected an unweighted-severity error");
    } catch (error) {
      expect((error as AldusError).code).toBe(RegressionErrorCodes.SEVERITY_UNWEIGHTED);
    }
  });
});

describe("asymmetric harm (contract §12.1, §12.4)", () => {
  // §12.1 names harm from unnecessary automatic correction as its own consideration. Two
  // evaluators with the same false-positive rate are not equivalent if one spuriously triggers a
  // narration rewrite (invalidating the Content Freeze, §13.1) and the other raises an advisory.
  it("distinguishes two evaluators with identical false-positive rates", () => {
    const cheap = aCorpus([
      aCase({ id: "a", scope, defective: false, correctionOnFlag: "advisory" }),
      aCase({ id: "b", scope, defective: false, correctionOnFlag: "advisory" }),
    ]);
    const expensive = aCorpus([
      aCase({ id: "a", scope, defective: false, correctionOnFlag: "reviseNarration" }),
      aCase({ id: "b", scope, defective: false, correctionOnFlag: "reviseNarration" }),
    ]);
    const run = aRun([anOutcome("a", true), anOutcome("b", false)]);

    const cheapReport = compareRun(cheap, run, policy());
    const expensiveReport = compareRun(expensive, run, policy());

    expect(cheapReport.wholeCorpus.falsePositiveRate).toBe(
      expensiveReport.wholeCorpus.falsePositiveRate,
    );
    expect(cheapReport.wholeCorpus.unnecessaryCorrectionHarm).toBe(0);
    expect(expensiveReport.wholeCorpus.unnecessaryCorrectionHarm).toBe(10);
  });

  it("charges harm only for spurious flags, never for correct ones", () => {
    const corpus = aCorpus([
      aCase({
        id: "a",
        scope,
        defective: true,
        severity: "major",
        correctionOnFlag: "reviseNarration",
      }),
    ]);
    const report = compareRun(corpus, aRun([anOutcome("a", true)]), policy());
    expect(report.wholeCorpus.unnecessaryCorrectionHarm).toBe(0);
  });

  it("refuses a correction class the policy assigns no harm weight to", () => {
    const corpus = aCorpus([
      aCase({ id: "a", scope, defective: false, correctionOnFlag: "teleport-the-episode" }),
    ]);
    try {
      compareRun(corpus, aRun([anOutcome("a", true)]), policy());
      expect.unreachable("expected an unweighted-correction-class error");
    } catch (error) {
      expect((error as AldusError).code).toBe(RegressionErrorCodes.CORRECTION_CLASS_UNWEIGHTED);
    }
  });
});

describe("unmeasurable metrics", () => {
  it("reports recall as unmeasurable when nothing was labelled defective", () => {
    const corpus = aCorpus([aCase({ id: "a", scope, defective: false })]);
    const report = compareRun(corpus, aRun([anOutcome("a", false)]), policy());
    expect(report.wholeCorpus.recall).toBeUndefined();
    expect(report.wholeCorpus.falsePositiveRate).toBe(0);
  });

  it("reports the false-positive rate as unmeasurable when nothing was labelled clean", () => {
    const corpus = aCorpus([aCase({ id: "a", scope, defective: true, severity: "minor" })]);
    const report = compareRun(corpus, aRun([anOutcome("a", true)]), policy());
    expect(report.wholeCorpus.falsePositiveRate).toBeUndefined();
    expect(report.wholeCorpus.recall).toBe(1);
  });
});

describe("naming (contract §12)", () => {
  // §12: "Machine pass MUST NOT be presented as semantic correctness." The metric is agreement
  // with human labels, and the field name is the first place that guarantee can be lost.
  it("exposes agreement, not accuracy", () => {
    const corpus = aCorpus([aCase({ id: "a", scope, defective: false })]);
    const report = compareRun(corpus, aRun([anOutcome("a", false)]), policy());
    const keys = Object.keys(report.wholeCorpus);
    expect(keys).toContain("agreementWithHumanLabels");
    expect(keys.join(" ").toLowerCase()).not.toMatch(/accuracy|correctness/);
  });
});
