/**
 * A Stage declaring that it executes an evaluator (contract §12, §12.1; #115).
 *
 * §12's model lived only in `gate-engine`, so a gate could declare a level and carry calibration
 * evidence while a Stage running the same evaluator could declare nothing. Adopters run evaluators
 * as Stages — the first one has four, one of them blocking Runs — so the clause was enforced at one
 * of the two places it applies.
 *
 * The channels are per finding class rather than per Stage, because a real evaluator is not one
 * thing: the adopter's checker emits errors that block and warnings that do not, from one
 * deterministic implementation.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { aStage, makeTempRun, type TempRun } from "./helpers.js";

let harness: TempRun;

beforeEach(async () => {
  harness = await makeTempRun();
});

afterEach(async () => {
  await harness.cleanup();
});

const evidence = { reportRef: "calibration-2026-08", scope: { show: "example-show" } };

describe("a Stage declaring quality claims", () => {
  it("accepts a deterministic checker that blocks, with no calibration evidence", () => {
    // The adopter's actual case, and the one a narrower rule would have got wrong. §12.1 governs
    // an evaluator *becoming* blocking; a hard gate blocks by definition and has nothing to
    // calibrate. The classification follows from the nature of the judgement, not from the
    // subject being prose or the measured false-positive rate.
    expect(() =>
      harness.registry.register(
        aStage({
          id: "script.lint",
          evaluation: {
            channels: [
              { findingClass: "error", level: "hard_gate", enforcement: "blocking" },
              { findingClass: "warning", level: "advisory_signal", enforcement: "advisory" },
            ],
            scopeLimitations: ["appendix sections are cut before checking"],
          },
        }),
      ),
    ).not.toThrow();
  });

  it("refuses a model-assisted channel that blocks without evidence", () => {
    expect(() =>
      harness.registry.register(
        aStage({
          id: "semantic.review",
          evaluation: {
            channels: [{ findingClass: "error", level: "model_assisted", enforcement: "blocking" }],
          },
        }),
      ),
    ).toThrow(/calibrat/i);
  });

  it("accepts the same channel once it carries scoped evidence", () => {
    expect(() =>
      harness.registry.register(
        aStage({
          id: "semantic.review",
          evaluation: {
            channels: [
              {
                findingClass: "error",
                level: "model_assisted",
                enforcement: "blocking",
                promotionEvidence: evidence,
              },
            ],
          },
        }),
      ),
    ).not.toThrow();
  });

  it("refuses an advisory signal declared blocking", () => {
    // Not a stricter policy but a contradiction: §12 level 2 reports without blocking.
    expect(() =>
      harness.registry.register(
        aStage({
          id: "rhythm.check",
          evaluation: {
            channels: [
              { findingClass: "error", level: "advisory_signal", enforcement: "blocking" },
            ],
          },
        }),
      ),
    ).toThrow(/contradiction|without blocking/i);
  });

  it("refuses evidence that names no scope", () => {
    // §12.1: evidence for one show, host, voice or model must not silently authorize blocking
    // outside it. Unscoped evidence would authorize everywhere.
    expect(() =>
      harness.registry.register(
        aStage({
          id: "semantic.review",
          evaluation: {
            channels: [
              {
                findingClass: "error",
                level: "model_assisted",
                enforcement: "blocking",
                promotionEvidence: { reportRef: "r", scope: {} },
              },
            ],
          },
        }),
      ),
    ).toThrow(/scope/i);
  });

  it("refuses two claims about one finding class", () => {
    expect(() =>
      harness.registry.register(
        aStage({
          id: "script.lint",
          evaluation: {
            channels: [
              { findingClass: "error", level: "hard_gate", enforcement: "blocking" },
              { findingClass: "error", level: "advisory_signal", enforcement: "advisory" },
            ],
          },
        }),
      ),
    ).toThrow(/twice/i);
  });

  it("refuses a declaration that claims nothing", () => {
    expect(() =>
      harness.registry.register(aStage({ id: "empty", evaluation: { channels: [] } })),
    ).toThrow(/names no finding classes/i);
  });

  it("leaves an ordinary stage ordinary", () => {
    // The property that keeps this optional: most stages are not evaluators and declare nothing.
    expect(() => harness.registry.register(aStage({ id: "render" }))).not.toThrow();
  });
});
