/**
 * The Aldus Core schema registry.
 *
 * Every core domain type of the architecture contract §6–§19 is registered here exactly once.
 * The registry is what `validate()`, the JSON Schema generator, and the testkit all iterate
 * over, so a type that is not registered simply does not exist as far as tooling is concerned.
 */

import type { z } from "zod";

import { structuredErrorSchema } from "../errors.js";
import { withForeignMajorRefused } from "./guard.js";
import { spendReservationSchemaBase, spendReservationTransitionSchemaBase } from "./reservation.js";
import { actorRefSchema, knowledgePackRefSchema } from "./common.js";
import { artifactRefSchemaBase } from "./artifact.js";
import { costRecordSchemaBase } from "./cost.js";
import { aldusEventSchemaBase } from "./event.js";
import { episodeRefSchemaBase } from "./episode.js";
import { gateDecisionSchemaBase } from "./gate.js";
import { knowledgePackManifestSchemaBase } from "../knowledge/manifest.js";
import { releaseReceiptSchemaBase } from "./release.js";
import { reworkPolicySchemaBase, reworkRoundSchemaBase } from "./rework.js";
import { runManifestSchemaBase } from "./run.js";
import { stageAttemptSchema, stageExecutionSchemaBase } from "./stage.js";

export * from "./common.js";
export * from "./artifact.js";
export * from "./cost.js";
export * from "./episode.js";
export * from "./event.js";
export * from "./gate.js";
export * from "./release.js";
export * from "./rework.js";
export * from "./run.js";
export * from "./stage.js";

/**
 * The thirteen core domain types (architecture contract §6.1, §6.2, §6.3, §8, §9.1, §13, §17,
 * §19.1, §19.2, §19.3).
 *
 * Order is the contract's own narrative order — identity, then execution, then artifacts, then
 * decisions, then accounting — so generated documentation reads top-down.
 */

// --- The exported schemas carry the same-major rule (#199, ADR-0053) -------------------------
//
// One combinator applied in one place, so the nine guards cannot drift apart. The registry below
// holds the **unguarded** bases, because `validateRecord(name, data, supported)` takes the
// supported version as a parameter and a baked-in constant would break that path.
//
// `packages/aldus-core/test/exported-schemas-carry-the-rule.test.ts` enumerates the exports
// dynamically rather than listing them, so a schema added without a guard fails rather than being
// forgotten by both the code and the list.
export const episodeRefSchema = withForeignMajorRefused(episodeRefSchemaBase);
export const runManifestSchema = withForeignMajorRefused(runManifestSchemaBase);
export const stageExecutionSchema = withForeignMajorRefused(stageExecutionSchemaBase);
export const artifactRefSchema = withForeignMajorRefused(artifactRefSchemaBase);
export const gateDecisionSchema = withForeignMajorRefused(gateDecisionSchemaBase);
export const costRecordSchema = withForeignMajorRefused(costRecordSchemaBase);
export const releaseReceiptSchema = withForeignMajorRefused(releaseReceiptSchemaBase);
export const aldusEventSchema = withForeignMajorRefused(aldusEventSchemaBase);
export const knowledgePackManifestSchema = withForeignMajorRefused(knowledgePackManifestSchemaBase);
// Found by the conformance test, not by the list: these carry `schemaVersion` and are exported,
// and they are not in `coreSchemas` — so a hand-written list would have missed both doors.
export const reworkPolicySchema = withForeignMajorRefused(reworkPolicySchemaBase);
export const reworkRoundSchema = withForeignMajorRefused(reworkRoundSchemaBase);
export const spendReservationSchema = withForeignMajorRefused(spendReservationSchemaBase);
export const spendReservationTransitionSchema = withForeignMajorRefused(
  spendReservationTransitionSchemaBase,
);

export const coreSchemas = {
  EpisodeRef: episodeRefSchemaBase,
  RunManifest: runManifestSchemaBase,
  StageExecution: stageExecutionSchemaBase,
  StageAttempt: stageAttemptSchema,
  ArtifactRef: artifactRefSchemaBase,
  GateDecision: gateDecisionSchemaBase,
  CostRecord: costRecordSchemaBase,
  ReleaseReceipt: releaseReceiptSchemaBase,
  KnowledgePackRef: knowledgePackRefSchema,
  ActorRef: actorRefSchema,
  StructuredError: structuredErrorSchema,
  AldusEvent: aldusEventSchemaBase,
  KnowledgePackManifest: knowledgePackManifestSchemaBase,
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
