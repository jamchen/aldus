/**
 * The report is where numbers become prose a human acts on, so §12's rule — "Machine pass MUST
 * NOT be presented as semantic correctness" — binds hardest here. These tests pin the three
 * guarantees the module claims.
 */

import { describe, expect, it } from "vitest";

import { BlindSpotRegistry } from "../src/blindspots.js";
import { compareRun } from "../src/metrics.js";
import { assessPromotion } from "../src/promotion.js";
import { forbiddenClaimWords, REPORT_CAVEAT, renderPromotionReport } from "../src/report.js";
import { aCorpus, aRun, LABELLER_A, lenientPolicy, policy, scenario } from "./helpers.js";

function twoHostVerdict() {
  const good = scenario({ scope: { host: "example-host" }, prefix: "g", defective: 30, clean: 30 });
  const bad = scenario({
    scope: { host: "other-host" },
    prefix: "b",
    defective: 10,
    clean: 10,
    missEvery: 2,
  });
  const corpus = aCorpus([...good.cases, ...bad.cases]);
  const run = aRun([...good.outcomes, ...bad.outcomes]);
  return assessPromotion(compareRun(corpus, run, policy()), policy());
}

describe("report framing (contract §12)", () => {
  it("carries the standing caveat", () => {
    expect(renderPromotionReport(twoHostVerdict())).toContain(REPORT_CAVEAT);
  });

  // Rule 2: no word implying correctness. A reader skimming for a verdict must not find one that
  // was never established.
  it("uses no word implying the evaluator is correct", () => {
    // The caveat is allowed to say what the report is *not*, so it is excluded before matching.
    const text = renderPromotionReport(twoHostVerdict())
      .toLowerCase()
      .replace(REPORT_CAVEAT.toLowerCase(), "");

    for (const word of forbiddenClaimWords()) {
      // Whole words only. "unnecessary-correction harm" is §12.1's own term for the harm a
      // spurious flag causes — it is not a claim that anything was correct, and a substring
      // match would forbid the contract's own vocabulary.
      const wholeWord = new RegExp(`\\b${word}\\b`);
      expect(wholeWord.test(text), `report should not use the word "${word}"`).toBe(false);
    }
  });

  it("describes what it measures as agreement with human labels", () => {
    expect(renderPromotionReport(twoHostVerdict())).toContain("agreement with human labels");
  });
});

describe("scope visibility (contract §12.1)", () => {
  // Rule 1: the aggregate is never rendered alone, and the per-scope breakdown comes first —
  // a summary at the top is the one people quote.
  it("shows every scope before the whole-corpus figure", () => {
    const text = renderPromotionReport(twoHostVerdict());
    const firstScope = text.indexOf("host=example-host");
    const aggregate = text.indexOf("Whole corpus");
    expect(firstScope).toBeGreaterThan(-1);
    expect(aggregate).toBeGreaterThan(firstScope);
  });

  it("labels the whole-corpus figure as descriptive only", () => {
    expect(renderPromotionReport(twoHostVerdict())).toContain("descriptive only");
  });

  it("warns out loud when the aggregate flatters the worst scope", () => {
    const text = renderPromotionReport(twoHostVerdict());
    expect(text).toContain("WARNING");
    expect(text).toContain("would overstate this evaluator");
  });

  it("names the blocked scope and marks the passing one", () => {
    const text = renderPromotionReport(twoHostVerdict());
    expect(text).toContain("[BLOCKED] host=other-host");
    expect(text).toContain("[MEETS PROMOTION BAR] host=example-host");
  });
});

describe("explaining a block (contract §12.1)", () => {
  // Rule 3: "0.94" tells nobody whether to promote.
  it("gives a reason for every shortfall, with what was required", () => {
    const text = renderPromotionReport(twoHostVerdict());
    expect(text).toContain("why it is blocked:");
    expect(text).toMatch(/Recall 0\.\d+ is below the required 0\.95/);
    expect(text).toContain("defect(s) a human found");
  });

  it("lists open blind spots by id and description", () => {
    const good = scenario({
      scope: { host: "example-host" },
      prefix: "g",
      defective: 30,
      clean: 30,
    });
    const registry = BlindSpotRegistry.from([
      {
        blindSpotId: "bs-1",
        evaluatorId: "evaluator-a",
        description: "Misses homophone substitution in long segments.",
        scope: {},
        status: "open",
        evidenceCaseIds: [],
        recordedBy: LABELLER_A,
        recordedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    const verdict = assessPromotion(
      compareRun(aCorpus(good.cases), aRun(good.outcomes), policy()),
      policy(),
      registry,
    );
    const text = renderPromotionReport(verdict);
    expect(text).toContain("open blind spots:");
    expect(text).toContain("bs-1: Misses homophone substitution in long segments.");
  });

  it("says the evaluator stays advisory when nothing clears the bar", () => {
    const bad = scenario({
      scope: { host: "example-host" },
      prefix: "b",
      defective: 10,
      clean: 10,
      missEvery: 2,
    });
    const verdict = assessPromotion(
      compareRun(aCorpus(bad.cases), aRun(bad.outcomes), policy()),
      policy(),
    );
    expect(renderPromotionReport(verdict)).toContain("The evaluator stays advisory");
  });
});

describe("policy provenance in the report (ADR-0010)", () => {
  it("flags a verdict measured against uncalibrated defaults", () => {
    expect(renderPromotionReport(twoHostVerdict())).toContain(
      "have not themselves been calibrated",
    );
  });

  it("omits the note when the bar was configured", () => {
    const good = scenario({ scope: { host: "example-host" }, prefix: "g", defective: 2, clean: 2 });
    const configured = lenientPolicy();
    const verdict = assessPromotion(
      compareRun(aCorpus(good.cases), aRun(good.outcomes), configured),
      configured,
    );
    expect(renderPromotionReport(verdict)).not.toContain("have not themselves been calibrated");
  });
});

describe("a corpus with no scopes", () => {
  it("says plainly that no promotion decision could be made", () => {
    const flat = scenario({ scope: {}, prefix: "f", defective: 30, clean: 30 });
    const verdict = assessPromotion(
      compareRun(aCorpus(flat.cases), aRun(flat.outcomes), policy()),
      policy(),
    );
    const text = renderPromotionReport(verdict);
    expect(text).toContain("the corpus declares no scope dimensions");
    expect(text).toContain("no scope meets the promotion bar");
  });
});
