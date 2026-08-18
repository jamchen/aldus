/**
 * Production Run manifest (architecture contract §6.2).
 */

import { z } from "zod";
import { iso8601, knowledgePackRefSchema, nonEmptyString, schemaVersionString } from "./common.js";
import { episodeRefSchema } from "./episode.js";

/**
 * Lifecycle states of a Run (contract §6.2).
 *
 * `waiting` is a first-class state, not an error: contract §5.1 states that long pauses between
 * stages are normal in the Interactive Editorial Profile, and contract §13 makes human gates a
 * blocking, durable step.
 */
export const RUN_STATUSES = [
  "created",
  "running",
  "waiting",
  "failed",
  "completed",
  "cancelled",
] as const;

/** @see RUN_STATUSES */
export type RunStatus = (typeof RUN_STATUSES)[number];

/**
 * One attempt to move an Episode through part or all of a workflow (contract §6.2).
 *
 * Field list is transcribed verbatim from contract §6.2.
 */
export const runManifestSchema = z
  .object({
    /** Schema version of this record (ADR-0003). */
    schemaVersion: schemaVersionString,
    /** Identity of this Run. */
    runId: nonEmptyString,
    /**
     * The Episode this Run advances.
     *
     * Embedded by value rather than referenced by ID: contract §6 separates Episode from
     * execution state, and a Run manifest must remain interpretable on its own when read from
     * an archive whose Episode record has since moved or changed.
     */
    episode: episodeRefSchema,
    /**
     * Identity of the workflow being executed.
     *
     * An OPEN string, never a Core-defined enum. Contract §11 states a workflow is a versioned
     * graph supplied to the Runtime, and contract §4.2 keeps adopter workflows out of Core.
     * Do not narrow this to a union.
     */
    workflowId: nonEmptyString,
    /**
     * Version of the workflow definition in force for this Run.
     *
     * Recorded so contract §20 can answer "which code and configuration were used" even after
     * the workflow definition moves on.
     */
    workflowVersion: nonEmptyString,
    /** Current lifecycle state. @see RUN_STATUSES */
    status: z.enum(RUN_STATUSES),
    /** Stage the Run is currently at, if any. Absent before the first stage and after completion. */
    currentStage: nonEmptyString.optional(),
    /**
     * Revision of the runtime code that executed this Run (contract §20 "which inputs, code,
     * packs, and configuration were used"). Opaque string; Core assumes no VCS.
     */
    codeRevision: nonEmptyString.optional(),
    /**
     * Snapshot of the Knowledge Packs in force for this Run (contract §9, WP-09 "pack snapshot
     * in Run Manifest").
     *
     * Snapshotted rather than resolved at read time, so that a Run remains explicable after the
     * packs it used have been revised.
     */
    knowledgePacks: z.array(knowledgePackRefSchema).max(512),
    /** When the Run was created. */
    createdAt: iso8601,
    /** When the Run manifest was last mutated. */
    updatedAt: iso8601,
  })
  .meta({
    id: "RunManifest",
    title: "RunManifest",
    description:
      "One attempt to move an Episode through part or all of a workflow (architecture contract " +
      "§6.2). The Episode is embedded by value so the manifest stays interpretable in isolation. " +
      "`knowledgePacks` is a snapshot, not a live reference, so a completed Run remains " +
      "explicable after its packs are revised (§20). `workflowId` is an open string because " +
      "workflows belong to adopters, not to Core (§4.2).",
  });

/** @see runManifestSchema */
export type RunManifest = z.infer<typeof runManifestSchema>;
