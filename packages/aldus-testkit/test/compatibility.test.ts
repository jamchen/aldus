/**
 * Schema compatibility (ADR-0003).
 *
 * This is the WP-01 deliverable "schema compatibility tests". It checks the policy holds in
 * both directions that matter in practice: an old record read by this build, and a record from
 * a newer build read by this one. Architecture contract §5.1 notes long pauses between stages
 * are normal, so both are routine rather than hypothetical.
 *
 * The corpus is pinned at `"1.0"` and frozen. If a test here fails after a schema change, the
 * question is whether the change was actually compatible — not whether the fixture should be
 * edited.
 */

import {
  formatSchemaVersion,
  compareSchemaVersions,
  parseSchemaVersion,
  SCHEMA_VERSION,
  VERSIONED_SCHEMA_NAMES,
  checkSchemaVersion,
  isVersionedSchemaName,
  listSchemaNames,
  validate,
  validateRecord,
  type SchemaName,
  type VersionedSchemaName,
} from "@aldus-runtime/core";
import { describe, expect, it } from "vitest";

import { fixtureId, loadValidFixtures } from "../src/fixtures.js";

/**
 * One minor version above the current one.
 *
 * Derived rather than written. This was the literal `"1.9"`, which was newer until the release
 * that made it current — at which point a forward-compatibility test was asserting forwardness
 * against the version in the tree. A version literal in a version test goes stale on exactly the
 * change it exists to cover (ADR-0031).
 */
function nextMinor(version: string): string {
  const [major, minor] = version.split(".").map(Number) as [number, number];
  return `${major}.${minor + 1}`;
}

const validFixtures = loadValidFixtures();
const versionedFixtures = validFixtures.filter((fixture) =>
  isVersionedSchemaName(fixture.entry.schema),
);

/** Re-stamp a fixture record with a different schema version. */
function withVersion(record: unknown, version: string): unknown {
  return { ...(record as Record<string, unknown>), schemaVersion: version };
}

describe("the frozen corpus", () => {
  // Every fixture is pinned at the version of the release that introduced its type, and is
  // never restamped. The WP-01 corpus staying at 1.0 while SCHEMA_VERSION advances is the whole
  // point: it is what keeps proving ADR-0003's same-major rule instead of merely asserting it.
  const INTRODUCED_AT: Partial<Record<string, string>> = {
    AldusEvent: "1.1",
    KnowledgePackManifest: "1.2",
  };
  const WP01_BASELINE = "1.0";

  it("pins each fixture at the version that introduced its type", () => {
    for (const fixture of versionedFixtures) {
      const declared = (fixture.record as { schemaVersion?: unknown }).schemaVersion;
      const expected = INTRODUCED_AT[fixture.entry.schema] ?? WP01_BASELINE;
      expect(declared, `${fixtureId(fixture.entry)} is not pinned`).toBe(expected);
    }
  });

  // The oldest fixtures being two minor versions behind is not a coincidence to preserve by
  // luck: it is what lets this corpus prove ADR-0003's same-major rule across more than one
  // step. Asserted rather than left implicit, so "let's refresh the fixtures" fails here with
  // the reason attached instead of quietly reducing the suite to a single-version check.
  it("spans at least two minor versions below the current one", () => {
    const oldest = versionedFixtures
      .map((fixture) => (fixture.record as { schemaVersion?: unknown }).schemaVersion)
      .filter((version): version is string => typeof version === "string")
      .map(parseSchemaVersion)
      .reduce((a, b) => (compareSchemaVersions(a, b) <= 0 ? a : b));
    const current = parseSchemaVersion(SCHEMA_VERSION);

    expect(oldest.major, "a fixture from another major would not be readable at all").toBe(
      current.major,
    );
    expect(
      current.minor - oldest.minor,
      `oldest fixture is ${formatSchemaVersion(oldest)}, current is ${SCHEMA_VERSION}; ` +
        "the corpus no longer exercises more than one minor step",
    ).toBeGreaterThanOrEqual(2);
  });

  it("still contains fixtures older than the current build", () => {
    // If every fixture ever got restamped to SCHEMA_VERSION, the compatibility suite below
    // would pass vacuously while testing nothing about older records.
    const versions = versionedFixtures.map(
      (fixture) => (fixture.record as { schemaVersion?: unknown }).schemaVersion,
    );
    expect(versions).toContain(WP01_BASELINE);
    expect(WP01_BASELINE).not.toBe(SCHEMA_VERSION);
  });

  it("still validates against the current build", () => {
    for (const fixture of validFixtures) {
      const result = validate(fixture.entry.schema, fixture.record);
      expect(result.ok, `${fixtureId(fixture.entry)} no longer validates`).toBe(true);
    }
  });

  it("reads as compatible, not merely as parseable", () => {
    for (const fixture of versionedFixtures) {
      const name = fixture.entry.schema as VersionedSchemaName;
      const result = validateRecord(name, fixture.record);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.compatibility).toBe("compatible");
    }
  });
});

