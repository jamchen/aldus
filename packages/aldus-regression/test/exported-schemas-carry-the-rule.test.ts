import { describe, expect, it } from "vitest";
import type { z } from "zod";

import * as regression from "../src/index.js";
import { REGRESSION_SCHEMA_VERSION } from "../src/index.js";

/**
 * Every exported schema that reads a `schemaVersion` must refuse a newer record (#199, ADR-0053).
 *
 * `parseDefectCorpus` and `parseEvaluatorRun` refused a newer record while `defectCorpusSchema` and
 * `evaluatorRunSchema` — exported from the same index — accepted the same bytes. Which guarantee a
 * caller got depended on which door they came through, and the exported object is the obvious door.
 *
 * **Enumerated, never listed**, for the reason the core test gives: a hand-written list needs
 * exactly the attention it exists to remove. Iterating the package index means a schema added
 * without the rule fails here.
 *
 * The rule under test is **this package's** rule — any newer version, minor included — not Core's
 * same-major rule. The two are documented side by side in ADR-0053.
 */

/** Schemas that legitimately do not carry the rule, each with a reason. Named and few. */
const EXEMPT: Record<string, string> = {};

const bump = (major: number, minor: number): string => `${major}.${minor}`;
const [MAJOR, MINOR] = REGRESSION_SCHEMA_VERSION.split(".").map(Number) as [number, number];
const NEWER_MINOR = bump(MAJOR, MINOR + 1);
const FOREIGN_MAJOR = bump(MAJOR + 1, 0);
const OLDER = "0.1";

/** Exported values that look like a Zod object schema. */
const exportedSchemas = Object.entries(regression as Record<string, unknown>)
  .filter(([name]) => name.endsWith("Schema"))
  .filter(([, value]) => typeof (value as z.ZodType | undefined)?.safeParse === "function")
  .map(([name, value]) => [name, value as z.ZodType] as const);

/** …of which the ones that read a `schemaVersion` are the ones the rule applies to. */
const versioned = exportedSchemas.filter(([, schema]) => {
  const shape = (schema as unknown as { shape?: Record<string, unknown> }).shape;
  return shape !== undefined && Object.hasOwn(shape, "schemaVersion");
});

const versionIssues = (schema: z.ZodType, schemaVersion: string): string[] => {
  const result = schema.safeParse({ schemaVersion });
  const issues = result.success ? [] : result.error.issues;
  return issues.filter((issue) => issue.path.join(".") === "schemaVersion").map((i) => i.message);
};

describe("exported regression schemas carry the refuse-newer rule", () => {
  it("finds schemas to check, so an empty sweep cannot pass silently", () => {
    // A positive control. Without it a filter matching nothing would report success.
    expect(exportedSchemas.length).toBeGreaterThan(3);
    expect(versioned.map(([name]) => name).sort()).toEqual(
      ["defectCorpusSchema", "evaluatorRunSchema"].sort(),
    );
  });

  const guarded = versioned.filter(([name]) => EXEMPT[name] === undefined);

  it.each(guarded)("%s refuses a newer minor, for the version", (_name, schema) => {
    // It must fail *for the version*, not merely because the probe is otherwise incomplete — a
    // fixture failing for its own reason reads as the guard working when it is not.
    expect(versionIssues(schema, NEWER_MINOR)).toHaveLength(1);
  });

  it.each(guarded)("%s refuses a foreign major, for the version", (_name, schema) => {
    expect(versionIssues(schema, FOREIGN_MAJOR)).toHaveLength(1);
  });

  it.each(guarded)(
    "%s still reads this runtime's own version and an older one",
    (_name, schema) => {
      // Same probe, only the version differs. If these also failed for a version issue, the tests
      // above would be measuring an incomplete fixture rather than the rule.
      expect(versionIssues(schema, REGRESSION_SCHEMA_VERSION)).toEqual([]);
      expect(versionIssues(schema, OLDER)).toEqual([]);
    },
  );

  it.each(guarded)(
    "%s names its own constant in the refusal, never the received value",
    (_name, schema) => {
      const [message] = versionIssues(schema, FOREIGN_MAJOR);
      expect(message).toContain(REGRESSION_SCHEMA_VERSION);
      expect(message).not.toContain(FOREIGN_MAJOR);
    },
  );

  it("keeps every exemption named with a reason", () => {
    for (const [name, reason] of Object.entries(EXEMPT)) {
      expect(reason.length, `${name} is exempt with no reason`).toBeGreaterThan(20);
    }
  });
});
