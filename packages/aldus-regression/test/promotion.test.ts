/**
 * Promotion assessment (contract §12.1, ADR-0010).
 *
 * The centrepiece is "hides a failing scope behind a good aggregate" — the specific failure
 * §12.1's scope requirement exists to prevent. It builds an evaluator that looks strong across
 * the corpus and is quietly useless on one host, and proves the verdict refuses to promote it
 * there.
 */

import { describe, expect, it } from "vitest";

import { BlindSpotRegistry } from "../src/blindspots.js";
import { compareRun } from "../src/metrics.js";
import { assessPromotion, isPromotableEverywhereMeasured } from "../src/promotion.js";
import { defaultPromotionPolicy } from "../src/policy.js";
import { scopeKey } from "../src/scope.js";
import {
  aCorpus,
  aRun,
  LABELLER_A,
  LABELLER_B,
  lenientPolicy,
  policy,
  scenario,
  SEVERITY_WEIGHTS,
} from "./helpers.js";

/** A corpus in which the evaluator is strong on one host and blind on another. */
function twoHostCorpus() {
  // 60 cases on the good host: catches every defect, no spurious flags.
  const good = scenario({
    scope: { host: "example-host" },
    prefix: "good",
    defective: 30,
    clean: 30,
    labelledBy: LABELLER_A,
  });
  // 20 cases on the second host: misses every other defect.
  const bad = scenario({
    scope: { host: "other-host" },
    prefix: "bad",
    defective: 10,
    clean: 10,
    missEvery: 2,
    labelledBy: LABELLER_A,
  });
  return {
    corpus: aCorpus([...good.cases, ...bad.cases]),
    run: aRun([...good.outcomes, ...bad.outcomes]),
  };
}

describe("scoped promotion", () => {
  it("promotes only the scopes that clear the bar", () => {
    const { corpus, run } = twoHostCorpus();
    const verdict = assessPromotion(compareRun(corpus, run, policy()), policy());

    expect(verdict.promotableScopes).toEqual(["host=example-host"]);
    expect(verdict.blockedScopes).toEqual(["host=other-host"]);
    expect(isPromotableEverywhereMeasured(verdict)).toBe(false);
  });

  // The failure §12.1's scope requirement exists to prevent, stated as a test.
  it("refuses to let a strong aggregate hide a failing scope", () => {
    const { corpus, run } = twoHostCorpus();
    const comparison = compareRun(corpus, run, policy());

    // Aggregate looks strong...
    expect(comparison.wholeCorpus.agreementWithHumanLabels ?? 0).toBeGreaterThan(0.9);

    // ...while one scope is plainly not.
    const worst = comparison.slices.find((slice) => slice.key === "host=other-host");
    expect(worst?.recall).toBeLessThan(0.6);

    const verdict = assessPromotion(comparison, policy());
    expect(verdict.aggregateFlattersWorstScope).toBe(true);
    expect(verdict.blockedScopes).toContain("host=other-host");
  });

  // No threshold is applied to the aggregate (ADR-0010 decision 3), so a corpus that is
  // excellent overall still yields no promotion when it has no scopes to promote within.
  it("makes no promotion decision at all when the corpus declares no scope", () => {
    const flat = scenario({ scope: {}, prefix: "flat", defective: 30, clean: 30 });
    const verdict = assessPromotion(
      compareRun(aCorpus(flat.cases), aRun(flat.outcomes), policy()),
      policy(),
    );

    expect(verdict.wholeCorpus.recall).toBe(1);
    expect(verdict.slices).toEqual([]);
    expect(verdict.promotableScopes).toEqual([]);
    // An empty slice list must not read as universal approval.
    expect(isPromotableEverywhereMeasured(verdict)).toBe(false);
  });
});

