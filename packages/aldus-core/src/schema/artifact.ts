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
export const artifactRefSchemaBase = z
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
     *
     * It also answers a question a `SubjectsProvider` needs and nothing else can answer: **is
     * this report a report of the thing being approved?** A gate that binds a review — a QA
     * report, a checkup, a lint result — is otherwise satisfiable by a review of an earlier
     * draft: the reviewed document changes, the report does not, and the gate stays satisfied on
     * a judgement about bytes that no longer exist.
     *
     * Publishing such a report as a subject only when its `inputHashes` name the current document
     * closes that, and does so **without the report's cooperation**. The digest lives here rather
     * than inside the report, so it works for a format that has nowhere to put one — a Markdown
     * review written by an agent cannot state what it reviewed, but the stage that produced it
     * declared what it read. A report that asserts its own subject digest can drift from the
     * bytes it describes; this cannot, because it is not the report making the claim.
     *
     * An adopter arrived at this after solving the same problem twice, the second time worse, and
     * the property is recorded here rather than left to be rediscovered a third time.
     */
    inputHashes: z.array(sha256Hex).max(4096),
    /**
     * What produced these bytes (contract §8.1, §20).
     *
     * Provenance pinned every **input** — the prompt's digest, the subject's digest, the knowledge
     * pack versions — and nothing about the producer beyond `producerStageId`. So the same inputs
     * through a later model, renderer or Worker binary yield different bytes and **no field
     * distinguishes the two records.**
     *
     * The Runtime had already decided this evidence is worth keeping, for money rather than for
     * artifacts: `AgentBackend.version` is required because "a spend reservation records which
     * version was dispatched under an enforced ceiling, and that evidence must not be
     * reconstructed by re-reading today's capabilities". A producer that behaves one way now says
     * nothing about bytes an earlier version wrote, which is the same argument about the same
     * evidence, and it was kept on the reservation and dropped on the artifact.
     *
     * **Opaque to Core** (§4.2). Not "model" — that is provider-shaped, and the concept generalises
     * past agents to a renderer binary or an embedded font, which is what makes it belong here.
     *
     * **A list, because one execution can have several producers.** Measured by an adopter: an
     * agent CLI reports `modelUsage` as a map keyed by model, and a delegating execution reports
     * more than one. A single `{ id, version }` would force a caller to pick one, and the choice
     * would be invisible in the record — a guess that reads as a fact. It costs nothing when there
     * is one.
     *
     * Optional because making it required would invalidate every stored record. **Its absence is a
     * hole, not a statement that nothing produced the artifact** — see
     * {@link producerProvenanceGap}, which exists so the hole is queryable rather than silent.
     * An empty list is refused: it would assert that nothing produced the bytes.
     */
    producers: z
      .array(
        z.object({
          /** Who produced it, e.g. an agent backend or a renderer. An open string; Core names none. */
          id: nonEmptyString,
          /**
           * Which version of it ran.
           *
           * @see ArtifactRef.producer.versionEvidence — a version that was *asked for* is not
           * evidence of the version that ran, and recording one as the other is the failure this
           * field exists to prevent, one level down.
           */
          version: nonEmptyString,
          /**
           * Whether `version` is what the producer **reported**, or only what was **requested** of it.
           *
           * A caller that passes `--model opus` and records `opus` has recorded a request. If the
           * producer silently served something else, that record is false in exactly the way an
           * absent field is not — and a false provenance is worse than a missing one, because it
           * reads as evidence.
           *
           * So the weaker state is representable rather than guessed, the same way `billing_unknown`
           * is. Record `"requested"` when that is all that is knowable; do not launder it into
           * `"reported"`.
           */
          versionEvidence: z.enum(["reported", "requested"]),
        }),
      )
      .min(1)
      .max(64)
      .optional(),
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
export type ArtifactRef = z.infer<typeof artifactRefSchemaBase>;

/**
 * Why an artifact's producer provenance is incomplete, or `undefined` if it is not.
 *
 * An optional field nobody fills is decoration, and decoration is worse than an absent field
 * because it reads as coverage. This makes the hole **queryable** rather than silent: an operator
 * or a promotion policy can ask, rather than discovering three months later that the one document
 * they needed to reproduce does not say what wrote it.
 *
 * The judgement it does not make: **whether a missing producer matters here.** That depends on
 * `reconstructability`, and this reports the gap for any artifact rather than deciding for the
 * caller which gaps are tolerable. A `reproducible` artifact whose producer is unrecorded can be
 * regenerated and compared; a `source` one cannot, which is why the message says so.
 *
 * What it cannot check, stated because a predicate implying otherwise would be the drift this
 * whole field exists to close: whether a recorded producer is **true**. `id: "x", version: "y",
 * versionEvidence: "reported"` passes. It checks that the question was answered.
 */
export function producerProvenanceGap(artifact: ArtifactRef): string | undefined {
  if (artifact.producers !== undefined) return undefined;
  return artifact.reconstructability === "source"
    ? "No producer recorded, and these bytes cannot be regenerated: nothing distinguishes this " +
        "artifact from one the same inputs would yield through a different producer version."
    : "No producer recorded. These bytes can be regenerated, so the gap is recoverable by " +
        "reproducing them — but not by reading this record.";
}
