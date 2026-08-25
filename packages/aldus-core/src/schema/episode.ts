/**
 * Episode identity (architecture contract §6.1).
 */

import { z } from "zod";
import { nonEmptyString, schemaVersionString } from "./common.js";

/**
 * The durable content identity (contract §6.1).
 *
 * Contract §6.1: "An Episode is the durable content identity. It is not a folder and not an
 * execution attempt." Episode and execution state are separated precisely so that re-running,
 * repairing, or abandoning a Run never changes what the content *is*.
 *
 * Field list is transcribed verbatim from contract §6.1.
 */
export const episodeRefSchemaBase = z
  .object({
    /** Schema version of this record (ADR-0003). */
    schemaVersion: schemaVersionString,
    /**
     * Canonical Episode identity.
     *
     * Contract §6.1 gives `show:{show-id}:episode:{episode-slug}` and
     * `series:{series-id}:edition:{edition-id}` as example forms. Validated as a non-empty
     * string rather than pinned to one grammar: contract §25 item 5 leaves canonical Episode ID
     * rules for adopter history open, and hard-coding a grammar here would pre-empt that ADR
     * and orphan every legacy identity that does not match.
     */
    episodeId: nonEmptyString,
    /**
     * Identity of the show this Episode belongs to.
     *
     * An open string. Contract §4.2 states Core does not own show identities.
     */
    showId: nonEmptyString,
    /** Human-readable title. Display only; never identity. */
    title: nonEmptyString.optional(),
    /**
     * Pointer to a pre-Aldus identity for this content (contract §4.3 "mappings between legacy
     * episode paths and canonical Aldus identities").
     *
     * Opaque to Core: its meaning belongs to the adopter integration that wrote it.
     */
    legacyRef: nonEmptyString.optional(),
  })
  .meta({
    id: "EpisodeRef",
    title: "EpisodeRef",
    description:
      "The durable content identity (architecture contract §6.1). Not a folder and not an " +
      "execution attempt — Runs come and go, the Episode does not. `episodeId` is validated as " +
      "a non-empty string rather than a fixed grammar because contract §25 item 5 leaves " +
      "canonical Episode ID rules open.",
  });

/** @see episodeRefSchema */
export type EpisodeRef = z.infer<typeof episodeRefSchemaBase>;
