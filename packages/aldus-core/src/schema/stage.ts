/**
 * Stage execution and attempts (architecture contract §6.3).
 */

import { z } from "zod";
import { structuredErrorSchema } from "../errors.js";
import { actorRefSchema, iso8601, nonEmptyString, schemaVersionString } from "./common.js";
import { artifactRefSchema } from "./artifact.js";

/**
 * Lifecycle states of a stage attempt (contract §6.3).
 *
 * `waiting_for_gate` is distinct from `running` because contract §13 makes human review a
 * first-class operation: a stage parked on a human decision is not stalled, and must not be
 * treated as a timeout or retried.
 */
export const STAGE_STATUSES = [
  "queued",
  "running",
  "waiting_for_gate",
  "failed",
  "succeeded",
  "cancelled",
] as const;

/** @see STAGE_STATUSES */
export type StageStatus = (typeof STAGE_STATUSES)[number];

/**
 * One invocation of a stage (contract §6.3).
 *
 * Contract §6.3: "Attempts MUST be append-only audit records." An attempt is never edited in
 * place — a retry appends a new attempt, so the history of what was tried survives.
 *
 * Field list is transcribed verbatim from contract §6.3. It carries no `schemaVersion`: it is
 * an embedded value object and inherits the version of the document containing it (ADR-0003).
 */
export const stageAttemptSchema = z
  .object({
    /** Identity of this attempt. */
    attemptId: nonEmptyString,
    /** Stage this attempt invoked. */
    stageId: nonEmptyString,
    /**
     * 1-based attempt ordinal within the stage execution.
     *
     * An integer of at least 1: attempt 0 would make "how many times has this been tried"
     * ambiguous, and contract §19.1 requires retry limits to be countable.
     */
    attempt: z.number().int().min(1),
    /** Lifecycle state of this attempt. @see STAGE_STATUSES */
    status: z.enum(STAGE_STATUSES),
    /** Who or what performed this attempt (contract §19.2 "mutating actions MUST record actor identity"). */
    actor: actorRefSchema,
    /**
     * Artifacts consumed (contract §11 "each stage MUST validate its declared inputs").
     *
     * Recorded by value so the attempt states exactly which input *versions* it saw — the basis
     * for the hash-bound approval invalidation of contract §13.
     */
    inputArtifacts: z.array(artifactRefSchema).max(4096),
    /** Artifacts produced (contract §11 "produce declared outputs or a structured failure"). */
    outputArtifacts: z.array(artifactRefSchema).max(4096),
    /**
     * What the runner expected this attempt to register, resolved before it ran (ADR-0040).
     *
     * §20 asks what the runner expected **at that time**. The expectation comes from a resolver —
     * a function whose answer changes with a later edit — so a trace holding only the outcome
     * could not tell "the stage failed to produce it" from "the rule changed afterwards".
     *
     * Absent on attempts recorded before ADR-0040, and on stages declaring `produces: "none"`.
     * Absent reads as *nothing recorded an expectation*, never as *nothing was expected*: that
     * conflation is the defect this field exists to end.
     */
    expectedArtifacts: z
      .array(
        z.object({
          /** Adopter-defined artifact kind, opaque to Core (§4.2). */
          kind: nonEmptyString,
          /** Fewest registrations that satisfy the contract. */
          minCount: z.number().int().min(0),
          /** Most permitted. Absent means unbounded. */
          maxCount: z.number().int().min(0).optional(),
        }),
      )
      .max(1024)
      .optional(),
    /** When the attempt began. Absent while still `queued`. */
    startedAt: iso8601.optional(),
    /** When the attempt reached a terminal state. Absent while still in flight. */
    finishedAt: iso8601.optional(),
    /**
     * Structured failure (contract §11, §19.1).
     *
     * Already redacted by its producer (contract §19.2) — this record is durable and reviewable.
     */
    error: structuredErrorSchema.optional(),
  })
  .meta({
    id: "StageAttempt",
    title: "StageAttempt",
    description:
      "One invocation of a stage (architecture contract §6.3). Append-only: a retry appends a " +
      "new attempt rather than editing this one, so the history of what was tried survives. " +
      "Input and output artifacts are recorded by value, which is what makes hash-bound " +
      "approval invalidation (§13) possible. Carries no schemaVersion — it is embedded and " +
      "inherits its container's version (ADR-0003).",
  });

/** @see stageAttemptSchema */
export type StageAttempt = z.infer<typeof stageAttemptSchema>;

/**
 * A logical stage within a Run, summarising its attempts (contract §6.3).
 *
 * Contract §6.3: "A Stage Execution represents a logical stage in a Run. An Attempt is one
 * invocation… A materialized manifest MAY summarize the current state." This is that summary.
 *
 * The contract does not give a field list for this type; the shape below is decided in GitHub
 * issue #1 as the smallest option that supports contract §19.1 retry and resume semantics.
 */
export const stageExecutionSchema = z
  .object({
    /** Schema version of this record (ADR-0003). */
    schemaVersion: schemaVersionString,
    /** Run this stage execution belongs to. */
    runId: nonEmptyString,
    /** Stage being executed. */
    stageId: nonEmptyString,
    /**
     * Version of the stage definition used (contract §11 `StageDefinition.version`).
     *
     * Optional because a stage wrapped from an existing script (contract §3.7) may not have a
     * meaningful version until it is refactored.
     */
    stageVersion: nonEmptyString.optional(),
    /**
     * Current state of the stage, normally mirroring the latest attempt.
     *
     * Stored rather than derived so the summary can be read without loading every attempt.
     */
    status: z.enum(STAGE_STATUSES),
    /**
     * Attempts in ascending order, append-only (contract §6.3).
     *
     * Ordering is enforced: attempts are the audit record, and an out-of-order or duplicated
     * ordinal means a writer has overwritten history rather than appending to it.
     */
    attempts: z.array(stageAttemptSchema).max(1024),
    /** When the first attempt began. */
    startedAt: iso8601.optional(),
    /** When the stage reached a terminal state. */
    finishedAt: iso8601.optional(),
  })
  .refine(
    (execution) =>
      execution.attempts.every(
        (attempt, index) =>
          index === 0 || attempt.attempt > (execution.attempts[index - 1]?.attempt ?? 0),
      ),
    {
      message:
        "attempts must be ordered by strictly ascending `attempt` (architecture contract §6.3: attempts are append-only audit records).",
      path: ["attempts"],
    },
  )
  .meta({
    id: "StageExecution",
    title: "StageExecution",
    description:
      "A logical stage within a Run, summarising its append-only attempts (architecture " +
      "contract §6.3). ADDITIONAL CONSTRAINT NOT EXPRESSIBLE IN JSON SCHEMA: the `attempt` " +
      "ordinals in `attempts` must be strictly ascending, because attempts are an audit record " +
      "and an out-of-order or duplicated ordinal means a writer overwrote history instead of " +
      "appending to it. Validators generated from this schema will NOT enforce that; the " +
      "normative Zod schema does.",
  });

/** @see stageExecutionSchema */
export type StageExecution = z.infer<typeof stageExecutionSchema>;
