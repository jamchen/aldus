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

import { asEnumeratedFinding, countEvaluationEvidence } from "../src/definition.js";

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
              {
                findingClass: "error",
                level: "hard_gate",
                enforcement: "blocking",
                evidenceKind: "enumerated_findings",
              },
              {
                findingClass: "warning",
                level: "advisory_signal",
                enforcement: "advisory",
                evidenceKind: "enumerated_findings",
              },
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
            channels: [
              {
                findingClass: "error",
                level: "model_assisted",
                enforcement: "blocking",
                evidenceKind: "enumerated_findings",
              },
            ],
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
                evidenceKind: "enumerated_findings",
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
              {
                findingClass: "error",
                level: "advisory_signal",
                enforcement: "blocking",
                evidenceKind: "enumerated_findings",
              },
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
                evidenceKind: "enumerated_findings",
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
              {
                findingClass: "error",
                level: "hard_gate",
                enforcement: "blocking",
                evidenceKind: "enumerated_findings",
              },
              {
                findingClass: "error",
                level: "advisory_signal",
                enforcement: "advisory",
                evidenceKind: "enumerated_findings",
              },
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

describe("an evaluator that ran and found something (#115)", () => {
  // The owner's requirement, verbatim: "An evaluator that could not execute, parse its inputs or
  // produce a valid report causes an operational Stage failure. An evaluator that executed
  // successfully and found a content problem produces an evaluation result." The two must be
  // distinguishable in the trace — an adopter's linter crashed on every run and the crash was
  // counted as a soft finding for the length of a migration, because nothing told them apart.

  const linter = (findings: { findingClass: string; message: string }[]) =>
    aStage({
      id: "stage-a",
      evaluation: {
        channels: [
          {
            findingClass: "error",
            level: "hard_gate",
            enforcement: "blocking",
            evidenceKind: "enumerated_findings",
          },
          {
            findingClass: "warning",
            level: "advisory_signal",
            enforcement: "advisory",
            evidenceKind: "enumerated_findings",
          },
        ],
      },
      execute: async () => ({
        kind: "evaluated",
        output: { checked: 12 },
        observations: findings.map((finding) => ({ ...finding, kind: "finding" as const })),
      }),
    });

  it("blocks on a finding whose class is declared blocking, and says it was a finding", async () => {
    harness.registry.register(linter([{ findingClass: "error", message: "unsupported claim" }]));

    const result = await harness.runner.run(harness.manifest.runId, "stage-a", {});

    expect(result.status).toBe("failed");
    // The distinguishing bit. A reader of the trace can tell this from a thrown evaluator: the
    // code is the evaluation-specific one, and the category is policy rather than internal.
    expect(result.error?.code).toBe("ALDUS_STAGE_EVALUATION_BLOCKED");
    expect(result.error?.category).toBe("policy");
  });

  it("does not block on an advisory finding, and records it anyway", async () => {
    harness.registry.register(linter([{ findingClass: "warning", message: "long sentence" }]));

    const result = await harness.runner.run(harness.manifest.runId, "stage-a", {});

    expect(result.status).toBe("succeeded");
    expect(result.output).toEqual({ checked: 12 });

    // The half that is easy to lose. `notes` used to be captured before the evaluation ran, so an
    // advisory finding vanished and left a green record — which §12 says never means semantic
    // correctness, and which this asserts rather than trusts.
    const stored = await harness.runner.stageExecution(harness.manifest.runId, "stage-a");
    const attemptId = stored?.execution.attempts.at(-1)?.attemptId ?? "";
    const notes = stored?.metadata[attemptId]?.notes ?? [];
    expect(notes.join(" ")).toContain("long sentence");
  });

  it("refuses a finding whose class the Stage never declared", async () => {
    // Not defaulted to advisory, and not defaulted to blocking. The safe default and the useful
    // one point in opposite directions, so the enforcement of an undeclared class would be
    // decided by a guess nobody wrote down.
    harness.registry.register(linter([{ findingClass: "fatal", message: "parser gave up" }]));

    const result = await harness.runner.run(harness.manifest.runId, "stage-a", {});

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("ALDUS_STAGE_EVALUATION_INVALID");
  });

  it("distinguishes an evaluator that failed from an evaluator that found a defect", async () => {
    // Two stages, one throwing and one reporting, compared in one test so the distinction is
    // asserted rather than assumed. Before #115 both arrived as an indistinguishable failure.
    harness.registry.register(linter([{ findingClass: "error", message: "unsupported claim" }]));
    harness.registry.register(
      aStage({
        id: "stage-b",
        evaluation: {
          channels: [
            {
              findingClass: "error",
              level: "hard_gate",
              enforcement: "blocking",
              evidenceKind: "enumerated_findings",
            },
          ],
        },
        execute: async () => {
          throw new Error("the evaluator's own parser threw");
        },
      }),
    );

    const found = await harness.runner.run(harness.manifest.runId, "stage-a", {});
    const broke = await harness.runner.run(harness.manifest.runId, "stage-b", {});

    expect(found.status).toBe("failed");
    expect(broke.status).toBe("failed");
    expect(found.error?.code).not.toBe(broke.error?.code);
    expect(found.error?.code).toBe("ALDUS_STAGE_EVALUATION_BLOCKED");
    expect(broke.error?.code).toBe("ALDUS_STAGE_EXECUTION_FAILED");
  });

  it("blocks only through a declared channel, never at the Stage's own discretion", async () => {
    // The reason channels are worth declaring. The same finding, emitted by a Stage that declared
    // its class advisory, does not stop work — the Stage cannot promote its own findings past the
    // enforcement it declared (§12.1).
    harness.registry.register(
      aStage({
        id: "stage-a",
        evaluation: {
          channels: [
            {
              findingClass: "error",
              level: "hard_gate",
              enforcement: "advisory",
              evidenceKind: "enumerated_findings",
            },
          ],
        },
        execute: async () => ({
          kind: "evaluated",
          output: {},
          observations: [
            { kind: "finding" as const, findingClass: "error", message: "unsupported claim" },
          ],
        }),
      }),
    );

    const result = await harness.runner.run(harness.manifest.runId, "stage-a", {});

    expect(result.status).toBe("succeeded");
  });
});

