/**
 * Schema version and compatibility policy.
 *
 * Architecture contract §6.1, §6.2, and §8 each declare `schemaVersion: string` without
 * defining its format or reader semantics; §19.1 requires a schema migration policy.
 * ADR-0003 settles both. This module is the executable form of that ADR.
 *
 * Contract §5.1 notes long pauses between stages are normal, so a manifest written weeks ago
 * by an older build is routinely read by a newer one — and, because `.aldus/` state is
 * Git-friendly, an older build also reads records written by a newer one. Both directions are
 * classified here rather than left to chance.
 */

import { AldusError, CoreErrorCodes } from "./errors.js";

/**
 * The schema version this build writes. `MAJOR.MINOR`, no patch component.
 *
 * One version covers the whole Core schema set; there are no per-entity versions (ADR-0003).
 * MINOR is bumped for backward-compatible additions, MAJOR for anything else.
 *
 * History:
 * - `1.0` — the eleven WP-01 domain types.
 * - `1.1` — adds `AldusEvent` (§6.4). Additive: no existing record's shape changed, so every
 *   `1.0` record stays readable, which is what the same-major rule promises (ADR-0004).
 * - `1.2` — adds `KnowledgePackManifest` (§9.1). Additive for the same reason (ADR-0006).
 * - `1.3` — adds `RunManifest.goalStages` and `RunManifest.cancellation` (§6.2, §19.1).
 *   Additive: both are optional, so every `1.2` record stays readable and reads as `forward`.
 */
export const SCHEMA_VERSION = "1.3";

/** Parsed form of a `MAJOR.MINOR` schema version. */
export interface SchemaVersion {
  major: number;
  minor: number;
}

/** `MAJOR.MINOR`, no leading zeros, no patch, no prefix. */
const SCHEMA_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/**
 * How a record's version relates to what this build understands.
 *
 * `forward` is a **readable** outcome, not an error: unknown properties are ignored rather
 * than rejected (ADR-0002 decision 7). It is surfaced separately from `compatible` so a store
 * may decline to *write back* a record it does not fully understand — a decision that belongs
 * to WP-02, not here.
 */
export type SchemaCompatibility = "compatible" | "forward" | "incompatible";

/** True if `value` is a well-formed `MAJOR.MINOR` schema version string. */
export function isSchemaVersion(value: unknown): value is string {
  return typeof value === "string" && SCHEMA_VERSION_PATTERN.test(value);
}

/**
 * Parse a `MAJOR.MINOR` schema version.
 *
 * @throws {AldusError} `ALDUS_SCHEMA_VERSION_MALFORMED` if the format is wrong. The offending
 * string is included in `details` — a schema version is structural metadata, never a secret.
 */
export function parseSchemaVersion(value: string): SchemaVersion {
  const match = SCHEMA_VERSION_PATTERN.exec(value);
  if (match === null) {
    throw new AldusError(
      CoreErrorCodes.SCHEMA_VERSION_MALFORMED,
      `Schema version must be "MAJOR.MINOR" with no leading zeros; received "${value}".`,
      { category: "validation", details: { received: value } },
    );
  }
  return { major: Number(match[1]), minor: Number(match[2]) };
}

/** Format a parsed version back to its canonical string. */
export function formatSchemaVersion(version: SchemaVersion): string {
  return `${version.major}.${version.minor}`;
}

/** Total order over schema versions: `-1` if `a < b`, `0` if equal, `1` if `a > b`. */
export function compareSchemaVersions(a: SchemaVersion, b: SchemaVersion): -1 | 0 | 1 {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  return 0;
}

/**
 * Classify a record's schema version against what this build supports (ADR-0003).
 *
 * - same major, `actual.minor <= supported.minor` → `compatible`
 * - same major, `actual.minor >  supported.minor` → `forward` (readable; unknown fields ignored)
 * - different major → `incompatible`
 *
 * @throws {AldusError} `ALDUS_SCHEMA_VERSION_MALFORMED` if either argument is malformed.
 */
export function checkSchemaVersion(
  actual: string,
  supported: string = SCHEMA_VERSION,
): SchemaCompatibility {
  const a = parseSchemaVersion(actual);
  const s = parseSchemaVersion(supported);
  if (a.major !== s.major) return "incompatible";
  return a.minor > s.minor ? "forward" : "compatible";
}

/**
 * Assert that a record is readable by this build.
 *
 * `forward` passes: refusing to read a record merely because it carries a newer minor version
 * would make every additive schema change a breaking change for older readers.
 *
 * @throws {AldusError} `ALDUS_SCHEMA_VERSION_UNSUPPORTED` when the major version differs.
 */
export function assertSchemaVersionReadable(
  actual: string,
  supported: string = SCHEMA_VERSION,
): SchemaCompatibility {
  const compatibility = checkSchemaVersion(actual, supported);
  if (compatibility === "incompatible") {
    throw new AldusError(
      CoreErrorCodes.SCHEMA_VERSION_UNSUPPORTED,
      `Schema version "${actual}" is not readable by this build, which supports "${supported}". ` +
        "A differing major version means a field was removed, renamed, narrowed, or changed meaning.",
      {
        category: "validation",
        retryable: false,
        details: { actual, supported },
      },
    );
  }
  return compatibility;
}
