/**
 * The Aldus Core schema registry.
 *
 * Every core domain type of the architecture contract §6–§19 is registered here exactly once.
 * The registry is what `validate()`, the JSON Schema generator, and the testkit all iterate
 * over, so a type that is not registered simply does not exist as far as tooling is concerned.
 */

import type { z } from "zod";

import { structuredErrorSchema } from "../errors.js";
import { actorRefSchema, knowledgePackRefSchema } from "./common.js";
import { artifactRefSchema } from "./artifact.js";
import { costRecordSchema } from "./cost.js";
import { aldusEventSchema } from "./event.js";
import { episodeRefSchema } from "./episode.js";
import { gateDecisionSchema } from "./gate.js";
import { knowledgePackManifestSchema } from "../knowledge/manifest.js";
import { releaseReceiptSchema } from "./release.js";
import { runManifestSchema } from "./run.js";
import { stageExecutionSchema, stageAttemptSchema } from "./stage.js";

export * from "./common.js";
export * from "./artifact.js";
export * from "./cost.js";
export * from "./episode.js";
export * from "./event.js";
export * from "./gate.js";
export * from "./release.js";
export * from "./run.js";
export * from "./stage.js";

/**
 * The thirteen core domain types (architecture contract §6.1, §6.2, §6.3, §8, §9.1, §13, §17,
 * §19.1, §19.2, §19.3).
 *
 * Order is the contract's own narrative order — identity, then execution, then artifacts, then
 * decisions, then accounting — so generated documentation reads top-down.
 */
export const coreSchemas = {
  EpisodeRef: episodeRefSchema,
  RunManifest: runManifestSchema,
  StageExecution: stageExecutionSchema,
  StageAttempt: stageAttemptSchema,
  ArtifactRef: artifactRefSchema,
  GateDecision: gateDecisionSchema,
  CostRecord: costRecordSchema,
  ReleaseReceipt: releaseReceiptSchema,
  KnowledgePackRef: knowledgePackRefSchema,
  ActorRef: actorRefSchema,
  StructuredError: structuredErrorSchema,
  AldusEvent: aldusEventSchema,
  KnowledgePackManifest: knowledgePackManifestSchema,
} as const;

/** Name of a registered core schema. */
export type SchemaName = keyof typeof coreSchemas;

/** The validated TypeScript type produced by a registered schema. */
export type SchemaTypeFor<N extends SchemaName> = z.infer<(typeof coreSchemas)[N]>;

/**
 * Schemas that carry their own `schemaVersion` because they are persisted or transmitted as
 * standalone documents (ADR-0003).
 *
 * The remaining schemas are embedded value objects and inherit the version of the document
 * containing them, so a version check on them would have nothing to read.
 */
export const VERSIONED_SCHEMA_NAMES = [
  "EpisodeRef",
  "RunManifest",
  "StageExecution",
  "ArtifactRef",
  "GateDecision",
  "CostRecord",
  "ReleaseReceipt",
  "AldusEvent",
  "KnowledgePackManifest",
] as const;

/** @see VERSIONED_SCHEMA_NAMES */
export type VersionedSchemaName = (typeof VERSIONED_SCHEMA_NAMES)[number];

/** All registered schema names, in registry order. */
export function listSchemaNames(): SchemaName[] {
  return Object.keys(coreSchemas) as SchemaName[];
}

/** True if `name` identifies a registered core schema. */
export function isSchemaName(name: string): name is SchemaName {
  return Object.hasOwn(coreSchemas, name);
}

/** True if `name` identifies a schema that carries its own `schemaVersion` (ADR-0003). */
export function isVersionedSchemaName(name: string): name is VersionedSchemaName {
  return (VERSIONED_SCHEMA_NAMES as readonly string[]).includes(name);
}
export * from "./reservation.js";