describe("the seven acceptance cases of the #140 ruling", () => {
  // The distinction is countability, not scope. A document-wide omission may be one enumerated
  // defect; a report about one file may contain forty. Subject scope and statistical cardinality
  // are orthogonal, which is why `granularity: "site" | "run"` was rejected.

  const enumerating = {
    findingClass: "error",
    level: "hard_gate",
    enforcement: "blocking",
    evidenceKind: "enumerated_findings",
  } as const;
  const reporting = {
    findingClass: "vendored",
    level: "advisory_signal",
    enforcement: "advisory",
    evidenceKind: "aggregate_reports",
  } as const;

  it("1. a structured linter produces multiple enumerated findings", async () => {
    harness.registry.register(
      aStage({
        id: "stage-a",
        evaluation: { channels: [enumerating] },
        execute: async () => ({
          kind: "evaluated",
          output: {},
          observations: [
            { kind: "finding", findingClass: "error", message: "one" },
            { kind: "finding", findingClass: "error", message: "two" },
          ],
        }),
      }),
    );

    const result = await harness.runner.run(harness.manifest.runId, "stage-a", {});
    expect(result.status).toBe("failed");
    expect(
      countEvaluationEvidence([
        { kind: "finding", findingClass: "error", message: "one" },
        { kind: "finding", findingClass: "error", message: "two" },
      ]),
    ).toEqual({ enumeratedFindings: 2, reports: 0, defectCountMeasurable: true });
  });

  it("2. a vendored linter produces one aggregate report", async () => {
    harness.registry.register(
      aStage({
        id: "stage-a",
        evaluation: { channels: [reporting] },
        execute: async () => ({
          kind: "evaluated",
          output: {},
          observations: [
            { kind: "report", findingClass: "vendored", message: "lint-sources exited 1" },
          ],
        }),
      }),
    );

    const result = await harness.runner.run(harness.manifest.runId, "stage-a", {});
    expect(result.status).toBe("succeeded");

    const stored = await harness.runner.stageExecution(harness.manifest.runId, "stage-a");
    const attemptId = stored?.execution.attempts.at(-1)?.attemptId ?? "";
    const notes = (stored?.metadata[attemptId]?.notes ?? []).join(" ");
    // The kind is in the note. A note reading only "vendored: …" is the record that gets counted
    // as one defect later.
    expect(notes).toContain("report/vendored");
    expect(notes).toContain("not measurable");
  });

  it("3. both forms trigger the channel's declared enforcement", async () => {
    // Countability and blocking are separate questions. A report that cannot be counted can still
    // stop work — and an enumerated finding on an advisory channel still cannot.
    harness.registry.register(
      aStage({
        id: "stage-a",
        // `hard_gate`, not `advisory_signal` — the first draft of this test spread `blocking` onto
        // an advisory signal and was correctly refused as a §12 contradiction. A vendored linter's
        // exit code is objectively testable, so level 1 is the honest classification, and this is
        // the pairing §12's table permits: level and enforcement are chosen separately.
        evaluation: {
          channels: [
            {
              ...reporting,
              level: "hard_gate",
              enforcement: "blocking",
              evidenceKind: "enumerated_findings",
            },
          ],
        },
        execute: async () => ({
          kind: "evaluated",
          output: {},
          observations: [{ kind: "report", findingClass: "vendored", message: "exited 1" }],
        }),
      }),
    );
    harness.registry.register(
      aStage({
        id: "stage-b",
        evaluation: { channels: [{ ...enumerating, enforcement: "advisory" }] },
        execute: async () => ({
          kind: "evaluated",
          output: {},
          observations: [{ kind: "finding", findingClass: "error", message: "one" }],
        }),
      }),
    );

    const blockingReport = await harness.runner.run(harness.manifest.runId, "stage-a", {});
    const advisoryFinding = await harness.runner.run(harness.manifest.runId, "stage-b", {});

    expect(blockingReport.status).toBe("failed");
    expect(advisoryFinding.status).toBe("succeeded");
  });

  it("4. emitted evidence disagreeing with the channel declaration is refused", async () => {
    harness.registry.register(
      aStage({
        id: "stage-a",
        evaluation: { channels: [enumerating] },
        execute: async () => ({
          kind: "evaluated",
          output: {},
          // Declared enumerated, emitted a report.
          observations: [{ kind: "report", findingClass: "error", message: "something happened" }],
        }),
      }),
    );

    const result = await harness.runner.run(harness.manifest.runId, "stage-a", {});

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("ALDUS_STAGE_EVALUATION_INVALID");
    expect(result.error?.message).toContain("enumerated_findings");
  });

  it("5. reports are excluded from defect-count aggregation", async () => {
    // The rule the whole model exists for. Three reports are not three defects, and they are not
    // zero either — the count is unmeasurable, and saying so is the only honest answer.
    const evidence = countEvaluationEvidence([
      { kind: "finding", findingClass: "error", message: "one real defect" },
      { kind: "report", findingClass: "vendored", message: "linter a exited 1" },
      { kind: "report", findingClass: "vendored", message: "linter b exited 1" },
    ]);

    expect(evidence.enumeratedFindings).toBe(1);
    expect(evidence.reports).toBe(2);
    expect(evidence.defectCountMeasurable).toBe(false);
  });

  // Case 6 — a report flagging a case without fabricating a defect — lives in
  // `packages/aldus-regression/test/metrics.test.ts`, because that is where the case-level
  // comparison it is about actually runs. Named here so the ruling's list stays followable.

  it("7. a record predating the discriminant decodes as an enumerated finding", () => {
    // One direction only. Nothing infers a report from an undiscriminated record: a record written
    // under the old meaning was never claiming to be one.
    const legacy = { findingClass: "error", message: "unsupported claim", locator: "line 42" };

    expect(asEnumeratedFinding(legacy)).toEqual({ ...legacy, kind: "finding" });
    expect(countEvaluationEvidence([asEnumeratedFinding(legacy)])).toEqual({
      enumeratedFindings: 1,
      reports: 0,
      defectCountMeasurable: true,
    });
  });
});
