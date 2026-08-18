/**
 * Collision-safe paths.
 *
 * This module exists because of one concrete failure, named in contract §8.1:
 *
 * > Generic names such as `req-00.wav` MUST NOT overwrite accepted audio from another Episode.
 *
 * Contract §1.1 lists "loss or overwrite of accepted audio takes" among the things V1 must
 * reduce. A paid, human-approved take (§13.3) destroyed by a second Episode's identically named
 * working file is unrecoverable — §8 classifies such artifacts `irreplaceable` precisely because
 * no amount of re-running gets them back.
 *
 * The fix is structural rather than a naming convention: **every path this module produces is
 * derived from content or identity, never from the producer's filename.** Contract §8.1 states
 * that a path or filename MUST NOT be treated as identity; the corollary honoured here is that
 * identity must instead determine the path. Two artifacts collide only if they are byte-identical,
 * in which case sharing storage is correct rather than destructive.
 */

import { join } from "node:path";

import { normaliseDigest } from "./digest.js";

/** Directory holding artifact-registry state inside a workspace. */
export const ARTIFACTS_DIRECTORY = "artifacts";

/** File holding the workspace's artifact index. */
export const ARTIFACT_INDEX_FILE = "index.json";

/** Default directory holding archived object bytes. */
export const ARCHIVE_DIRECTORY = "archive";

/** Resource name locking the artifact index. */
export const ARTIFACT_INDEX_LOCK_RESOURCE = "artifact-index";

/**
 * Number of leading digest characters used for each directory shard level.
 *
 * Two levels of two characters gives 256 directories of 256 directories. Flat content-addressed
 * stores degrade badly once a directory holds tens of thousands of entries on some filesystems,
 * and a production run of segmented audio reaches that quickly.
 */
const SHARD_WIDTH = 2;
const SHARD_LEVELS = 2;

/**
 * Path of an object inside a content-addressed store, relative to its root.
 *
 * The digest *is* the path. Nothing the producer chose to call the file participates, so two
 * Episodes both producing `req-00.wav` land in different places whenever their bytes differ —
 * which, for two different recordings, they always do.
 *
 * @throws {AldusError} `ALDUS_DIGEST_MALFORMED` if `sha256` is not a well-formed digest. The
 * check is not decorative: an unvalidated digest reaching a path join is a directory-traversal
 * vector, and digests routinely arrive from files another machine wrote.
 */
export function objectRelativePath(sha256: string): string {
  const digest = normaliseDigest(sha256);
  const segments: string[] = [];
  for (let level = 0; level < SHARD_LEVELS; level += 1) {
    segments.push(digest.slice(level * SHARD_WIDTH, (level + 1) * SHARD_WIDTH));
  }
  segments.push(digest);
  return join(...segments);
}

/** Absolute path of an object within a content-addressed store rooted at `root`. */
export function objectPath(root: string, sha256: string): string {
  return join(root, objectRelativePath(sha256));
}

/**
 * A human-readable filename that still cannot overwrite a different artifact.
 *
 * Content addressing is right for storage but unreadable for a person exporting takes to listen
 * to. This keeps the producer's name for legibility and prefixes a digest fragment for safety,
 * so `req-00.wav` from two Episodes becomes `a3f1c0d2-req-00.wav` and `7b02e918-req-00.wav`.
 *
 * The prefix goes first, not last: a suffix before the extension is easy to lose to a tool that
 * rewrites extensions, and a name that sorts by digest groups nothing usefully anyway.
 *
 * This is a convenience for export and inspection. It is **not** identity, and nothing in the
 * registry reads it back (contract §8.1).
 */
export function readableFileName(sha256: string, preferredName: string, prefixLength = 8): string {
  const digest = normaliseDigest(sha256);
  const safe = sanitiseFileName(preferredName);
  return `${digest.slice(0, prefixLength)}-${safe}`;
}

/**
 * Strip anything from a caller-supplied name that could escape a directory or confuse a shell.
 *
 * Producer filenames reach here from wrapped legacy scripts (contract §3.7) and from files
 * another machine wrote, so they are untrusted. Path separators, `..`, control characters, and
 * leading dots are removed; everything else is left alone so the name stays recognisable.
 */
export function sanitiseFileName(name: string): string {
  const cleaned = name
    .replace(/[/\\]/g, "-")
    // Control characters and DEL. A newline in a filename is not a naming choice; it is an
    // injection against whatever renders the name next.
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\.{2,}/g, ".")
    .replace(/^[.\s]+/, "")
    .replace(/\s+$/, "")
    .slice(0, 200);
  return cleaned.length > 0 ? cleaned : "artifact";
}

/** Paths for one workspace's artifact-registry state. */
export class ArtifactLayout {
  readonly aldusDirectory: string;

  constructor(aldusDirectory: string) {
    this.aldusDirectory = aldusDirectory;
  }

  /** `.aldus/artifacts` */
  artifactsDirectory(): string {
    return join(this.aldusDirectory, ARTIFACTS_DIRECTORY);
  }

  /** `.aldus/artifacts/index.json` — the authoritative artifact list for the workspace. */
  indexPath(): string {
    return join(this.artifactsDirectory(), ARTIFACT_INDEX_FILE);
  }

  /** `.aldus/archive` — default local archive root (contract §8.1, ADR-0007). */
  archiveDirectory(): string {
    return join(this.aldusDirectory, ARCHIVE_DIRECTORY);
  }
}
