/**
 * JSON Schema projection (ADR-0002).
 *
 * These tests are what make the committed `schema/*.json` files trustworthy: they prove the
 * files are current, that a non-TypeScript validator can actually compile and run them, and
 * that the places where the projection is weaker than the Zod schema are exactly the places
 * ADR-0002 says they are — no more.
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import ajv2020Import from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";
import { describe, expect, it } from "vitest";

import {
  SCHEMAS_WITH_UNEXPRESSIBLE_CONSTRAINTS,
  SCHEMA_FILE_NAMES,
  allJsonSchemas,
  schemaId,
  serializeJsonSchema,
  toJsonSchema,
} from "../src/json-schema.js";
import { coreSchemas, listSchemaNames, type SchemaName } from "../src/schema/index.js";
import { SCHEMA_VERSION } from "../src/schema-version.js";

// Both ajv entry points are CommonJS, so the ESM default-export shape differs between the
// type declarations and the runtime value. Normalise through `unknown` at the single point of
// entry rather than scattering casts through the assertions below.
type AjvLike = {
  compile: (schema: unknown) => ((data: unknown) => boolean) & { errors?: unknown };
};
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

const schemaDir = join(dirname(fileURLToPath(import.meta.url)), "..", "schema");
const names = listSchemaNames();
const documents = allJsonSchemas();

function compile(name: SchemaName) {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  return ajv.compile(documents[name]);
}

/** Walk every nested schema node, including `$defs` and array `items`. */
function walk(node: unknown, visit: (node: Record<string, unknown>) => void): void {
  if (Array.isArray(node)) {
    for (const entry of node) walk(entry, visit);
    return;
  }
  if (typeof node !== "object" || node === null) return;
  visit(node as Record<string, unknown>);
  for (const value of Object.values(node)) walk(value, visit);
}

const HASH = "a".repeat(64);
const AT = "2026-08-18T10:00:00Z";

const episode = {
  schemaVersion: SCHEMA_VERSION,
  episodeId: "show:example-show:episode:first-light",
  showId: "example-show",
};

describe("projection shape", () => {
  it("emits one document per registered schema", () => {
    expect(Object.keys(documents).sort()).toEqual([...names].sort());
    expect(Object.keys(SCHEMA_FILE_NAMES).sort()).toEqual([...names].sort());
  });

  it("gives every document the 2020-12 dialect and a canonical $id", () => {
    for (const name of names) {
      expect(documents[name].$schema).toBe("https://json-schema.org/draft/2020-12/schema");
      expect(documents[name].$id).toBe(`urn:aldus:schema:${SCHEMA_VERSION}:${name}`);
      expect(schemaId(name)).toBe(documents[name].$id);
    }
  });

  it("never emits additionalProperties: false, at any depth", () => {
    // ADR-0003: a non-TypeScript reader must ignore unknown properties, not reject them, or a
    // record written by a newer minor version becomes unreadable.
    for (const name of names) {
      walk(documents[name], (node) => {
        expect(node.additionalProperties, `${name} must not close its object nodes`).not.toBe(
          false,
        );
      });
    }
  });

  it("preserves a constraining additionalProperties schema", () => {
    // The override removes only the literal `false`; a record type legitimately constrains its
    // values through this keyword and that must survive.
    const properties = documents.KnowledgePackRef.properties as Record<
      string,
      Record<string, unknown> | undefined
    >;
    const scope = properties.scope;
    expect(scope).toBeDefined();
    expect(scope?.type).toBe("object");
    expect(scope?.additionalProperties).toMatchObject({ type: "string" });
  });

  it("is self-contained — no cross-document references", () => {
    for (const name of names) {
      walk(documents[name], (node) => {
        if (typeof node.$ref === "string") {
          expect(node.$ref.startsWith("#"), `${name} leaks a cross-file $ref: ${node.$ref}`).toBe(
            true,
          );
        }
      });
    }
  });

  it("documents every schema for non-TypeScript consumers", () => {
    for (const name of names) {
      expect(documents[name].title).toBe(name);
      expect(String(documents[name].description ?? "")).toContain("§");
    }
  });
});

