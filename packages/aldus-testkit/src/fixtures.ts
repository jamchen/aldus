/**
 * The Aldus Core fixture corpus.
 *
 * Fixtures are JSON files on disk, not inline literals. Two consumers depend on that: a
 * non-TypeScript validator checking the published JSON Schema (ADR-0002), and a future schema
 * migration that must prove it can still read records written today (ADR-0003). Neither can see
 * an object literal buried in a test file.
 *
 * ## The corpus is frozen
 *
 * Every fixture is pinned at `schemaVersion` `"1.0"`. They are **not** edited to make a failing
 * test pass — a fixture that stops validating means either the schema changed compatibly (and
 * the fixture should still pass, so investigate) or it changed breakingly (which is a MAJOR bump
 * under ADR-0003, and the corpus is revisited deliberately as part of that decision).
 *
 * ## `jsonSchemaDetectable`
 *
 * Each invalid fixture declares whether a generic JSON Schema validator can also detect its
 * defect. `false` marks a cross-field refinement that JSON Schema cannot express, so the
 * generated schema is knowably weaker than the normative Zod schema there (ADR-0002). The flag
 * lives in the manifest rather than inside the fixture record, because it is metadata *about*
 * the fixture — putting it in the payload would make the payload not quite the record under
 * test.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { SchemaName } from "@aldus-runtime/core";

/**
 * Absolute path to the fixture directory.
 *
 * Resolves correctly from both `src/` under vitest and `dist/` after a build, because both sit
 * one level below the package root.
 */
export const FIXTURE_DIR: string = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

/** A fixture expected to validate. */
export interface ValidFixtureEntry {
  /** Core schema the fixture is an instance of. */
  schema: SchemaName;
  /** Case name, e.g. `minimal` or `full`. */
  case: string;
  /** Path relative to {@link FIXTURE_DIR}. */
  file: string;
  /** What this fixture demonstrates. */
  description: string;
}

/** A fixture expected to fail validation, with the defect it demonstrates. */
export interface InvalidFixtureEntry extends ValidFixtureEntry {
  /** Field path the failure is expected at, e.g. `estimated.amount`. */
  expectedPath: string;
  /**
   * Whether a generic JSON Schema validator also rejects this fixture.
   *
   * `false` means the defect is a Zod refinement JSON Schema cannot express (ADR-0002). The
   * conformance test asserts this in **both** directions, so the flag stays an exact statement
   * about the projection rather than a one-sided allowance.
   */
  jsonSchemaDetectable: boolean;
}

/** The fixture manifest (`fixtures/manifest.json`). */
export interface FixtureManifest {
  /**
   * Oldest schema version represented in the corpus.
   *
   * Not "the version every fixture carries": a fixture carries the version of the release that
   * introduced its type, so the corpus is deliberately mixed. What every fixture must satisfy
   * is that it stays *readable* by the current build (ADR-0003 same-major rule).
   */
  baselineSchemaVersion: string;
  /** Why the corpus is frozen and what `jsonSchemaDetectable` means. */
  note: string;
  /** Fixtures expected to validate. */
  valid: ValidFixtureEntry[];
  /** Fixtures expected to fail, each with its expected failing path. */
  invalid: InvalidFixtureEntry[];
}

/** A loaded fixture: its manifest entry plus the parsed record. */
export interface LoadedFixture<E extends ValidFixtureEntry = ValidFixtureEntry> {
  /** The manifest entry describing this fixture. */
  entry: E;
  /**
   * The parsed JSON record, deliberately typed `unknown`.
   *
   * A fixture is input to a validator; typing it as its schema's type would assume the very
   * thing the test exists to prove, and would make the invalid fixtures unrepresentable.
   */
  record: unknown;
}

/**
 * Read and parse the fixture manifest.
 *
 * Loading is synchronous throughout this module. Fixtures are small, local, and read during test
 * collection, where an async loader would force every consumer into `beforeAll` for no benefit.
 */
export function loadManifest(): FixtureManifest {
  const raw = readFileSync(join(FIXTURE_DIR, "manifest.json"), "utf8");
  return JSON.parse(raw) as FixtureManifest;
}

/** Read one fixture record by its manifest-relative path. */
export function loadFixtureFile(file: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, file), "utf8")) as unknown;
}

/** Load every fixture expected to validate. */
export function loadValidFixtures(): LoadedFixture<ValidFixtureEntry>[] {
  return loadManifest().valid.map((entry) => ({ entry, record: loadFixtureFile(entry.file) }));
}

/** Load every fixture expected to fail validation. */
export function loadInvalidFixtures(): LoadedFixture<InvalidFixtureEntry>[] {
  return loadManifest().invalid.map((entry) => ({ entry, record: loadFixtureFile(entry.file) }));
}

/**
 * Load one fixture by its identifier, e.g. `"ArtifactRef.minimal"`.
 *
 * @throws {Error} if no fixture with that identifier is listed in the manifest.
 */
export function loadFixture(id: string): LoadedFixture {
  const manifest = loadManifest();
  const entry =
    manifest.valid.find((candidate) => fixtureId(candidate) === id) ??
    manifest.invalid.find((candidate) => fixtureId(candidate) === id);
  if (entry === undefined) {
    throw new Error(`No fixture named "${id}" is listed in the manifest.`);
  }
  return { entry, record: loadFixtureFile(entry.file) };
}

/** The identifier of a fixture, `<SchemaName>.<case>`. Matches its filename stem. */
export function fixtureId(entry: ValidFixtureEntry): string {
  return `${entry.schema}.${entry.case}`;
}
