/**
 * The rule an exported schema carries.
 *
 * `checkSchemaVersion` and `assertSchemaVersionReadable` had the same-major rule and were reached
 * from two call sites — `validate.ts` and the artifact store. Every versioned schema object is also
 * exported from the package index, and `safeParse` called neither. So `artifactRefSchema.safeParse`
 * accepted a `2.0` record this build cannot interpret while `assertValidRecord` on the same bytes
 * refused it, and which guarantee a caller got depended on which door they came through.
 *
 * A rule enforced at one entry point and not the other is not a rule; it is a rule plus a bypass,
 * and the bypass was on the public surface of a published package (#199).
 *
 * One combinator rather than a refinement per schema: twenty-two hand-written guards are
 * twenty-two chances to write it slightly differently, and the differences would be invisible.
 */
import type { z } from "zod";

import { SCHEMA_VERSION } from "../schema-version.js";

/** The major component. Local, so this file pulls in no cycle through the schema barrel. */
function majorOf(value: string): string {
  return value.split(".")[0] ?? "";
}

/**
 * Refuse a record whose `schemaVersion` has a different major than this build implements.
 *
 * A newer **minor** still passes, deliberately: refusing one would make every additive schema
 * change breaking for older readers, which is the case ADR-0003 exists to support.
 * `assertValidRecord` reports such a record as `compatibility: "forward"`.
 *
 * `.extend()` preserves `ZodObject`, so `.shape`, `.extend` and `.pick` survive and an adopter
 * composing with these schemas loses nothing.
 *
 * **This hard-codes `SCHEMA_VERSION`, and that is why it wraps the exported schema rather than the
 * shared `schemaVersionString` field.** `validateRecord(name, data, supported)` takes the supported
 * version as a parameter — reading records written for a different build is a supported case — and
 * a field-level refinement has no context, so it could only bake this constant into the one place
 * the API deliberately made variable. The unwrapped `*SchemaBase` exports exist for that path.
 */
export function withForeignMajorRefused<T extends z.ZodObject>(base: T): T {
  const field = (base.shape as Record<string, z.ZodType>)["schemaVersion"];
  if (field === undefined) return base;
  // Refined on the **field**, not on the object. An object-level check does not run when the shape
  // has already failed, so a record missing an unrelated field would slip past the version rule and
  // — worse — a test probing the guard with an incomplete fixture would see it "fail" for the wrong
  // reason and report the guard as working. Per-field validation always reports the version issue.
  return base.safeExtend({
    schemaVersion: field.refine(
      (value) => typeof value !== "string" || majorOf(value) === majorOf(SCHEMA_VERSION),
      {
        // The message names this build's own constant, never the received value (§19.2).
        message: `Schema version major must be ${majorOf(SCHEMA_VERSION)}, which is what this build implements.`,
      },
    ),
  }) as unknown as T;
}