describe("Ajv conformance", () => {
  it("compiles every document under strict mode", () => {
    for (const name of names) expect(() => compile(name)).not.toThrow();
  });

  it("accepts a valid record", () => {
    expect(compile("EpisodeRef")(episode)).toBe(true);
  });

  it("accepts a forward-compatible record carrying unknown properties", () => {
    expect(compile("EpisodeRef")({ ...episode, schemaVersion: "1.9", futureField: 1 })).toBe(true);
  });

  it("rejects the same violations Zod rejects", () => {
    const validateArtifact = compile("ArtifactRef");
    const artifact = {
      schemaVersion: SCHEMA_VERSION,
      artifactId: "art_1",
      kind: "AudioTake",
      uri: "file:///take.wav",
      sha256: HASH,
      mediaType: "audio/wav",
      producerRunId: "run_1",
      producerStageId: "synthesize",
      inputHashes: [],
      reconstructability: "irreplaceable",
      createdAt: AT,
    };
    expect(validateArtifact(artifact)).toBe(true);
    expect(coreSchemas.ArtifactRef.safeParse(artifact).success).toBe(true);

    for (const invalid of [
      { ...artifact, sha256: "A".repeat(64) },
      { ...artifact, sizeBytes: -1 },
      { ...artifact, reconstructability: "maybe" },
      { ...artifact, createdAt: "2026-08-18T10:00:00" },
    ]) {
      expect(validateArtifact(invalid), JSON.stringify(invalid.sha256)).toBe(false);
      expect(coreSchemas.ArtifactRef.safeParse(invalid).success).toBe(false);
    }
  });
});

describe("known projection gaps (ADR-0002)", () => {
  it("lists exactly the schemas carrying an unexpressible constraint", () => {
    expect(Object.keys(SCHEMAS_WITH_UNEXPRESSIBLE_CONSTRAINTS).sort()).toEqual([
      "CostRecord",
      "StageExecution",
    ]);
  });

  it("documents each gap in the emitted description", () => {
    for (const name of Object.keys(SCHEMAS_WITH_UNEXPRESSIBLE_CONSTRAINTS) as SchemaName[]) {
      expect(String(documents[name].description)).toContain("NOT EXPRESSIBLE IN JSON SCHEMA");
    }
  });

  it("confirms the gap is real: Ajv accepts a CostRecord that Zod rejects", () => {
    // Not a defect — a documented consequence. The test exists so the gap cannot widen or move
    // without someone noticing.
    const record = {
      schemaVersion: SCHEMA_VERSION,
      costId: "cost_1",
      runId: "run_1",
      provider: "provider-a",
      operation: "synthesize",
      billingStatus: "unknown",
      recordedAt: AT,
    };
    expect(compile("CostRecord")(record)).toBe(true);
    expect(coreSchemas.CostRecord.safeParse(record).success).toBe(false);
  });

  it("confirms the gap is real: Ajv accepts out-of-order attempts that Zod rejects", () => {
    const attempt = {
      attemptId: "att_1",
      stageId: "s",
      attempt: 2,
      status: "succeeded",
      actor: { kind: "human", id: "operator-1" },
      inputArtifacts: [],
      outputArtifacts: [],
    };
    const execution = {
      schemaVersion: SCHEMA_VERSION,
      runId: "run_1",
      stageId: "s",
      status: "succeeded",
      attempts: [attempt, { ...attempt, attemptId: "att_2", attempt: 1 }],
    };
    expect(compile("StageExecution")(execution)).toBe(true);
    expect(coreSchemas.StageExecution.safeParse(execution).success).toBe(false);
  });
});

describe("committed artifacts", () => {
  it("match regeneration from source", async () => {
    // The generator script runs against dist/; this test runs against src/, so a stale build
    // cannot hide drift.
    for (const name of names) {
      const committed = await readFile(join(schemaDir, SCHEMA_FILE_NAMES[name]), "utf8");
      expect(committed, `${SCHEMA_FILE_NAMES[name]} is out of date`).toBe(
        serializeJsonSchema(toJsonSchema(name)),
      );
    }
  });

  it("serialises deterministically", () => {
    for (const name of names) {
      expect(serializeJsonSchema(toJsonSchema(name))).toBe(serializeJsonSchema(toJsonSchema(name)));
      expect(serializeJsonSchema(toJsonSchema(name)).endsWith("\n")).toBe(true);
    }
  });
});
