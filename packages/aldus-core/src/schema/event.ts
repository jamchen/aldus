/**
 * Event envelope (architecture contract §6.4).
 *
 * §6.4 requires that **every** state mutation emit an immutable event. This is the record that
 * obligation produces. It lives in Core rather than in a storage implementation because §7
 * requires core models to be independent of physical storage, and because the packages that
 * *emit* events — the stage runner, the gate engine, the artifact registry — must not have to
 * depend on the file store to describe a domain fact (ADR-0004).
 *
 * Events are append-only and immutable. Nothing in this schema is a mutable summary; §6.3's
 * materialized manifests exist for that.
 */

import { z } from "zod";

import { structuredErrorSchema } from "../errors.js";
import { actorRefSchema, iso8601, nonEmptyString, schemaVersionString } from "./common.js";

/**
 * One immutable record of a state mutation (contract §6.4).
 *
 * The field list implements §6.4's requirement list directly: event ID and schema version,
 * timestamp, Episode and Run IDs, actor and backend, action, previous and resulting state,
 * input and output references, idempotency key, and safe error detail.
 */
export const aldusEventSchema = z
  .object({
    /** Schema version of this record (ADR-0003). */
    schemaVersion: schemaVersionString,
    /** Identity of this event. Time-ordered, so an append-only log sorts by ID alone. */
    eventId: nonEmptyString,
    /** When the mutation happened, as observed by the emitter. */
    occurredAt: iso8601,
    /** Canonical Episode identity the mutation concerns (§6.1). */
    episodeId: nonEmptyString,
    /** Run the mutation belongs to (§6.2). */
    runId: nonEmptyString,
    /** Stage the mutation concerns, where the mutation is stage-scoped. */
    stageId: nonEmptyString.optional(),
    /** Attempt the mutation concerns, where the mutation is attempt-scoped. */
    attemptId: nonEmptyString.optional(),
    /**
     * What happened, by convention `<subject>.<verb>` — for example `stage.attempt.started`.
     *
     * An OPEN string, never a Core-defined enum. Contract §11 makes workflows adopter-supplied
     * and §4.2 keeps adopter concepts out of Core, so Core cannot enumerate the actions an
     * adopter's stages perform. The convention is documented and unenforced. Do not narrow this
     * to a union.
     */
    action: nonEmptyString,
    /**
     * Who or what performed the mutation (§19.2 "mutating actions MUST record actor identity").
     *
     * `ActorRef.backendId` carries the Agent Backend, satisfying §6.4's "actor and backend".
     */
    actor: actorRefSchema,
    /** State before the mutation, where the mutation is a state transition. */
    previousState: nonEmptyString.optional(),
    /** State after the mutation, where the mutation is a state transition. */
    resultingState: nonEmptyString.optional(),
    /** Artifact IDs consumed by the mutation (§6.4 "input and output references"). */
    inputRefs: z.array(nonEmptyString).max(1024),
    /** Artifact IDs produced by the mutation. */
    outputRefs: z.array(nonEmptyString).max(1024),
    /**
     * Key deduplicating an external side effect (§19.1 "idempotency keys for external side
     * effects").
     *
     * Optional because most mutations are local state transitions with no external effect to
     * deduplicate. §17 requires it on release operations, which is enforced there.
     */
    idempotencyKey: nonEmptyString.optional(),
    /**
     * Per-run monotonic ordinal, where a store provides one.
     *
     * Optional by deliberate choice (ADR-0004). §6.4 does not require it, and Core's ULIDs
     * already sort by creation time *within one process* — but two concurrent sessions in one
     * workspace do not share that guarantee, so a store may need an explicit ordinal. A store
     * can always populate an optional field and require it on read; promoting an optional field
     * to required later would be a MAJOR bump under ADR-0003.
     */
    sequence: z.int().nonnegative().optional(),
    /** Failure detail, where the mutation failed. Already redacted (§6.4 "safe error detail"). */
    error: structuredErrorSchema.optional(),
    /**
     * Additional context. Already redacted by the emitter.
     *
     * §19.2 requires logs to redact credentials, and an event is durable — a secret written here
     * once is leaked permanently. Pass values through `redact()` before constructing an event.
     */
    details: z.record(z.string(), z.unknown()).optional(),
  })
  .meta({
    id: "AldusEvent",
    title: "AldusEvent",
    description:
      "One immutable record of a state mutation (architecture contract §6.4, which requires " +
      "every state mutation to emit one). Append-only: an event is never edited, and §6.3's " +
      "materialized manifests exist for mutable summaries. `action` is an open string because " +
      "workflows belong to adopters, not to Core (§4.2). `sequence` is optional because a store " +
      "may or may not need an explicit per-run ordinal beyond the time-ordered `eventId` " +
      "(ADR-0004). `error` and `details` are required to be redacted by the emitter, because an " +
      "event is durable and a secret written here once is leaked permanently (§19.2).",
  });

/** @see aldusEventSchema */
export type AldusEvent = z.infer<typeof aldusEventSchema>;