describe("schemaVersion placement (ADR-0003)", () => {
  // Asserted against the registry AND the corpus, so the policy and the fixtures cannot drift
  // apart. Checking only one of them would let a fixture silently disagree with the rule.
  it("declares exactly nine standalone document types", () => {
    expect([...VERSIONED_SCHEMA_NAMES].sort()).toEqual(
      [
        "ArtifactRef",
        "CostRecord",
        "EpisodeRef",
        "GateDecision",
        "ReleaseReceipt",
        "RunManifest",
        "StageExecution",
        "AldusEvent",
        "KnowledgePackManifest",
      ].sort(),
    );
  });

  it("leaves the four embedded value objects unversioned", () => {
    const embedded = listSchemaNames().filter((name) => !isVersionedSchemaName(name));
    expect(embedded.sort()).toEqual(
      ["ActorRef", "KnowledgePackRef", "StageAttempt", "StructuredError"].sort(),
    );
  });

  it.each(validFixtures.map((fixture) => [fixtureId(fixture.entry), fixture] as const))(
    "%s carries schemaVersion if and only if its type is a standalone document",
    (_id, fixture) => {
      const hasVersion = Object.hasOwn(fixture.record as object, "schemaVersion");
      expect(hasVersion).toBe(isVersionedSchemaName(fixture.entry.schema));
    },
  );

  it("rejects a version on an embedded value object as an unknown property, not an error", () => {
    // Embedded objects have no version field, but adding one must not make them unreadable —
    // that is the same forward-compatibility rule, applied to a field this build does not know.
    const actor = validFixtures.find((fixture) => fixtureId(fixture.entry) === "ActorRef.minimal");
    expect(actor).toBeDefined();
    const stamped = { ...(actor?.record as object), schemaVersion: "1.0" };
    expect(validate("ActorRef", stamped).ok).toBe(true);
  });
});

describe("forward compatibility", () => {
  it("accepts a current record carrying unknown properties", () => {
    for (const fixture of validFixtures) {
      const extended = {
        ...(fixture.record as Record<string, unknown>),
        // A field a future minor version might add. It must be ignored, not rejected: otherwise
        // every additive schema change would break every older reader (ADR-0003).
        fieldFromAFutureMinorVersion: { nested: ["value"] },
      };
      const result = validate(fixture.entry.schema, extended);
      expect(result.ok, `${fixtureId(fixture.entry)} rejected an unknown property`).toBe(true);
    }
  });

  it("classifies a newer minor version as forward and still reads it", () => {
    for (const fixture of versionedFixtures) {
      const name = fixture.entry.schema as VersionedSchemaName;
      const result = validateRecord(name, withVersion(fixture.record, nextMinor(SCHEMA_VERSION)));
      expect(result.ok, `${name} could not read a 1.9 record`).toBe(true);
      if (result.ok) expect(result.compatibility).toBe("forward");
    }
  });

  // #199: a forward read is where a non-strict parse loses something, and until `droppedPaths` the
  // loss was silent even on the enforcing path. Data-driven over the corpus, so the walker is
  // exercised on every record shape that has a nested array of objects rather than on one.
  it("names a drop nested inside a declared array, at its exact path", () => {
    let probed = 0;
    for (const fixture of versionedFixtures) {
      const name = fixture.entry.schema as VersionedSchemaName;
      const record = structuredClone(fixture.record) as Record<string, unknown>;
      const arrayKey = Object.keys(record).find((key) => {
        const value = record[key];
        return (
          Array.isArray(value) &&
          value.length > 0 &&
          typeof value[0] === "object" &&
          value[0] !== null
        );
      });
      if (arrayKey === undefined) continue;
      probed += 1;
      const first = (record[arrayKey] as Record<string, unknown>[])[0]!;
      first["fieldFromAFutureMinorVersion"] = "value-this-build-cannot-interpret";
      const result = validateRecord(name, withVersion(record, nextMinor(SCHEMA_VERSION)));
      expect(result.ok, `${name} could not read the record`).toBe(true);
      if (!result.ok) continue;
      expect(result.droppedPaths).toContain(`${arrayKey}[0].fieldFromAFutureMinorVersion`);
      expect(JSON.stringify(result.droppedPaths)).not.toContain("value-this-build");
    }
    // A positive control: a corpus with no such shape would have asserted nothing.
    expect(probed).toBeGreaterThan(0);
  });

  it("classifies an older minor version as compatible", () => {
    expect(checkSchemaVersion("1.0", "1.7")).toBe("compatible");
    expect(checkSchemaVersion("1.7", "1.7")).toBe("compatible");
    expect(checkSchemaVersion("1.8", "1.7")).toBe("forward");
  });
});

