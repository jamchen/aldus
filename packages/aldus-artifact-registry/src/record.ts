/**
 * Registry records: an artifact plus everything contract §8.1 requires be recorded about it.
 *
 * `ArtifactRef` (Core, contract §8) carries `producerRunId` and `producerStageId`, but §8.1
 * requires more than that:
 *
 * > An artifact MUST record which stage, run, **code revision, and configuration** produced it.
 * > Provider seed MUST be recorded but MUST NOT be treated as a reproducibility guarantee.
 *
 * Code revision, configuration, and seed have no home on `ArtifactRef`. They are added here
 * rather than to Core for two reasons. `ArtifactRef`'s field list is transcribed verbatim from
 * the contract and guarded by a conformance test, so widening it is a deliberate departure from
 * the contract's own text. And a seed is a §15 concept: pushing it onto the universal artifact
 * reference would put a synthesis-specific field on every storyboard and caption file in the
 * system. See ADR-0007.
 *
 * The registry requires provenance at registration, so "MUST record" is enforced by the type
 * system and the API rather than left to a producer's diligence.
 */

import { z } from "zod";

import { artifactRefSchema, SCHEMA_VERSION } from "@aldus-runtime/core";

/**
 * How an artifact came to exist (contract §8.1, §20).
 *
 * Everything here is either an opaque caller-supplied string or a digest. Contract §4.2 forbids
 * Core and its packages from naming a provider, so nothing in this shape identifies one.
 */
export const artifactProvenanceSchema = z
  .object({
    /**
     * Revision of the runtime code that produced the artifact (contract §8.1, §20 "which
     * inputs, code, packs, and configuration were used").
     *
     * Optional because contract §3.7 expects existing scripts to be wrapped before they are
     * rewritten, and a wrapped script may not expose one. Absent is honest; a fabricated value
     * would be worse than none.
     */
    codeRevision: z.string().min(1).max(200).optional(),
    /**
     * Digest of the exact configuration used, from {@link digestConfiguration}.
     *
     * A digest rather than the configuration itself is what makes §13.2's hash-bound
     * authorization checkable: an operator authorises a configuration, and this is what proves
     * the artifact was produced under it.
     */
    configHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    /**
     * The configuration itself, already redacted.
     *
     * Contract §19.2 requires secrets to be referenced rather than embedded, and a registry
     * record is durable — a credential written here once is leaked permanently. Producers pass
     * configuration through Core's `redact()` before registering.
     */
    configuration: z.record(z.string(), z.unknown()).optional(),
    /**
     * Provider seed, where one was used (contract §8.1, §14.4, §15).
     *
     * Recorded for trace only. Contract §1.2 explicitly does not guarantee that a seed
     * reproduces identical audio, and §8.1 states a seed "MUST NOT be treated as a
     * reproducibility guarantee" — so nothing in this package re-derives an artifact from one,
     * and nothing should be built that does. It is evidence, not a recipe.
     */
    providerSeed: z.string().min(1).max(400).optional(),
    /**
     * Knowledge Packs in force when the artifact was produced (contract §20).
     *
     * Pack identity strings, snapshotted. §9 pack resolution is WP-09's; this only records what
     * was resolved, so a completed Run stays explicable after its packs are revised.
     */
    knowledgePackIds: z.array(z.string().min(1).max(200)).max(512).optional(),
    /** Free-text note from the producer. Already redacted. */
    note: z.string().max(2000).optional(),
  })
  .meta({
    id: "ArtifactProvenance",
    title: "ArtifactProvenance",
    description:
      "How an artifact came to exist (architecture contract §8.1). Carries the code revision, " +
      "configuration digest, and provider seed that ArtifactRef has no field for. The seed is " +
      "recorded for trace only: §8.1 states it MUST NOT be treated as a reproducibility " +
      "guarantee, and nothing re-derives an artifact from one.",
  });

/** @see artifactProvenanceSchema */
export type ArtifactProvenance = z.infer<typeof artifactProvenanceSchema>;

