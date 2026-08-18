/**
 * Artifact archival.
 *
 * Contract §8.1: "Irreplaceable artifacts MUST be archived before disposable working files are
 * cleaned." Contract §25 item 4 leaves the archive *target* open. ADR-0007 settles it for V1: a
 * local content-addressed directory, behind an adapter interface so a remote archive can replace
 * it without touching a caller.
 *
 * Contract §4.2 forbids naming a cloud or storage service, so nothing here does. An archive is
 * identified by an opaque `archiveId` the adapter chooses.
 *
 * What "archived" means, precisely:
 *
 * 1. the bytes are stored addressed by their own digest, so nothing else can overwrite them;
 * 2. the stored bytes are **read back and re-hashed**, so the receipt records a verified fact
 *    rather than a hopeful one;
 * 3. the operation is idempotent — archiving bytes already present verifies and returns, rather
 *    than rewriting.
 *
 * A failed archive produces no receipt. That direction is deliberate: an artifact with no receipt
 * is treated as unarchived, and an unarchived irreplaceable artifact blocks cleanup. Failure
 * therefore fails *safe*, toward retaining bytes rather than toward deleting them.
 */

import { copyFile, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { sha256Bytes, sha256File, normaliseDigest } from "./digest.js";
import { ArtifactRegistryErrorCodes, artifactRegistryError } from "./errors.js";
import { objectPath } from "./paths.js";
import type { ArchiveReceipt } from "./record.js";

/** What a caller hands the archive: bytes to take custody of, and the digest they must have. */
export interface ArchiveRequest {
  /** Path to the bytes on the local filesystem. */
  sourcePath: string;
  /** Digest the bytes are expected to have. Verified, never trusted. */
  sha256: string;
  /** ISO-8601 timestamp for the receipt. Supplied so archival is deterministic under test. */
  now: string;
}

/**
 * A place irreplaceable artifacts are kept (contract §8.1, §25 item 4).
 *
 * Deliberately narrow. An archive takes custody of bytes, says whether it holds them, and hands
 * them back — it does not enumerate, expire, or reason about artifacts, because those are the
 * registry's job and a remote archive would implement them badly.
 */
export interface ArtifactArchive {
  /** Opaque identity of this archive, recorded on every receipt. */
  readonly archiveId: string;
  /** Whether the archive already holds bytes with this digest. */
  has(sha256: string): Promise<boolean>;
  /**
   * Take custody of bytes, verifying them after the write.
   *
   * Idempotent: if the digest is already held and verifies, the existing object is kept and a
   * receipt returned without rewriting.
   *
   * @throws {AldusError} `ALDUS_DIGEST_MISMATCH` if the source does not hash to the declared
   * digest, `ALDUS_ARCHIVE_FAILED` if the bytes could not be stored, or `ALDUS_ARCHIVE_CORRUPT`
   * if what was read back does not match what was written.
   */
  put(request: ArchiveRequest): Promise<ArchiveReceipt>;
  /** Read archived bytes back. */
  read(sha256: string): Promise<Uint8Array>;
  /** Where the archive holds this digest, or `undefined` if it does not. */
  locate(sha256: string): Promise<string | undefined>;
}

/* -------------------------------------------------------------------------------------------
 * Local directory archive
 * ---------------------------------------------------------------------------------------- */

/** Options for {@link LocalDirectoryArchive}. */
export interface LocalDirectoryArchiveOptions {
  /** Overrides the default `archiveId`. */
  archiveId?: string;
}

/**
 * A content-addressed archive in a local directory (ADR-0007).
 *
 * Objects live at `<root>/<aa>/<bb>/<digest>`, so the path is a pure function of the content.
 * Two Episodes producing identically named files cannot collide unless the bytes are identical,
 * and identical bytes are the one case where sharing storage is correct.
 *
 * Writes go to a temp file in the destination directory and are renamed, for the same reason the
 * file store does it (contract §19.1): a rename is atomic within a filesystem, so a reader never
 * observes a half-copied object, and a crash mid-archive leaves no partial object that a later
 * `has()` would mistake for custody.
 */
export class LocalDirectoryArchive implements ArtifactArchive {
  readonly archiveId: string;
  readonly #root: string;

  constructor(root: string, options: LocalDirectoryArchiveOptions = {}) {
    this.#root = root;
    this.archiveId = options.archiveId ?? "local-directory";
  }

  /** Root directory holding archived objects. */
  get root(): string {
    return this.#root;
  }

  async has(sha256: string): Promise<boolean> {
    return (await this.locate(sha256)) !== undefined;
  }

  async locate(sha256: string): Promise<string | undefined> {
    const path = objectPath(this.#root, sha256);
    try {
      const stats = await stat(path);
      return stats.isFile() ? path : undefined;
    } catch {
      return undefined;
    }
  }

  async put(request: ArchiveRequest): Promise<ArchiveReceipt> {
    const digest = normaliseDigest(request.sha256);

    // Verify the source before storing it. Storing bytes under a digest they do not have would
    // create an archive that lies, and every later verification would pass against the wrong key.
    let sourceDigest: string;
    try {
      sourceDigest = await sha256File(request.sourcePath);
    } catch (error) {
      // An unreadable source is an archive failure, not a raw filesystem error escaping the
      // package. Callers branch on `code`, and a bare ENOENT here would be the one path in this
      // package that produced an unstructured failure.
      throw artifactRegistryError(
        ArtifactRegistryErrorCodes.ARCHIVE_FAILED,
        "The bytes offered for archival could not be read, so the archive took no custody and " +
          "issued no receipt. The artifact remains unarchived.",
        {
          category: "io",
          retryable: true,
          details: {
            sourcePath: request.sourcePath,
            reason: error instanceof Error ? error.message : "unknown",
          },
        },
      );
    }

    if (sourceDigest !== digest) {
      throw artifactRegistryError(
        ArtifactRegistryErrorCodes.DIGEST_MISMATCH,
        "The bytes offered for archival do not hash to the digest declared for them, so the " +
          "archive would be storing them under an identity they do not have.",
        {
          category: "validation",
          retryable: false,
          details: { sourcePath: request.sourcePath, declared: digest, actual: sourceDigest },
        },
      );
    }

    const destination = objectPath(this.#root, digest);

    const existing = await this.locate(digest);
    if (existing !== undefined) {
      // Already held. Verify rather than assume: an archive that reports custody of bytes it has
      // silently lost is worse than one that reports nothing, because §8.1's cleanup gate trusts
      // this answer before deleting the only other copy.
      await this.#verifyStored(digest, destination);
      const stats = await stat(destination);
      return this.#receipt(digest, destination, stats.size, request.now);
    }

    await mkdir(dirname(destination), { recursive: true });
    const temporary = `${destination}.${process.pid}.tmp`;
    try {
      await copyFile(request.sourcePath, temporary);
      await rename(temporary, destination);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw artifactRegistryError(
        ArtifactRegistryErrorCodes.ARCHIVE_FAILED,
        "The archive could not take custody of these bytes. No receipt was issued, so the " +
          "artifact remains unarchived and cleanup will continue to refuse to remove it.",
        {
          category: "io",
          retryable: true,
          details: {
            sourcePath: request.sourcePath,
            sha256: digest,
            reason: error instanceof Error ? error.message : "unknown",
          },
        },
      );
    }

    await this.#verifyStored(digest, destination);
    const stats = await stat(destination);
    return this.#receipt(digest, destination, stats.size, request.now);
  }

  async read(sha256: string): Promise<Uint8Array> {
    const path = await this.locate(sha256);
    if (path === undefined) {
      throw artifactRegistryError(
        ArtifactRegistryErrorCodes.ARTIFACT_NOT_FOUND,
        "The archive does not hold an object with this digest.",
        { category: "not_found", retryable: false, details: { sha256, archiveId: this.archiveId } },
      );
    }
    return readFile(path);
  }

  /** Re-hash what was stored, so a receipt records a verified fact. */
  async #verifyStored(digest: string, path: string): Promise<void> {
    const stored = await sha256File(path);
    if (stored !== digest) {
      throw artifactRegistryError(
        ArtifactRegistryErrorCodes.ARCHIVE_CORRUPT,
        "Bytes read back from the archive do not match the digest they are stored under. The " +
          "archived copy is corrupt and must not be relied on.",
        { category: "io", retryable: false, details: { path, expected: digest, actual: stored } },
      );
    }
  }

  #receipt(digest: string, path: string, sizeBytes: number, now: string): ArchiveReceipt {
    return {
      archiveId: this.archiveId,
      uri: pathToFileURL(path).href,
      sha256: digest,
      sizeBytes,
      archivedAt: now,
      verified: true,
    };
  }
}

/* -------------------------------------------------------------------------------------------
 * In-memory archive
 * ---------------------------------------------------------------------------------------- */

/**
 * An archive holding objects in memory.
 *
 * This exists to prove the {@link ArtifactArchive} seam is real. Contract §21 lists "at least one
 * alternative adapter or test double proves substitutability" among the criteria for extracting
 * Aldus as an open runtime, and an interface with exactly one implementation has never been shown
 * to be an interface at all. It is also what lets a test exercise archival without touching a
 * filesystem.
 *
 * Not durable, and therefore never a legitimate archive for an `irreplaceable` artifact in
 * production — the whole point of §8.1's rule is surviving the loss of working files.
 */
export class MemoryArtifactArchive implements ArtifactArchive {
  readonly archiveId: string;
  readonly #objects = new Map<string, Uint8Array>();

  constructor(archiveId = "memory") {
    this.archiveId = archiveId;
  }

  async has(sha256: string): Promise<boolean> {
    return this.#objects.has(normaliseDigest(sha256));
  }

  async locate(sha256: string): Promise<string | undefined> {
    const digest = normaliseDigest(sha256);
    return this.#objects.has(digest) ? `memory:${this.archiveId}/${digest}` : undefined;
  }

  async put(request: ArchiveRequest): Promise<ArchiveReceipt> {
    const digest = normaliseDigest(request.sha256);
    let bytes: Uint8Array;
    try {
      bytes = await readFile(request.sourcePath);
    } catch (error) {
      throw artifactRegistryError(
        ArtifactRegistryErrorCodes.ARCHIVE_FAILED,
        "The bytes offered for archival could not be read, so the archive took no custody and " +
          "issued no receipt.",
        {
          category: "io",
          retryable: true,
          details: {
            sourcePath: request.sourcePath,
            reason: error instanceof Error ? error.message : "unknown",
          },
        },
      );
    }
    const actual = sha256Bytes(bytes);
    if (actual !== digest) {
      throw artifactRegistryError(
        ArtifactRegistryErrorCodes.DIGEST_MISMATCH,
        "The bytes offered for archival do not hash to the digest declared for them.",
        {
          category: "validation",
          retryable: false,
          details: { sourcePath: request.sourcePath, declared: digest, actual },
        },
      );
    }

    const held = this.#objects.get(digest);
    if (held === undefined) this.#objects.set(digest, bytes);

    const stored = this.#objects.get(digest) ?? bytes;
    if (sha256Bytes(stored) !== digest) {
      throw artifactRegistryError(
        ArtifactRegistryErrorCodes.ARCHIVE_CORRUPT,
        "Bytes read back from the archive do not match the digest they are stored under.",
        { category: "io", retryable: false, details: { sha256: digest } },
      );
    }

    return {
      archiveId: this.archiveId,
      uri: `memory:${this.archiveId}/${digest}`,
      sha256: digest,
      sizeBytes: stored.byteLength,
      archivedAt: request.now,
      verified: true,
    };
  }

  async read(sha256: string): Promise<Uint8Array> {
    const digest = normaliseDigest(sha256);
    const bytes = this.#objects.get(digest);
    if (bytes === undefined) {
      throw artifactRegistryError(
        ArtifactRegistryErrorCodes.ARTIFACT_NOT_FOUND,
        "The archive does not hold an object with this digest.",
        { category: "not_found", retryable: false, details: { sha256: digest } },
      );
    }
    return bytes;
  }
}

/** Extract a filesystem path from a `file:` URI, or return `undefined` for any other scheme. */
export function localPathFromUri(uri: string): string | undefined {
  if (!uri.startsWith("file:")) return undefined;
  try {
    return new URL(uri).pathname;
  } catch {
    return undefined;
  }
}

/** Join a directory and a name, exported so callers can build export paths without `node:path`. */
export function joinPath(directory: string, name: string): string {
  return join(directory, name);
}

/** Write bytes to a path, creating parents. Used when exporting an artifact for inspection. */
export async function writeBytes(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
}
