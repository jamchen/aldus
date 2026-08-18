/**
 * JSON Schema projection of the core schemas.
 *
 * ADR-0002: Zod is the single source of truth and JSON Schema is generated, not authored, so
 * the two cannot drift. The generated files are committed so that the contract is readable in
 * the repository and usable by non-TypeScript consumers — architecture contract §18 exposes a
 * CLI and MCP surface, and §21 intends the runtime to be independently open-sourceable.
 *
 * The projection is deliberately *weaker* than the Zod schema wherever a cross-field refinement
 * exists: JSON Schema cannot express "at least one of these two fields". Those constraints are
 * restated in prose in each schema's `description`, and the affected schemas are listed in
 * {@link SCHEMAS_WITH_UNEXPRESSIBLE_CONSTRAINTS}.
 */

import { z } from "zod";

import { AldusError, CoreErrorCodes } from "./errors.js";
import { SCHEMA_VERSION } from "./schema-version.js";
import { coreSchemas, isSchemaName, listSchemaNames, type SchemaName } from "./schema/index.js";

/** A generated JSON Schema document. */
export type JsonSchemaDocument = Record<string, unknown>;

/** JSON Schema dialect the projection targets. */
export const JSON_SCHEMA_TARGET = "draft-2020-12";

/**
 * Filename each schema is written to, relative to the package's `schema/` directory.
 *
 * Declared explicitly rather than derived by a kebab-case function: these are published file
 * paths, and a change to a naming helper should not silently rename a consumer's import.
 */
export const SCHEMA_FILE_NAMES: Readonly<Record<SchemaName, string>> = {
  EpisodeRef: "episode-ref.schema.json",
  RunManifest: "run-manifest.schema.json",
  StageExecution: "stage-execution.schema.json",
  StageAttempt: "stage-attempt.schema.json",
  ArtifactRef: "artifact-ref.schema.json",
  GateDecision: "gate-decision.schema.json",
  CostRecord: "cost-record.schema.json",
  ReleaseReceipt: "release-receipt.schema.json",
  KnowledgePackRef: "knowledge-pack-ref.schema.json",
  ActorRef: "actor-ref.schema.json",
  StructuredError: "structured-error.schema.json",
};

/**
 * Schemas whose Zod definition enforces a constraint the generated JSON Schema cannot.
 *
 * Consumers validating with a generic JSON Schema validator must enforce these themselves. Each
 * constraint is also described in prose in the schema's own `description`.
 */
export const SCHEMAS_WITH_UNEXPRESSIBLE_CONSTRAINTS: Readonly<Partial<Record<SchemaName, string>>> =
  {
    StageExecution: "`attempts` must have strictly ascending `attempt` ordinals (contract §6.3).",
    CostRecord: "At least one of `estimated` or `actual` must be present (contract §19.3).",
  };

/** Canonical `$id` for a schema, e.g. `urn:aldus:schema:1.0:EpisodeRef`. */
export function schemaId(name: SchemaName, version: string = SCHEMA_VERSION): string {
  return `urn:aldus:schema:${version}:${name}`;
}

/**
 * Project one registered schema to JSON Schema.
 *
 * `additionalProperties: false` is removed from every object node. Zod emits it by default,
 * which would make a non-TypeScript reader *reject* a record written by a newer minor version —
 * the exact opposite of the forward-compatibility rule in ADR-0003. Only the literal `false` is
 * removed; a record type legitimately emits `additionalProperties: <schema>` to constrain its
 * values, and that must survive.
 *
 * @throws {AldusError} `ALDUS_SCHEMA_UNKNOWN` if `name` is not registered.
 */
export function toJsonSchema(name: SchemaName): JsonSchemaDocument {
  if (!isSchemaName(name)) {
    throw new AldusError(CoreErrorCodes.SCHEMA_UNKNOWN, `Unknown schema "${String(name)}".`, {
      category: "not_found",
      details: { requested: String(name), known: listSchemaNames() },
    });
  }

  const generated = z.toJSONSchema(coreSchemas[name], {
    target: JSON_SCHEMA_TARGET,
    override: (ctx) => {
      if (ctx.jsonSchema.additionalProperties === false) {
        delete ctx.jsonSchema.additionalProperties;
      }
    },
  }) as JsonSchemaDocument;

  // Re-key so `$schema` and `$id` lead the document. Key order is otherwise whatever Zod
  // produced, which is stable for a given schema — the drift check depends on that stability.
  const { $schema, ...rest } = generated;
  return { $schema, $id: schemaId(name), ...rest };
}

/** Project every registered schema, keyed by schema name. */
export function allJsonSchemas(): Record<SchemaName, JsonSchemaDocument> {
  const documents = {} as Record<SchemaName, JsonSchemaDocument>;
  for (const name of listSchemaNames()) documents[name] = toJsonSchema(name);
  return documents;
}

/**
 * Serialise a schema document exactly as it is written to disk.
 *
 * Two-space indent and a trailing newline, so the committed files are diffable and the drift
 * check compares like with like.
 */
export function serializeJsonSchema(document: JsonSchemaDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}
