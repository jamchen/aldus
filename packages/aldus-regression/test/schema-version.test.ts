import { describe, expect, it } from "vitest";

import {
  compareSchemaVersion,
  parseDefectCorpus,
  parseEvaluatorRun,
  REGRESSION_SCHEMA_VERSION,
} from "../src/index.js";

/**
 * A record must be readable in order to be upgraded, so an older record parses and only a newer
 * one is refused (contract §12.1, ADR-0003).
 *
 * The two guards are exercised separately and deliberately. A newer record carrying an unknown
 * field is refused by strictness before the version check ever runs, so a case combining them
 * would report a pass for a mechanism that never executed — the version check is only tested by a
 * newer record whose shape is otherwise current.
 */
const run = (schemaVersion: string, extra: Record<string, unknown> = {}): unknown => ({
  schemaVersion,
  evaluatorId: "evaluator-a",
  evaluatorVersion: "v1",
  corpusId: "corpus-a",
  outcomes: [],
  executedAt: "2026-01-01T00:00:00.000Z",
  ...extra,
});

const corpus = (schemaVersion: string, extra: Record<string, unknown> = {}): unknown => ({
  schemaVersion,
  corpusId: "corpus-a",
  cases: [],
  ...extra,
});

const codeOf = (thrown: unknown): string =>
  typeof thrown === "object" && thrown !== null && "code" in thrown
    ? String((thrown as { code: unknown }).code)
    : `not an AldusError: ${String(thrown)}`;

const expectCode = (fn: () => unknown, code: string): void => {
  try {
    fn();
    expect.unreachable(`expected ${code}, but the call returned`);
  } catch (thrown) {
    expect(codeOf(thrown)).toBe(code);
  }
};

describe("compareSchemaVersion", () => {
  it("orders by major then minor against the runtime's own version", () => {
    expect(compareSchemaVersion(REGRESSION_SCHEMA_VERSION)).toBe("same");
    expect(compareSchemaVersion("0.1")).toBe("older");
    expect(compareSchemaVersion("9.0")).toBe("newer");
  });

  it("compares minor numerically, not lexically", () => {
    // "1.9" vs "1.10" is the case a string comparison gets backwards.
    const [major, minor] = REGRESSION_SCHEMA_VERSION.split(".").map(Number) as [number, number];
    expect(compareSchemaVersion(`${major}.${minor + 1}`)).toBe("newer");
    expect(compareSchemaVersion(`${major}.${minor - 1}`)).toBe("older");
  });

  it("refuses a version that is not MAJOR.MINOR, naming the path and not the value", () => {
    try {
      compareSchemaVersion("banana");
      expect.unreachable("expected a refusal");
    } catch (thrown) {
      expect(codeOf(thrown)).toBe("ALDUS_CORPUS_MALFORMED");
      expect(JSON.stringify(thrown)).not.toContain("banana");
    }
  });
});

describe("a record newer than this runtime", () => {
  it("is refused by parseEvaluatorRun", () => {
    expectCode(() => parseEvaluatorRun(run("9.0")), "ALDUS_SCHEMA_VERSION_UNSUPPORTED");
  });

  it("is refused by parseDefectCorpus, which holds the labelled cases every metric uses", () => {
    expectCode(() => parseDefectCorpus(corpus("9.0")), "ALDUS_SCHEMA_VERSION_UNSUPPORTED");
  });

  it("does not name the received version in the error", () => {
    try {
      parseEvaluatorRun(run("9.0"));
      expect.unreachable("expected a refusal");
    } catch (thrown) {
      expect(JSON.stringify(thrown)).not.toContain("9.0");
      expect(JSON.stringify(thrown)).toContain(REGRESSION_SCHEMA_VERSION);
    }
  });
});

describe("a record older than this runtime", () => {
  it("still parses, because a record must be readable to be upgraded", () => {
    expect(() => parseEvaluatorRun(run("1.0"))).not.toThrow();
    expect(() => parseDefectCorpus(corpus("1.0"))).not.toThrow();
  });

  it("is left to the caller to judge, via the exported comparison", () => {
    expect(compareSchemaVersion("1.0")).toBe("older");
  });
});

describe("an undeclared newer shape", () => {
  it("is refused rather than silently stripped, on a run", () => {
    expectCode(
      () => parseEvaluatorRun(run(REGRESSION_SCHEMA_VERSION, { futureField: "x" })),
      "ALDUS_CORPUS_MALFORMED",
    );
  });

  it("is refused rather than silently stripped, on a corpus", () => {
    expectCode(
      () => parseDefectCorpus(corpus(REGRESSION_SCHEMA_VERSION, { futureField: "x" })),
      "ALDUS_CORPUS_MALFORMED",
    );
  });

  it("is a separate guard from the version check, and each fires on its own", () => {
    // Same shape, different version: only the version guard can explain the difference.
    expectCode(() => parseEvaluatorRun(run("9.0")), "ALDUS_SCHEMA_VERSION_UNSUPPORTED");
    expect(() => parseEvaluatorRun(run(REGRESSION_SCHEMA_VERSION))).not.toThrow();
  });
});

describe("adopter-owned metadata", () => {
  it("is preserved through the parse rather than stripped", () => {
    const parsed = parseDefectCorpus(
      corpus(REGRESSION_SCHEMA_VERSION, { metadata: { labelProvenance: { source: "review-a" } } }),
    ) as { metadata?: Record<string, unknown> };
    // The sibling-key arrangement this replaces survived only because readers went around the
    // parser to the raw JSON. A declared field is readable through it.
    expect(parsed.metadata).toEqual({ labelProvenance: { source: "review-a" } });
  });

  it("is available on a run too", () => {
    const parsed = parseEvaluatorRun(
      run(REGRESSION_SCHEMA_VERSION, { metadata: { harness: "local" } }),
    ) as { metadata?: Record<string, unknown> };
    expect(parsed.metadata).toEqual({ harness: "local" });
  });

  it("does not reopen the door strictness closed", () => {
    // An undeclared sibling is still refused — the point is that the two cases are separated,
    // not that strictness was relaxed.
    expectCode(
      () => parseDefectCorpus(corpus(REGRESSION_SCHEMA_VERSION, { labelProvenance: {} })),
      "ALDUS_CORPUS_MALFORMED",
    );
  });

  it("is optional, so no existing record needs it", () => {
    expect(() => parseDefectCorpus(corpus(REGRESSION_SCHEMA_VERSION))).not.toThrow();
  });
});
