/**
 * Zod ↔ Ajv conformance over the fixture corpus (ADR-0002).
 *
 * Core's own `json-schema.test.ts` checks the *structure* of the generated documents. This
 * checks their *behaviour*: that a real, generic JSON Schema validator reaches the same verdict
 * as the normative Zod schema on every fixture, or differs only where the manifest says it will.
 *
 * That declaration is asserted in **both** directions. If Ajv rejects a fixture marked
 * `jsonSchemaDetectable: false`, that is a failure too — otherwise the flag decays from "here is
 * exactly where the projection is weaker" into "here is somewhere it might be", which is not a
 * statement anyone can rely on.
 *
 * The schemas loaded here are the **committed files** in `packages/aldus-core/schema/`, not
 * freshly generated ones. A non-TypeScript consumer gets those bytes, so those bytes are what
 * must be tested.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { SCHEMA_FILE_NAMES, listSchemaNames, validate, type SchemaName } from "@aldus-runtime/core";
import ajv2020Import from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";
import { describe, expect, it } from "vitest";

import { fixtureId, loadInvalidFixtures, loadValidFixtures } from "../src/fixtures.js";

/* -------------------------------------------------------------------------------------------
 * Ajv interop
 * ---------------------------------------------------------------------------------------- */

// Both ajv entry points are CommonJS, so the ESM default-export shape differs between the type
// declarations and the runtime value. Normalise once, here, rather than casting at each use.
type AjvValidator = ((data: unknown) => boolean) & { errors?: unknown };
type AjvLike = { compile: (schema: unknown) => AjvValidator };
type AjvConstructor = new (options: { strict: boolean; allErrors: boolean }) => AjvLike;

function interopDefault<T>(value: unknown): T {
  return (
    typeof value === "object" && value !== null && "default" in value
      ? (value as { default: unknown }).default
      : value
  ) as T;
}

const Ajv2020 = interopDefault<AjvConstructor>(ajv2020Import);
const addFormats = interopDefault<(ajv: AjvLike) => void>(addFormatsImport);

/* -------------------------------------------------------------------------------------------
 * Load the committed schema documents
 * ---------------------------------------------------------------------------------------- */

const coreSchemaDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "aldus-core",
  "schema",
);

const schemaNames = listSchemaNames();

const validators = new Map<SchemaName, AjvValidator>();
for (const name of schemaNames) {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  const document: unknown = JSON.parse(
    readFileSync(join(coreSchemaDir, SCHEMA_FILE_NAMES[name]), "utf8"),
  );
  validators.set(name, ajv.compile(document));
}

function ajvAccepts(name: SchemaName, record: unknown): boolean {
  const validator = validators.get(name);
  if (validator === undefined) throw new Error(`No compiled validator for ${name}.`);
  return validator(record);
}

const validFixtures = loadValidFixtures();
const invalidFixtures = loadInvalidFixtures();

/* -------------------------------------------------------------------------------------------
 * Tests
 * ---------------------------------------------------------------------------------------- */

describe("committed schema documents", () => {
  it.each(schemaNames)("%s compiles under Ajv 2020 in strict mode", (name) => {
    expect(validators.get(name)).toBeTypeOf("function");
  });

  it("compiles one document per registered schema", () => {
    expect(validators.size).toBe(schemaNames.length);
  });
});

describe("valid fixtures", () => {
  it.each(validFixtures.map((fixture) => [fixtureId(fixture.entry), fixture] as const))(
    "%s is accepted by both Zod and Ajv",
    (id, fixture) => {
      expect(validate(fixture.entry.schema, fixture.record).ok, `${id}: Zod rejected it`).toBe(
        true,
      );
      expect(ajvAccepts(fixture.entry.schema, fixture.record), `${id}: Ajv rejected it`).toBe(true);
    },
  );
});

describe("invalid fixtures", () => {
  it.each(invalidFixtures.map((fixture) => [fixtureId(fixture.entry), fixture] as const))(
    "%s is rejected by Zod, the normative validator",
    (id, fixture) => {
      expect(validate(fixture.entry.schema, fixture.record).ok, `${id}: Zod accepted it`).toBe(
        false,
      );
    },
  );

  it.each(invalidFixtures.map((fixture) => [fixtureId(fixture.entry), fixture] as const))(
    "%s matches its declared jsonSchemaDetectable exactly",
    (id, fixture) => {
      const accepted = ajvAccepts(fixture.entry.schema, fixture.record);
      const detectable = fixture.entry.jsonSchemaDetectable;
      expect(
        !accepted,
        detectable
          ? `${id} declares jsonSchemaDetectable: true, but Ajv accepted it — the generated ` +
              "schema is weaker than the manifest claims."
          : `${id} declares jsonSchemaDetectable: false, but Ajv rejected it — the generated ` +
              "schema is stronger than the manifest claims, so the declaration is stale.",
      ).toBe(detectable);
    },
  );
});

describe("the declared gaps", () => {
  // ADR-0002 names exactly two constraints JSON Schema cannot express. If a third appears, it
  // must be a deliberate, reviewed decision — not something that arrived with a schema edit.
  it("has exactly two undetectable defects, on the two documented constraints", () => {
    const undetectable = invalidFixtures
      .filter((fixture) => !fixture.entry.jsonSchemaDetectable)
      .map((fixture) => fixtureId(fixture.entry))
      .sort();
    expect(undetectable).toEqual([
      "CostRecord.no-amounts",
      "StageExecution.non-ascending-attempts",
    ]);
  });

  it("restates each undetectable constraint in the schema description", () => {
    for (const name of ["CostRecord", "StageExecution"] as const) {
      const document = JSON.parse(
        readFileSync(join(coreSchemaDir, SCHEMA_FILE_NAMES[name]), "utf8"),
      ) as { description?: string };
      // A consumer using the JSON Schema alone gets no validation for these, so the prose is
      // the only warning they receive.
      expect(document.description).toContain("NOT EXPRESSIBLE IN JSON SCHEMA");
    }
  });
});

describe("forward compatibility across validators", () => {
  // Both validators must ignore unknown properties. If Ajv rejected them, a non-TypeScript
  // reader would refuse records a TypeScript reader accepts — ADR-0003's rule would hold only
  // inside this language.
  it.each(validFixtures.map((fixture) => [fixtureId(fixture.entry), fixture] as const))(
    "%s still passes both validators with an unknown property added",
    (id, fixture) => {
      const extended = {
        ...(fixture.record as Record<string, unknown>),
        fieldFromAFutureMinorVersion: "value",
      };
      expect(validate(fixture.entry.schema, extended).ok, `${id}: Zod rejected it`).toBe(true);
      expect(ajvAccepts(fixture.entry.schema, extended), `${id}: Ajv rejected it`).toBe(true);
    },
  );
});
