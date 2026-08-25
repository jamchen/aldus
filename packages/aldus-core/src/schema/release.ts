/**
 * Release receipts (architecture contract §17).
 */

import { z } from "zod";
import { structuredErrorSchema } from "../errors.js";
import { iso8601, nonEmptyString, schemaVersionString, sha256Hex, uriString } from "./common.js";

/**
 * Outcome of a single release operation (contract §17).
 *
 * `pending` is required because contract §17 states each operation must be "independently
 * idempotent and resumable where the platform allows it": an operation whose outcome is not yet
 * known must be representable so it can be reconciled rather than blindly retried.
 */
export const RELEASE_STATUSES = ["succeeded", "failed", "pending", "skipped"] as const;

/** @see RELEASE_STATUSES */
export type ReleaseStatus = (typeof RELEASE_STATUSES)[number];

/**
 * The result of one release operation against one destination (contract §17).
 *
 * Contract §17: "Publishing is a domain, not a single command." A receipt covers one operation
 * — upload, captions, thumbnail, metadata, privacy transition — not a whole publish.
 *
 * Field list is transcribed verbatim from contract §17, plus `schemaVersion` and `runId` per
 * GitHub issue #1.
 */
export const releaseReceiptSchemaBase = z
  .object({
    /** Schema version of this record (ADR-0003). */
    schemaVersion: schemaVersionString,
    /** Identity of this receipt. */
    releaseId: nonEmptyString,
    /**
     * Run this release operation belongs to.
     *
     * Added beyond the contract's literal field list: contract §6's class diagram makes
     * ReleaseReceipt a child of ProductionRun, and the lineage queries of contract §20 need the
     * edge to answer "what was released from this Run".
     */
    runId: nonEmptyString,
    /**
     * Bundle whose execution produced this receipt (ADR-0033).
     *
     * Optional, and deliberately **not** part of the idempotency key — that is what made a
     * reconstructed bundle re-execute everything (#40). It is recorded so §20's trace can answer
     * "which release produced this", which nothing could previously do: receipts named the run
     * and the destination but never the bundle, so two releases of one Run were
     * indistinguishable after the fact.
     */
    bundleId: nonEmptyString.optional(),
    /**
     * Where the operation was directed.
     *
     * An OPEN string, never a Core-defined enum. Contract §1.2 explicitly rules out prescribing
     * particular release targets, and contract §4.2 keeps channel and feed identities out of
     * Core. Do not narrow this to a union.
     */
    destination: nonEmptyString,
    /**
     * Which operation this receipt records, e.g. a media upload, caption attachment, or
     * visibility transition (contract §17 lists candidates).
     *
     * An OPEN string, for the same reason as `destination`. Do not narrow this to a union.
     */
    operation: nonEmptyString,
    /**
     * Key that makes re-running this operation safe (contract §17, §19.1 "idempotency keys for
     * external side effects").
     *
     * Required, not optional: contract §17 states each operation MUST be independently
     * idempotent, and an operation with no key cannot be safely resumed after a partial failure.
     */
    idempotencyKey: nonEmptyString,
    /** Outcome. @see RELEASE_STATUSES */
    status: z.enum(RELEASE_STATUSES),
    /** Identifier assigned by the destination, where one was returned. */
    remoteId: nonEmptyString.optional(),
    /** Address of the released item at the destination, where one is meaningful. */
    remoteUrl: uriString.optional(),
    /**
     * Digests of exactly what was released (contract §13.4 "release approval MUST bind to the
     * final render, captions, metadata, destination, and visibility policy").
     */
    inputHashes: z.array(sha256Hex).max(4096),
    /** When the operation reached a terminal state. Absent while `pending`. */
    completedAt: iso8601.optional(),
    /** Structured failure, already redacted by its producer (contract §19.1, §19.2). */
    error: structuredErrorSchema.optional(),
    /**
     * Something an operator needs to know about an operation that succeeded (§20; #169).
     *
     * `error` carries what a reader needs when something failed, and there was no equivalent for a
     * success that has something to say — an operation that removed a marker from one item of
     * several, or that found nothing to remove and therefore removed nothing, had to discard the
     * only part an operator would have wanted.
     *
     * Adapter-supplied and already redacted (§19.2). Deliberately **not** a place to footnote a
     * remote state the adapter could not establish: that is `cannotEstablish`, and using this
     * instead would be a false record with better documentation.
     */
    note: nonEmptyString.max(2000).optional(),
  })
  .meta({
    id: "ReleaseReceipt",
    title: "ReleaseReceipt",
    description:
      "The result of ONE release operation against one destination (architecture contract §17) " +
      "— not a whole publish; contract §17 states publishing is a domain, not a single command. " +
      "`idempotencyKey` is required so a partially failed release can be resumed rather than " +
      "blindly re-run. `status: pending` exists so an operation with an unconfirmed outcome can " +
      "be reconciled against the destination instead of retried. `destination` and `operation` " +
      "are open strings because contract §1.2 rules out prescribing release targets.",
  });

/** @see releaseReceiptSchema */
export type ReleaseReceipt = z.infer<typeof releaseReceiptSchemaBase>;