describe("evidence thresholds", () => {
  it("blocks a scope with too few cases, however perfect its metrics", () => {
    const tiny = scenario({
      scope: { host: "example-host" },
      prefix: "tiny",
      defective: 2,
      clean: 2,
    });
    const verdict = assessPromotion(
      compareRun(aCorpus(tiny.cases), aRun(tiny.outcomes), policy()),
      policy(),
    );

    const slice = verdict.slices[0];
    expect(slice?.metrics.recall).toBe(1);
    expect(slice?.meetsPromotionBar).toBe(false);
    expect(slice?.shortfalls.map((item) => item.code)).toContain("insufficient_cases");
  });

  // An undefined metric is a shortfall, never a pass. Treating it as satisfied would promote an
  // evaluator that was never tested against a single defect.
  it("treats an unmeasurable metric as a shortfall", () => {
    const cleanOnly = scenario({
      scope: { host: "example-host" },
      prefix: "clean",
      defective: 0,
      clean: 60,
    });
    const verdict = assessPromotion(
      compareRun(aCorpus(cleanOnly.cases), aRun(cleanOnly.outcomes), policy()),
      policy(),
    );

    const slice = verdict.slices[0];
    expect(slice?.metrics.recall).toBeUndefined();
    expect(slice?.meetsPromotionBar).toBe(false);
    expect(slice?.shortfalls.map((item) => item.code)).toContain("unmeasurable");
  });

  it("blocks on severity-weighted recall even when plain recall clears the bar", () => {
    // 20 minor defects all caught, 1 critical missed: recall 0.952, weighted recall 0.5.
    const cases = [];
    const outcomes = [];
    for (let index = 0; index < 20; index += 1) {
      const id = `m${index}`;
      cases.push({
        caseId: id,
        subjectRef: `artifact://${id}`,
        scope: { host: "example-host" },
        defective: true,
        findings: [{ category: "structure/repetition", severity: "minor" }],
        severity: "minor",
        labelledBy: LABELLER_A,
        labelledAt: "2026-01-01T00:00:00.000Z",
      });
      outcomes.push({
        caseId: id,
        flagged: true,
        findings: [{ category: "structure/repetition" }],
      });
    }
    cases.push({
      caseId: "crit",
      subjectRef: "artifact://crit",
      scope: { host: "example-host" },
      defective: true,
      findings: [{ category: "semantic/unsupported-claim", severity: "critical" }],
      severity: "critical",
      labelledBy: LABELLER_A,
      labelledAt: "2026-01-01T00:00:00.000Z",
    });
    outcomes.push({ caseId: "crit", flagged: false, findings: [] });
    for (let index = 0; index < 30; index += 1) {
      const id = `c${index}`;
      cases.push({
        caseId: id,
        subjectRef: `artifact://${id}`,
        scope: { host: "example-host" },
        defective: false,
        findings: [],
        labelledBy: LABELLER_A,
        labelledAt: "2026-01-01T00:00:00.000Z",
      });
      outcomes.push({ caseId: id, flagged: false, findings: [] });
    }

    const verdict = assessPromotion(
      compareRun(aCorpus(cases as never), aRun(outcomes as never), policy()),
      policy(),
    );
    const slice = verdict.slices[0];
    expect(slice?.metrics.recall ?? 0).toBeGreaterThan(0.95);
    expect(slice?.metrics.severityWeightedRecall ?? 1).toBeLessThan(0.98);
    expect(slice?.shortfalls.map((item) => item.code)).toContain(
      "severity_weighted_recall_below_threshold",
    );
  });

  // §12.1 weighs harm from unnecessary correction separately from how often it happens. An
  // evaluator can clear the rate while every one of its few false positives is expensive.
  it("blocks on correction harm while the false-positive rate is within bounds", () => {
    const expensive = scenario({
      scope: { host: "example-host" },
      prefix: "exp",
      defective: 30,
      clean: 30,
      falseFlagEvery: 30,
      correctionOnFlag: "reviseNarration",
    });
    const verdict = assessPromotion(
      compareRun(aCorpus(expensive.cases), aRun(expensive.outcomes), policy()),
      policy(),
    );

    const slice = verdict.slices[0];
    expect(slice?.metrics.falsePositiveRate ?? 1).toBeLessThanOrEqual(0.05);
    expect(slice?.shortfalls.map((item) => item.code)).toContain(
      "unnecessary_correction_harm_above_threshold",
    );
  });

  it("blocks a scope labelled by fewer people than the policy requires", () => {
    const single = scenario({
      scope: { host: "example-host" },
      prefix: "single",
      defective: 30,
      clean: 30,
      labelledBy: LABELLER_A,
    });
    const strict = defaultPromotionPolicy(SEVERITY_WEIGHTS, {
      thresholds: { ...policy().thresholds, minLabellers: 2 },
    });
    const verdict = assessPromotion(
      compareRun(aCorpus(single.cases), aRun(single.outcomes), strict),
      strict,
    );
    expect(verdict.slices[0]?.shortfalls.map((item) => item.code)).toContain(
      "insufficient_labellers",
    );
  });

  it("counts distinct labellers", () => {
    const a = scenario({
      scope: { host: "example-host" },
      prefix: "a",
      defective: 15,
      clean: 15,
      labelledBy: LABELLER_A,
    });
    const b = scenario({
      scope: { host: "example-host" },
      prefix: "b",
      defective: 15,
      clean: 15,
      labelledBy: LABELLER_B,
    });
    const verdict = assessPromotion(
      compareRun(aCorpus([...a.cases, ...b.cases]), aRun([...a.outcomes, ...b.outcomes]), policy()),
      policy(),
    );
    expect(verdict.slices[0]?.metrics.labellers).toBe(2);
  });
});

