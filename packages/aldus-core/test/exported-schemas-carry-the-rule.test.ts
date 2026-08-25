import { describe, expect, it } from "vitest";
import type { z } from "zod";

import * as core from "../src/index.js";
import { SCHEMA_VERSION } from "../src/index.js";

/**
 * Every exported schema that reads a `schemaVersion` must refuse a foreign major (#199).
 *
 * **Enumerated, never listed.** A hand-written list needs exactly the attention it exists to
 * remove: a maintainer who forgets to guard a new schema forgets the list entry too, and the suite
 * stays green while the door stands open. Iterating the package index means adding an unguarded
 * schema fails here.
 *
 * The defect this prevents: `checkSchemaVersion` and `assertSchemaVersionReadable` carried the
 * same-major rule and were reached from two call sites, while every schema object is exported and
 * `safeParse` called neither — so `artifactRefSchema.safeParse` accepted a `2.0` record that
 * `assertValidRecord` refused on the same bytes.
 */

/**
 * Schemas that legitimately do not carry the guard, each with a reason.
 *
 * Named and few rather than absent and unbounded. A `*SchemaBase` is the unguarded form the
 * registry and `validateRecord(name, data, supported)` use — that path takes the supported version
 * as a parameter, which a baked-in constant would break, and it is why the bases exist at all.
 */
const EXEMPT: Record<string, string> = {};
const isBase = (name: string): boolean => name.endsWith("SchemaBase");

const foreignMajor = (): string => `${Number(SCHEMA_VERSION.split(".")[0]) + 1}.0`;

/** Exported values that look like a Zod object schema. */
const exportedSchemas = Object.entries(core as Record<string, unknown>)
  .filter(([name]) => name.endsWith("Schema") || name.endsWith("SchemaBase"))
  .filter(([, value]) => typeof (value as z.ZodType | undefined)?.safeParse === "function")
  .map(([name, value]) => [name, value as z.ZodType] as const);

/** …of which the ones that read a `schemaVersion` are the ones the rule applies to. */
const versioned = exportedSchemas.filter(([, schema]) => {
  const shape = (schema as unknown as { shape?: Record<string, unknown> }).shape;
  return shape !== undefined && Object.hasOwn(shape, "schemaVersion");
});

describe("exported schemas carry the same-major rule", () => {
  it("finds schemas to check, so an empty sweep cannot pass silently", () => {
    // A positive control. Without it, a filter that matched nothing would report success.
    expect(exportedSchemas.length).toBeGreaterThan(10);
    expect(versioned.length).toBeGreaterThan(5);
  });

  const guarded = versioned.filter(([name]) => !isBase(name) && EXEMPT[name] === undefined);

  it.each(guarded)("%s refuses a foreign major", (_name, schema) => {
    const probe = { schemaVersion: foreignMajor() };
    const result = schema.safeParse(probe);
    expect(result.success).toBe(false);
    // It must fail *for the version*, not merely because the probe is otherwise incomplete —
    // a fixture failing for its own reason reads as the guard working when it is not.
    const issues = result.success ? [] : result.error.issues;
    expect(issues.some((issue) => issue.path.join(".") === "schemaVersion")).toBe(true);
  });

  it.each(guarded)("%s still accepts this build's own major", (_name, schema) => {
    // Same probe, only the version differs. If this also failed for a version issue, the test
    // above would be measuring an incomplete fixture rather than the guard.
    const result = schema.safeParse({ schemaVersion: SCHEMA_VERSION });
    const issues = result.success ? [] : result.error.issues;
    expect(issues.some((issue) => issue.path.join(".") === "schemaVersion")).toBe(false);
  });

  it("keeps every exemption named with a reason", () => {
    for (const [name, reason] of Object.entries(EXEMPT)) {
      expect(reason.length, `${name} is exempt with no reason`).toBeGreaterThan(20);
    }
  });
});
