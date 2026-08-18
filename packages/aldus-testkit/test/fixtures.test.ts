/**
 * The fixture corpus itself.
 *
 * These tests check the corpus is complete and honest: every valid fixture validates, every
 * invalid one fails where it claims to, and the manifest and the directory agree in both
 * directions. That last check is the one that matters most — an orphaned fixture file is a test
 * that silently stopped running, and nothing else in the suite would notice.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";

import {
  SCHEMA_VERSION,
  checkSchemaVersion,
  isVersionedSchemaName,
  listSchemaNames,
  validate,
  type SchemaName,
} from "@aldus-runtime/core";
import { describe, expect, it } from "vitest";

import {
  FIXTURE_DIR,
  fixtureId,
  loadFixture,
  loadInvalidFixtures,
  loadManifest,
  loadValidFixtures,
} from "../src/fixtures.js";

const manifest = loadManifest();
const validFixtures = loadValidFixtures();
const invalidFixtures = loadInvalidFixtures();
const schemaNames = listSchemaNames();

/** Filenames actually present on disk, as manifest-relative paths. */
function filesOnDisk(subdirectory: "valid" | "invalid"): string[] {
  return readdirSync(join(FIXTURE_DIR, subdirectory))
    .filter((name) => name.endsWith(".json"))
    .map((name) => `${subdirectory}/${name}`)
    .sort();
}

describe("manifest integrity", () => {
  // Not equality with SCHEMA_VERSION. The corpus is deliberately mixed: a fixture carries the
  // version of the release that introduced its type, and the WP-01 corpus stays frozen at 1.0
  // precisely so that it keeps proving ADR-0003's same-major rule as the version advances.
  it("has a baseline that is still readable by this build", () => {
    expect(checkSchemaVersion(manifest.baselineSchemaVersion)).not.toBe("incompatible");
  });

  it("stamps every versioned fixture with a version this build can read", () => {
    for (const fixture of loadValidFixtures()) {
      if (!isVersionedSchemaName(fixture.entry.schema)) continue;
      const declared = (fixture.record as { schemaVersion?: unknown }).schemaVersion;
      expect(typeof declared, fixtureId(fixture.entry)).toBe("string");
      expect(
        checkSchemaVersion(declared as string),
        `${fixtureId(fixture.entry)} is not readable by SCHEMA_VERSION ${SCHEMA_VERSION}`,
      ).not.toBe("incompatible");
    }
  });

  // Both directions. A manifest entry without a file fails loudly on load; a file without a
  // manifest entry fails silently by never being exercised, which is the worse failure.
  it("lists exactly the valid fixture files that exist on disk", () => {
    const listed = manifest.valid.map((entry) => entry.file).sort();
    expect(listed).toEqual(filesOnDisk("valid"));
  });

  it("lists exactly the invalid fixture files that exist on disk", () => {
    const listed = manifest.invalid.map((entry) => entry.file).sort();
    expect(listed).toEqual(filesOnDisk("invalid"));
  });

  it("gives every fixture a unique identifier matching its filename", () => {
    const ids = [...manifest.valid, ...manifest.invalid].map(fixtureId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of [...manifest.valid, ...manifest.invalid]) {
      expect(entry.file).toMatch(new RegExp(`/${escapeRegExp(fixtureId(entry))}\\.json$`));
    }
  });

  it("names only registered core schemas", () => {
    for (const entry of [...manifest.valid, ...manifest.invalid]) {
      expect(schemaNames).toContain(entry.schema);
    }
  });

  it("describes every fixture", () => {
    for (const entry of [...manifest.valid, ...manifest.invalid]) {
      expect(entry.description.length, `${fixtureId(entry)} has no description`).toBeGreaterThan(
        20,
      );
    }
  });
});

describe("corpus coverage", () => {
  it.each(schemaNames)("%s has at least one valid fixture", (name) => {
    expect(manifest.valid.some((entry) => entry.schema === name)).toBe(true);
  });

  it.each(schemaNames)("%s has at least one invalid fixture", (name) => {
    expect(manifest.invalid.some((entry) => entry.schema === name)).toBe(true);
  });

  it.each(schemaNames)("%s has both a minimal and a full valid fixture", (name) => {
    const cases = manifest.valid
      .filter((entry) => entry.schema === name)
      .map((entry) => entry.case);
    expect(cases).toContain("minimal");
    expect(cases).toContain("full");
  });
});

describe("valid fixtures", () => {
  it.each(validFixtures.map((fixture) => [fixtureId(fixture.entry), fixture] as const))(
    "%s validates",
    (_id, fixture) => {
      const result = validate(fixture.entry.schema, fixture.record);
      if (!result.ok) {
        throw new Error(
          `${fixtureId(fixture.entry)} failed: ${JSON.stringify(result.error.details, null, 2)}`,
        );
      }
      expect(result.ok).toBe(true);
    },
  );

  // A "minimal" fixture that quietly grew an optional field stops testing the required-field
  // set, which is the only thing it was there to pin down.
  it.each(validFixtures.filter((fixture) => fixture.entry.case === "minimal"))(
    "$entry.schema.minimal carries no optional field beyond the required set",
    (fixture) => {
      const full = validFixtures.find(
        (candidate) =>
          candidate.entry.schema === fixture.entry.schema && candidate.entry.case === "full",
      );
      expect(full).toBeDefined();
      const minimalKeys = Object.keys(fixture.record as object);
      const fullKeys = Object.keys(full?.record as object);
      expect(minimalKeys.length).toBeLessThan(fullKeys.length);
      // Every key in minimal must also be in full: they are the same record type.
      expect(fullKeys).toEqual(expect.arrayContaining(minimalKeys));
    },
  );
});

describe("invalid fixtures", () => {
  it.each(invalidFixtures.map((fixture) => [fixtureId(fixture.entry), fixture] as const))(
    "%s fails validation at its declared path",
    (_id, fixture) => {
      const result = validate(fixture.entry.schema, fixture.record);
      expect(result.ok, `${fixtureId(fixture.entry)} unexpectedly validated`).toBe(false);
      if (result.ok) return;

      const issues = (result.error.details?.issues ?? []) as Array<{ path: string }>;
      const paths = issues.map((issue) => issue.path);
      expect(
        paths,
        `${fixtureId(fixture.entry)} expected a failure at "${fixture.entry.expectedPath}"`,
      ).toContain(fixture.entry.expectedPath);
    },
  );

  it("reports a validation category and refuses retry for every defect", () => {
    for (const fixture of invalidFixtures) {
      const result = validate(fixture.entry.schema, fixture.record);
      if (result.ok) continue;
      expect(result.error.category).toBe("validation");
      expect(result.error.retryable).toBe(false);
    }
  });
});

describe("loadFixture", () => {
  it("finds a valid fixture by identifier", () => {
    const fixture = loadFixture("ArtifactRef.minimal");
    expect(fixture.entry.schema).toBe<SchemaName>("ArtifactRef");
    expect(fixture.entry.case).toBe("minimal");
  });

  it("finds an invalid fixture by identifier", () => {
    const fixture = loadFixture("CostRecord.no-amounts");
    expect(fixture.entry.schema).toBe<SchemaName>("CostRecord");
  });

  it("throws for an unknown identifier rather than returning an empty fixture", () => {
    expect(() => loadFixture("NoSuchSchema.nope")).toThrowError(/No fixture named/);
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
