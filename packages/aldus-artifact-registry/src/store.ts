/**
 * The `ArtifactStore` port and its file-backed implementation.
 *
 * Contract §7 names `ArtifactStore` among the storage interfaces Core owns, with no members.
 * These are the members. As with WP-02's ports, the interface holds only operations this package
 * actually implements and tests — an aspirational method is worse than an absent one, because a
 * second adapter gets written against it and only discovers at runtime that nothing honours it.
 *
 * Persistence reuses `@aldus/file-store` rather than reimplementing it: `writeFileAtomic` for the
 * durability sequence, `preserveUnknown` for ADR-0004 decision 3, and the workspace's
 * `LockManager` so an artifact registration and a Run update contend properly instead of
 * interleaving.
 */

import { SCHEMA_VERSION, assertSchemaVersionReadable } from "@aldus/core";
import {
  preserveUnknown,
  readFileOrUndefined,
  writeDocument,
  type LockManager,
} from "@aldus/file-store";

import { ArtifactRegistryErrorCodes, artifactRegistryError } from "./errors.js";
import { ARTIFACT_INDEX_LOCK_RESOURCE, ArtifactLayout } from "./paths.js";
import {
  artifactIndexSchema,
  emptyIndex,
  type ArtifactIndex,
  type ArtifactRecord,
} from "./record.js";

/**
 * Durable storage for artifact records (contract §7, §8).
 *
 * There is no `delete`. Contract §15.1 requires rejected takes to be retained with unique
 * identity, and §8.1 requires irreplaceable artifacts to survive cleanup — an interface that
 * cannot express deletion is a stronger guarantee than one that merely declines to use it.
 * Removing working *files* is {@link planCleanup}'s business, and it never removes records.
 */
export interface ArtifactStore {
  /** Every record in the workspace, in registration order. */
  list(): Promise<ArtifactRecord[]>;
  /** One record by `artifactId`, or `undefined`. */
  get(artifactId: string): Promise<ArtifactRecord | undefined>;
  /** Every record whose artifact has this digest. More than one ID may share bytes. */
  findByDigest(sha256: string): Promise<ArtifactRecord[]>;
  /**
   * Add a record that does not yet exist.
   *
   * @throws {AldusError} `ALDUS_ARTIFACT_ID_CONFLICT` if the ID exists with different content.
   */
  add(record: ArtifactRecord): Promise<ArtifactRecord>;
  /**
   * Read, transform, and write one record under the index lock.
   *
   * @throws {AldusError} `ALDUS_ARTIFACT_NOT_FOUND` if the artifact does not exist.
   */
  update(
    artifactId: string,
    mutate: (current: ArtifactRecord) => ArtifactRecord,
  ): Promise<ArtifactRecord>;
}

/**
 * `.aldus/artifacts/index.json` — the authoritative artifact list for a workspace.
 *
 * Held as one document rather than a file per artifact: lineage queries (§20) traverse edges
 * across the whole set, and a query that opened one file per node would make ancestry cost an
 * I/O per hop. The whole index is rewritten atomically on every change, which is correct at the
 * scale contract §5.1 describes — an interactively edited Episode, not a warehouse.
 */
export class FileArtifactStore implements ArtifactStore {
  readonly #layout: ArtifactLayout;
  readonly #locks: LockManager;

  constructor(layout: ArtifactLayout, locks: LockManager) {
    this.#layout = layout;
    this.#locks = locks;
  }

  async list(): Promise<ArtifactRecord[]> {
    const { index } = await this.#read();
    return index.artifacts;
  }

  async get(artifactId: string): Promise<ArtifactRecord | undefined> {
    const { index } = await this.#read();
    return index.artifacts.find((record) => record.artifact.artifactId === artifactId);
  }

  async findByDigest(sha256: string): Promise<ArtifactRecord[]> {
    const { index } = await this.#read();
    return index.artifacts.filter((record) => record.artifact.sha256 === sha256);
  }