describe("major version incompatibility", () => {
  it("refuses a differing major with ALDUS_SCHEMA_VERSION_UNSUPPORTED", () => {
    for (const fixture of versionedFixtures) {
      const name = fixture.entry.schema as VersionedSchemaName;
      const result = validateRecord(name, withVersion(fixture.record, "2.0"));
      expect(result.ok, `${name} accepted a major-2 record`).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("ALDUS_SCHEMA_VERSION_UNSUPPORTED");
        expect(result.error.retryable).toBe(false);
        expect(result.error.details).toMatchObject({ actual: "2.0", supported: SCHEMA_VERSION });
      }
    }
  });

  it("refuses an older major too — incompatibility is not only about the future", () => {
    const fixture = versionedFixtures[0];
    expect(fixture).toBeDefined();
    if (fixture === undefined) return;
    const result = validateRecord(
      fixture.entry.schema as VersionedSchemaName,
      withVersion(fixture.record, "0.9"),
    );
    expect(result.ok).toBe(false);
  });

  // The version error must arrive instead of a pile of field errors: a reader that sees twelve
  // "unrecognised field" issues learns the symptom, not the cause.
  it("reports the version failure alone, not alongside field errors", () => {
    const fixture = versionedFixtures.find(
      (candidate) => fixtureId(candidate.entry) === "RunManifest.full",
    );
    expect(fixture).toBeDefined();
    if (fixture === undefined) return;

    const damaged = {
      ...(fixture.record as Record<string, unknown>),
      schemaVersion: "2.0",
      status: "a-status-that-does-not-exist",
    };
    const result = validateRecord("RunManifest", damaged);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("ALDUS_SCHEMA_VERSION_UNSUPPORTED");
      expect(result.error.details?.issues).toBeUndefined();
    }
  });
});

describe("malformed version strings", () => {
  it.each(["1", "1.0.0", "v1.0", "01.0", "", "one.zero"])(
    "reports %s as a field error, not a version error",
    (version) => {
      const fixture = versionedFixtures[0];
      expect(fixture).toBeDefined();
      if (fixture === undefined) return;

      const result = validateRecord(
        fixture.entry.schema as VersionedSchemaName,
        withVersion(fixture.record, version),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        // A malformed version is a bad field, not an unreadable document: the schema names the
        // field precisely, which is more useful than a vaguer version verdict.
        expect(result.error.code).toBe("ALDUS_SCHEMA_VALIDATION_FAILED");
        const issues = (result.error.details?.issues ?? []) as Array<{ path: string }>;
        expect(issues.map((issue) => issue.path)).toContain("schemaVersion");
      }
    },
  );
});

describe("registry completeness", () => {
  it("registers thirteen core schemas", () => {
    expect(listSchemaNames()).toHaveLength(13);
  });

  it("has a fixture for every registered schema", () => {
    const covered = new Set<SchemaName>(validFixtures.map((fixture) => fixture.entry.schema));
    expect([...covered].sort()).toEqual(listSchemaNames().sort());
  });
});