describe("blind spots (contract §12.1, §9.3)", () => {
  const blindSpot = {
    blindSpotId: "bs-1",
    evaluatorId: "evaluator-a",
    description: "Does not detect homophone substitution in the second half of a segment.",
    scope: { host: "example-host" },
    status: "open" as const,
    evidenceCaseIds: [],
    recordedBy: LABELLER_A,
    recordedAt: "2026-01-01T00:00:00.000Z",
  };

  function perfectRun() {
    const good = scenario({
      scope: { host: "example-host" },
      prefix: "g",
      defective: 30,
      clean: 30,
    });
    return { corpus: aCorpus(good.cases), run: aRun(good.outcomes) };
  }

  // Corpus metrics are not evidence against a blind spot — a blind spot is what the corpus did
  // not sample. Perfect numbers must not override it.
  it("disqualifies a scope with an open blind spot despite perfect metrics", () => {
    const { corpus, run } = perfectRun();
    const registry = BlindSpotRegistry.from([blindSpot]);
    const verdict = assessPromotion(compareRun(corpus, run, policy()), policy(), registry);

    const slice = verdict.slices[0];
    expect(slice?.metrics.recall).toBe(1);
    expect(slice?.metrics.falsePositiveRate).toBe(0);
    expect(slice?.meetsPromotionBar).toBe(false);
    expect(slice?.shortfalls.map((item) => item.code)).toContain("open_blind_spot");
    expect(slice?.openBlindSpots.map((record) => record.blindSpotId)).toEqual(["bs-1"]);
  });

  it("does not disqualify once the blind spot is mitigated", () => {
    const { corpus, run } = perfectRun();
    const registry = BlindSpotRegistry.from([
      { ...blindSpot, status: "mitigated", mitigation: "Added a second pass." },
    ]);
    const verdict = assessPromotion(compareRun(corpus, run, policy()), policy(), registry);
    expect(verdict.slices[0]?.meetsPromotionBar).toBe(true);
  });

  // A blind spot on one voice is not a reason to block every other voice.
  it("disqualifies only the scopes the blind spot covers", () => {
    const good = scenario({ scope: { voice: "voice-a" }, prefix: "va", defective: 30, clean: 30 });
    const other = scenario({ scope: { voice: "voice-b" }, prefix: "vb", defective: 30, clean: 30 });
    const registry = BlindSpotRegistry.from([{ ...blindSpot, scope: { voice: "voice-a" } }]);
    const verdict = assessPromotion(
      compareRun(
        aCorpus([...good.cases, ...other.cases]),
        aRun([...good.outcomes, ...other.outcomes]),
        policy(),
      ),
      policy(),
      registry,
    );

    expect(verdict.blockedScopes).toEqual(["voice=voice-a"]);
    expect(verdict.promotableScopes).toEqual(["voice=voice-b"]);
  });
});

describe("policy provenance", () => {
  // A verdict is only as trustworthy as the bar it was measured against (ADR-0010).
  it("marks a verdict measured against uncalibrated defaults", () => {
    const good = scenario({
      scope: { host: "example-host" },
      prefix: "g",
      defective: 30,
      clean: 30,
    });
    const verdict = assessPromotion(
      compareRun(aCorpus(good.cases), aRun(good.outcomes), policy()),
      policy(),
    );
    expect(verdict.policyOrigin).toBe("default-uncalibrated");
  });

  it("marks a verdict measured against a configured bar", () => {
    const good = scenario({ scope: { host: "example-host" }, prefix: "g", defective: 2, clean: 2 });
    const configured = lenientPolicy();
    const verdict = assessPromotion(
      compareRun(aCorpus(good.cases), aRun(good.outcomes), configured),
      configured,
    );
    expect(verdict.policyOrigin).toBe("configured");
    expect(verdict.promotableScopes).toEqual([scopeKey(verdict.slices[0]!.selector)]);
  });
});