  async add(record: ArtifactRecord): Promise<ArtifactRecord> {
    return this.#locks.withLock(ARTIFACT_INDEX_LOCK_RESOURCE, async () => {
      const { index, raw } = await this.#read();
      const existing = index.artifacts.find(
        (candidate) => candidate.artifact.artifactId === record.artifact.artifactId,
      );

      if (existing !== undefined) {
        // Re-registering identical content is a harmless retry; rebinding an ID to different
        // bytes would silently redirect every approval that referenced it (§8.1, §13).
        if (existing.artifact.sha256 === record.artifact.sha256) return existing;
        throw artifactRegistryError(
          ArtifactRegistryErrorCodes.ARTIFACT_ID_CONFLICT,
          "This artifact ID is already registered against different content. An artifact's " +
            "identity is its ID together with its digest (§8.1), so rebinding the ID would " +
            "redirect every approval that referenced it.",
          {
            category: "conflict",
            retryable: false,
            details: {
              artifactId: record.artifact.artifactId,
              registeredDigest: existing.artifact.sha256,
              offeredDigest: record.artifact.sha256,
            },
          },
        );
      }

      const next: ArtifactIndex = {
        ...index,
        schemaVersion: SCHEMA_VERSION,
        artifacts: [...index.artifacts, record],
      };
      await this.#write(next, index, raw);
      return record;
    });
  }

  async update(
    artifactId: string,
    mutate: (current: ArtifactRecord) => ArtifactRecord,
  ): Promise<ArtifactRecord> {
    return this.#locks.withLock(ARTIFACT_INDEX_LOCK_RESOURCE, async () => {
      const { index, raw } = await this.#read();
      const position = index.artifacts.findIndex(
        (record) => record.artifact.artifactId === artifactId,
      );
      const current = index.artifacts[position];
      if (position === -1 || current === undefined) {
        throw artifactRegistryError(
          ArtifactRegistryErrorCodes.ARTIFACT_NOT_FOUND,
          "No artifact is registered under this ID, so there is nothing to update.",
          { category: "not_found", retryable: false, details: { artifactId } },
        );
      }

      const updated = mutate(current);
      if (updated.artifact.artifactId !== artifactId) {
        throw artifactRegistryError(
          ArtifactRegistryErrorCodes.ARTIFACT_ID_CONFLICT,
          "An update may not change an artifact's ID. Identity is not editable (§8.1); register " +
            "a new artifact and supersede this one instead.",
          {
            category: "conflict",
            retryable: false,
            details: { artifactId, attempted: updated.artifact.artifactId },
          },
        );
      }

      const artifacts = [...index.artifacts];
      artifacts[position] = updated;
      await this.#write({ ...index, schemaVersion: SCHEMA_VERSION, artifacts }, index, raw);
      return updated;
    });
  }

  /** Read and validate the index, treating an absent file as an empty registry. */
  async #read(): Promise<{ index: ArtifactIndex; raw: unknown }> {
    const contents = await readFileOrUndefined(this.#layout.indexPath());
    if (contents === undefined || contents.trim().length === 0) {
      return { index: emptyIndex(), raw: undefined };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch {
      throw artifactRegistryError(
        ArtifactRegistryErrorCodes.REGISTRY_MALFORMED,
        "The artifact index is not valid JSON. Atomic writes make a torn file impossible, so " +
          "this means it was edited or replaced by something other than the registry.",
        {
          category: "io",
          retryable: false,
          // Contents withheld: provenance may carry redacted-but-sensitive context (§19.2), and
          // an error is itself durable.
          details: { path: this.#layout.indexPath(), byteLength: contents.length },
        },
      );
    }

    if (typeof parsed === "object" && parsed !== null && "schemaVersion" in parsed) {
      const declared = (parsed as { schemaVersion: unknown }).schemaVersion;
      // A differing major means a field was removed, renamed, or changed meaning (ADR-0003).
      // Reporting that plainly beats a pile of field errors that never names the real cause.
      if (typeof declared === "string") assertSchemaVersionReadable(declared);
    }

    const result = artifactIndexSchema.safeParse(parsed);
    if (!result.success) {
      throw artifactRegistryError(
        ArtifactRegistryErrorCodes.REGISTRY_MALFORMED,
        "The artifact index is valid JSON but does not match the registry schema.",
        {
          category: "io",
          retryable: false,
          details: {
            path: this.#layout.indexPath(),
            // Paths and codes only, never received values (§19.2).
            issues: result.error.issues.map((issue) => ({
              path: issue.path.join("."),
              code: issue.code,
            })),
          },
        },
      );
    }

    return { index: result.data, raw: parsed };
  }

  /**
   * Write the index, preserving properties a newer build wrote (ADR-0004 decision 3).
   *
   * Zod strips unknown properties, so without this an older build that registered one artifact
   * would silently delete every field a newer schema version had added to every *other* record
   * in the file.
   *
   * The merge is by `artifactId`, not by array position. `preserveUnknown` merges arrays
   * element-wise only when the lengths match, and deliberately takes the new value wholesale
   * otherwise — correct for a positional array, where a changed length means indices no longer
   * denote the same records. But this array is keyed: adding an artifact changes its length on
   * every single write, so relying on positional merging would mean preservation never happened
   * at all here. Matching on identity restores it, and is sound precisely because `artifactId`
   * is immutable (§8.1) and `update` refuses to change it.
   */
  async #write(next: ArtifactIndex, original: ArtifactIndex, raw: unknown): Promise<void> {
    await writeDocument(this.#layout.indexPath(), this.#merge(next, original, raw));
  }

  /** Merge `next` over the raw stored document, matching artifacts by ID. */
  #merge(next: ArtifactIndex, original: ArtifactIndex, raw: unknown): unknown {
    if (raw === undefined || typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return next;
    }
    const rawIndex = raw as Record<string, unknown>;
    const rawArtifacts = Array.isArray(rawIndex["artifacts"]) ? rawIndex["artifacts"] : [];

    const rawById = new Map<string, unknown>();
    for (const entry of rawArtifacts) {
      const id = artifactIdOf(entry);
      if (id !== undefined) rawById.set(id, entry);
    }
    const originalById = new Map(
      original.artifacts.map((record) => [record.artifact.artifactId, record]),
    );

    const artifacts = next.artifacts.map((record) => {
      const id = record.artifact.artifactId;
      const rawRecord = rawById.get(id);
      const originalRecord = originalById.get(id);
      // A record this build has never seen on disk has nothing to preserve.
      if (rawRecord === undefined || originalRecord === undefined) return record;
      return preserveUnknown(rawRecord, originalRecord, record);
    });

    // Unknown *top-level* keys are preserved the same way, so a newer build's index-level field
    // survives too. `artifacts` is replaced by the merge above rather than merged positionally.
    const merged: Record<string, unknown> = {};
    for (const key of Object.keys(rawIndex)) {
      if (!(key in original)) merged[key] = rawIndex[key];
    }
    return { ...merged, ...next, artifacts };
  }
}

/** The `artifactId` of a raw stored entry, or `undefined` if it lacks the expected shape. */
function artifactIdOf(entry: unknown): string | undefined {
  if (typeof entry !== "object" || entry === null) return undefined;
  const artifact = (entry as { artifact?: unknown }).artifact;
  if (typeof artifact !== "object" || artifact === null) return undefined;
  const id = (artifact as { artifactId?: unknown }).artifactId;
  return typeof id === "string" ? id : undefined;
}
