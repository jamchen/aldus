/**
 * Production Run manifest (architecture contract §6.2).
 */

import { z } from "zod";
import {
  actorRefSchema,
  humanText,
  iso8601,
  knowledgePackRefSchema,
  nonEmptyString,
  schemaVersionString,
} from "./common.js";
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
    /**
     * The state this Run was **created** in, not its current one.
     *
     * A Run's current state is **derived on read** from its stage executions and its
     * `cancellation` record — never written back here (ADR-0026). A stored summary drifts from
     * the log it summarises, which is the defect this field's history demonstrates: it was
     * written once at creation and never again, leaving four of the six states below
     * unreachable.
     *
     * Read `RunReport.state` or `RunSummary.status` for the answer to "where is this Run now".
     * This field remains because §6.2 states it verbatim, and because the moment of creation is
     * itself a fact worth recording.
     *
     * @see RUN_STATUSES
     */
    status: z.enum(RUN_STATUSES),
    /**
     * Stage the Run was at when the manifest was written, if any.
     *
     * Like {@link status}, the live answer is derived rather than stored (ADR-0026). Present for
     * the same reason: §6.2 declares it.
     */
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
    /**
     * The stages this Run intends to reach (contract §11, ADR-0026).
     *
     * Completion is **declared intent**, not an inference. A workflow graph describes what a
     * workflow *can* do; it cannot say what this particular Run set out to do, and the two
     * differ routinely — a stage may be conditional on the edition being produced, and a Run may
     * deliberately stop short of publishing.
     *
     * Optionality is a property of *this Run*, not of a stage: marking a stage optional in the
     * graph would make the graph lie about every other Run that does require it. Declaring the
     * goal per Run puts the variable thing where the variation lives.
     *
     * Plural because §11 calls a workflow a graph, and a graph may end in several places at once.
     *
     * Absent means "not declared". The services default it from the supplied workflow graph at
     * `startRun`; a Run started without a graph and without goals can never be `completed`,
     * which is honest — nothing has said what finishing would mean.
     */
    goalStages: z.array(nonEmptyString).max(512).optional(),
    /**
     * Record of a human abandoning this Run (contract §19.1, §19.2).
     *
     * The one state that **cannot** be derived. No amount of reading an append-only log
     * distinguishes a Run someone gave up on from one they are still thinking about — §5.1 makes
     * long pauses ordinary, so silence means nothing. Abandonment is a decision, so it is
     * recorded as one, with the actor who made it.
     *
     * Its presence is what makes a Run `cancelled`; nothing else can.
     */
    cancellation: z
      .object({
        /** When the Run was abandoned. */
        cancelledAt: iso8601,
        /** Who abandoned it (contract §19.2: mutating actions record actor identity). */
        cancelledBy: actorRefSchema,
        /** Why, when the operator said. */
        reason: humanText.optional(),
      })
      .optional(),
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
      "workflows belong to adopters, not to Core (§4.2). `status` and `currentStage` record the " +
      "Run as created; its live state is derived from stage executions and `cancellation` " +
      "rather than stored, so the summary cannot drift from the log it summarises (ADR-0026). " +
      "`goalStages` declares what this Run intended to reach, because a workflow graph says " +
      "what a workflow can do and not what one Run set out to do.",
  });

/** @see runManifestSchema */
export type RunManifest = z.infer<typeof runManifestSchema>;