/** Proof that an artifact's bytes are held in an archive (contract §8.1). */
export const archiveReceiptSchema = z
  .object({
    /** Which archive holds the bytes. Opaque adapter identity; Core names no storage service (§4.2). */
    archiveId: z.string().min(1).max(200),
    /** Where the archive placed the bytes. Location, not identity (contract §8.1). */
    uri: z.string().min(1).max(4096),
    /** Digest the bytes were stored under and verified against. */
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    /** Size in bytes as the archive observed it. */
    sizeBytes: z.number().int().min(0),
    /** When the archive accepted the bytes. */
    archivedAt: z.iso.datetime({ offset: true }),
    /**
     * Whether the archive re-read the bytes and confirmed the digest.
     *
     * Always true for receipts this package issues — an unverified archive is a belief, not a
     * record, and §8.1 requires irreplaceable artifacts to actually be archived before cleanup.
     * The field exists so a future adapter that genuinely cannot verify (a write-only or
     * eventually-consistent target) can say so rather than overstate.
     */
    verified: z.boolean(),
  })
  .meta({
    id: "ArchiveReceipt",
    title: "ArchiveReceipt",
    description:
      "Proof that an artifact's bytes are held in an archive (architecture contract §8.1). " +
      "`verified` records whether the archive re-read the bytes and confirmed the digest; a " +
      "receipt with `verified: false` does not satisfy the pre-cleanup archival requirement.",
  });

/** @see archiveReceiptSchema */
export type ArchiveReceipt = z.infer<typeof archiveReceiptSchema>;

/**
 * One artifact as the registry holds it (contract §8, §8.1).
 *
 * The registry index is the authoritative list of artifacts for a workspace. Contract §7's
 * per-run `artifacts.json` is a materialized per-run view that a stage runner (WP-04) may
 * maintain; this package does not write it, because dual-writing two lists without a
 * transaction is how they diverge.
 */
export const artifactRecordSchema = z
  .object({
    /** Schema version of this record (ADR-0003). */
    schemaVersion: z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)$/),
    /** The artifact itself (contract §8). */
    artifact: artifactRefSchema,
    /** How it was produced (contract §8.1). */
    provenance: artifactProvenanceSchema,
    /** Archive custody, once taken. Absent means the bytes exist only at `artifact.uri`. */
    archive: archiveReceiptSchema.optional(),
    /** When the registry first recorded this artifact. */
    registeredAt: z.iso.datetime({ offset: true }),
    /**
     * A later artifact that replaces this one, by `artifactId`.
     *
     * Contract §15.1: "Rejected paid takes SHOULD be retained with unique identity until
     * retention policy allows cleanup." Superseding records the replacement without deleting
     * the replaced — a rejected take is evidence of what was tried, not garbage. Which take is
     * accepted is a §13.3 human decision and belongs to WP-05 and WP-07, not here.
     */
    supersededBy: z.string().min(1).max(200).optional(),
  })
  .meta({
    id: "ArtifactRecord",
    title: "ArtifactRecord",
    description:
      "One artifact as the artifact registry holds it: the ArtifactRef, the provenance §8.1 " +
      "requires, and archive custody once taken. Superseding never deletes the superseded " +
      "record, because §15.1 requires rejected takes to be retained with unique identity.",
  });

/** @see artifactRecordSchema */
export type ArtifactRecord = z.infer<typeof artifactRecordSchema>;

/** The registry index document as stored on disk. */
export const artifactIndexSchema = z
  .object({
    schemaVersion: z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)$/),
    /** Records keyed by `artifactId`. */
    artifacts: z.array(artifactRecordSchema).max(1_000_000),
  })
  .meta({
    id: "ArtifactIndex",
    title: "ArtifactIndex",
    description: "The artifact registry's workspace-level index of ArtifactRecords.",
  });

/** @see artifactIndexSchema */
export type ArtifactIndex = z.infer<typeof artifactIndexSchema>;

/** An empty index, stamped with this build's schema version. */
export function emptyIndex(): ArtifactIndex {
  return { schemaVersion: SCHEMA_VERSION, artifacts: [] };
}
