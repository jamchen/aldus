/**
 * Artifact references (architecture contract §8).
 */

import { z } from "zod";
import { iso8601, nonEmptyString, schemaVersionString, sha256Hex, uriString } from "./common.js";

/**
 * How recoverable an artifact is if it is lost (contract §8).
 *
 * Drives contract §8.1: "Irreplaceable artifacts MUST be archived before disposable working
 * files are cleaned." This is the field that stops a cleanup routine from deleting a paid,
 * human-approved take.
 */
export const RECONSTRUCTABILITY = ["source", "reproducible", "irreplaceable"] as const;

/** @see RECONSTRUCTABILITY */
export type Reconstructability = (typeof RECONSTRUCTABILITY)[number];

/**
 * A content-addressed reference to a produced artifact (contract §8).
 *
 * Contract §8: "Artifacts are the stable boundary between stages." Contract §8.1: a path or
 * filename MUST NOT be treated as identity, and every artifact records which stage and run
 * produced it.
 *
 * Field list is transcribed verbatim from contract §8.
 */
export const artifactRefSchema = z
  .object({
    /** Schema version of this record (ADR-0003). */
    schemaVersion: schemaVersionString,
    /**
     * Stable artifact identity.
     *
     * Contract §8.1: "Path or filename MUST NOT be treated as identity." This field, with
     * `sha256`, is how an approved artifact is addressed.
     */
    artifactId: nonEmptyString,
    /**
     * What kind of artifact this is, e.g. a canonical content form from contract §8.2.
     *
     * An OPEN string, never a Core-defined enum. Contract §8.2 lists a content progression
     * (EpisodeBrief → ResearchPack → … → ReleaseBundle) but contract §1 requires support for
     * podcasts, long-form video, Shorts, and forms not yet imagined; an adopter must be able to
     * introduce an artifact kind without changing Core. Do not narrow this to a union.
     */
    kind: nonEmptyString,
    /**
     * Where the bytes currently live.
     *
     * Location, not identity (contract §8.1). An artifact may be re-hosted without becoming a
     * different artifact.
     */
    uri: uriString,
    /** Digest of the artifact's bytes. With `artifactId`, this is how approvals bind (§8.1). */
    sha256: sha256Hex,
    /** IANA media type of the bytes. Opaque string; Core validates no registry. */
    mediaType: nonEmptyString,
    /** Size in bytes. Non-negative integer; a negative size would indicate a producer defect. */
    sizeBytes: z.number().int().min(0).optional(),
    /** Run that produced this artifact (contract §8.1 "an artifact MUST record which stage, run … produced it"). */
    producerRunId: nonEmptyString,
    /** Stage that produced this artifact (contract §8.1). */
    producerStageId: nonEmptyString,
    /**
     * Digests of the inputs this artifact was derived from (contract §8.1 "every stage MUST
     * declare inputs and outputs").
     *
     * This is the edge that makes the lineage queries of contract §20 answerable, and what lets
     * contract §13.1 invalidate downstream approvals when an upstream input changes.
     */
    inputHashes: z.array(sha256Hex).max(4096),
    /** How recoverable this artifact is. @see RECONSTRUCTABILITY */
    reconstructability: z.enum(RECONSTRUCTABILITY),
    /** When the artifact was produced. */
    createdAt: iso8601,
  })
  .meta({
    id: "ArtifactRef",
    title: "ArtifactRef",
    description:
      "A content-addressed reference to a produced artifact (architecture contract §8) — the " +
      "stable boundary between stages. Path and filename are NOT identity (§8.1); `artifactId` " +
      "plus `sha256` are. `kind` is an open string so adopters can introduce artifact kinds " +
      "without changing Core. `reconstructability: irreplaceable` marks artifacts that MUST be " +
      "archived before disposable working files are cleaned (§8.1).",
  });

/** @see artifactRefSchema */
export type ArtifactRef = z.infer<typeof artifactRefSchema>;
