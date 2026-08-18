import { AldusError } from "@aldus/core";
import { describe, expect, it } from "vitest";

import { parseDefectCorpus, parseEvaluatorRun } from "../src/corpus.js";
import { RegressionErrorCodes } from "../src/errors.js";
import { aCase, aCorpus, anOutcome, aRun, LABELLER_A } from "./helpers.js";

describe("defect corpus", () => {
  it("accepts a corpus of labelled cases", () => {
    const corpus = aCorpus([
      aCase({ id: "a", scope: { host: "example-host" }, defective: true, severity: "major" }),
      aCase({ id: "b", scope: { host: "example-host" }, defective: false }),
    ]);
    expect(parseDefectCorpus(corpus).cases).toHaveLength(2);
  });

  // The oracle is a human (contract §12 level 4). A case that records no labeller records no
  // oracle, and §19.2 requires mutating decisions carry actor identity.
  it("rejects a case with no labeller", () => {
    const corpus = aCorpus([aCase({ id: "a", scope: {}, defective: false })]);
    const broken = structuredClone(corpus) as Record<string, unknown>;
    (broken["cases"] as Record<string, unknown>[])[0]!["labelledBy"] = undefined;
    expect(() => parseDefectCorpus(broken)).toThrowError(AldusError);
  });

  it("rejects a defective case that carries no severity", () => {
    const corpus = aCorpus([
      aCase({ id: "a", scope: {}, defective: true, severity: "major" }),
    ]) as unknown as Record<string, unknown>;
    const cases = corpus["cases"] as Record<string, unknown>[];
    delete cases[0]!["severity"];
    try {
      parseDefectCorpus(corpus);
      expect.unreachable("expected a malformed-corpus error");
    } catch (error) {
      expect((error as AldusError).code).toBe(RegressionErrorCodes.CORPUS_MALFORMED);
    }
  });

  // Severity-weighted metrics (§12.1) need a severity on every defect. A clean case carrying one
  // is a labelling mistake that would silently enter the weighted denominator.
  it("rejects a clean case that carries a severity", () => {
    const corpus = aCorpus([aCase({ id: "a", scope: {}, defective: false })]) as unknown as Record<
      string,
      unknown
    >;
    (corpus["cases"] as Record<string, unknown>[])[0]!["severity"] = "major";
    expect(() => parseDefectCorpus(corpus)).toThrowError(AldusError);
  });

  it("rejects a clean case that carries findings", () => {
    const corpus = aCorpus([aCase({ id: "a", scope: {}, defective: false })]) as unknown as Record<
      string,
      unknown
    >;
    (corpus["cases"] as Record<string, unknown>[])[0]!["findings"] = [
      { category: "semantic/unsupported-claim", severity: "major" },
    ];
    expect(() => parseDefectCorpus(corpus)).toThrowError(AldusError);
  });

  it("rejects duplicate case ids", () => {
    const corpus = aCorpus([
      aCase({ id: "a", scope: {}, defective: false }),
      aCase({ id: "a", scope: {}, defective: true, severity: "minor" }),
    ]);
    try {
      parseDefectCorpus(corpus);
      expect.unreachable("expected a duplicate-case error");
    } catch (error) {
      expect((error as AldusError).code).toBe(RegressionErrorCodes.CORPUS_DUPLICATE_CASE);
    }
  });

  // §12.3's taxonomy is introduced with "for example", and §4.2 keeps adopter vocabularies out
  // of the runtime. This test is what stops someone narrowing `category` to a union later.
  it("accepts arbitrary caller-defined categories and severities", () => {
    const corpus = aCorpus([
      aCase({
        id: "a",
        scope: { scriptForm: "form-a", language: "lang-a" },
        defective: true,
        severity: "a-scale-nobody-here-invented",
        category: "an/entirely/adopter/specific/category",
      }),
    ]);
    expect(() => parseDefectCorpus(corpus)).not.toThrow();
  });

  it("does not echo a received value into a validation error", () => {
    const secret = "TOKEN-abc123-DO-NOT-LEAK-9f8e7d6c5b4a3210";
    const corpus = aCorpus([aCase({ id: "a", scope: {}, defective: false })]) as unknown as Record<
      string,
      unknown
    >;
    (corpus["cases"] as Record<string, unknown>[])[0]!["subjectRef"] = { nested: secret };
    try {
      parseDefectCorpus(corpus);
      expect.unreachable("expected a malformed-corpus error");
    } catch (error) {
      // Contract §19.2, ADR-0002: paths and issue codes only, never the received value.
      expect(JSON.stringify((error as AldusError).toStructuredError())).not.toContain(secret);
    }
  });
});

describe("evaluator run", () => {
  it("accepts outcomes", () => {
    expect(parseEvaluatorRun(aRun([anOutcome("a", true)])).outcomes).toHaveLength(1);
  });

  it("rejects two outcomes for the same case", () => {
    try {
      parseEvaluatorRun(aRun([anOutcome("a", true), anOutcome("a", false)]));
      expect.unreachable("expected a duplicate-outcome error");
    } catch (error) {
      expect((error as AldusError).code).toBe(RegressionErrorCodes.OUTCOME_DUPLICATE);
    }
  });

  it("records who laboured over the labels distinctly from who ran the evaluator", () => {
    const corpus = parseDefectCorpus(
      aCorpus([aCase({ id: "a", scope: {}, defective: false, labelledBy: LABELLER_A })]),
    );
    expect(corpus.cases[0]?.labelledBy.kind).toBe("human");
  });
});
