/**
 * The artifact registry (contract §22 WP-03, §8).
 *
 * One object a caller binds to a workspace, wiring the store, the archive, lineage, and cleanup
 * policy together. Contract §19.2 requires workspace binding to be explicit; constructing this
 * is that binding.
 *
 * The registry is the authoritative list of artifacts for a workspace. Contract §7's per-run
 * `artifacts.json` is a per-run materialized view a stage runner (WP-04) may maintain; this
 * package deliberately does not write it, because keeping two lists in step without a
 * transaction is how they diverge — and §3.4 makes the durable record authoritative, so two
 * disagreeing durable records is the worst available outcome.
 */

import { unlink } from "node:fs/promises";

import {
  SCHEMA_VERSION,
  assertValid,
  newArtifactId,
  type ArtifactRef,
  type Reconstructability,
} from "@aldus/core";
import { WorkspaceLayout, type LockManager } from "@aldus/file-store";

import { LocalDirectoryArchive, localPathFromUri, type ArtifactArchive } from "./archive.js";
import { planCleanup, type CleanupPlan } from "./cleanup.js";
import { digestFile, verifyFileDigest } from "./digest.js";
import { ArtifactRegistryErrorCodes, artifactRegistryError } from "./errors.js";
import { LineageGraph } from "./lineage.js";
import { ArtifactLayout } from "./paths.js";
import {
  artifactProvenanceSchema,
  artifactRecordSchema,
  type ArtifactProvenance,
  type ArtifactRecord,
} from "./record.js";
import { FileArtifactStore, type ArtifactStore } from "./store.js";

/** Everything a producer must state to register an artifact (contract §8, §8.1). */
export interface RegisterArtifactInput {
  /** Path to the produced bytes. Hashed and sized by the registry, never trusted from the caller. */
  path: string;
  /** What kind of artifact this is (contract §8.2). Open string; Core names no taxonomy (§4.2). */
  kind: string;
  /** IANA media type of the bytes. */
  mediaType: string;
  /** Run that produced it (contract §8.1). */
  producerRunId: string;
  /** Stage that produced it (contract §8.1). */
  producerStageId: string;
  /** How recoverable it is (contract §8). */
  reconstructability: Reconstructability;
  /**
   * Digests of the inputs it was derived from (contract §8.1).
   *
   * Defaults to none. An empty list is a real state — an `EpisodeBrief` is derived from nothing
   * inside the runtime — so it is not treated as a missing declaration.
   */
  inputHashes?: string[];
  /**
   * Code revision, configuration, and seed (contract §8.1).
   *
   * Required, not optional. §8.1 says an artifact MUST record which stage, run, code revision,
   * and configuration produced it; making the parameter mandatory is how that becomes enforced
   * rather than merely documented. Its own fields are individually optional, so a wrapped legacy
   * script (§3.7) that genuinely knows none of them passes `{}` — an explicit "nothing known",
   * which is honest, rather than a silently omitted argument.
   */
  provenance: ArtifactProvenance;
  /** Artifact ID to use. Defaults to a freshly minted one. */
  artifactId?: string;
  /** URI recorded as the artifact's current location. Defaults to a `file:` URI for `path`. */
  uri?: string;
  /** ISO-8601 production timestamp. Defaults to now. */
  createdAt?: string;
}

/** Options for {@link ArtifactRegistry}. */
export interface ArtifactRegistryOptions {
  /** Where irreplaceable bytes are kept. Defaults to a local archive under `.aldus/archive`. */
  archive?: ArtifactArchive;
  /** Clock, injected so registration is deterministic under test. */
  now?: () => Date;
}

/** Result of removing working files after a cleanup plan. */
export interface CleanupOutcome {
  /** Artifacts whose working file was removed. */
  removed: ArtifactRecord[];
  /** Artifacts whose working file was already absent. */
  alreadyAbsent: ArtifactRecord[];
}

/** The artifact registry for one workspace. */
export class ArtifactRegistry {
  readonly store: ArtifactStore;
  readonly archive: ArtifactArchive;
  readonly layout: ArtifactLayout;
  readonly #now: () => Date;

  constructor(workspaceRoot: string, locks: LockManager, options: ArtifactRegistryOptions = {}) {
    const workspace = new WorkspaceLayout(workspaceRoot);
    this.layout = new ArtifactLayout(workspace.aldusDirectory);
    this.store = new FileArtifactStore(this.layout, locks);
    this.archive = options.archive ?? new LocalDirectoryArchive(this.layout.archiveDirectory());
    this.#now = options.now ?? (() => new Date());
  }

  /**
   * Hash a produced file, collect its metadata, and record it.
   *
   * The digest is computed here rather than accepted from the caller. Contract §8.1 makes
   * `sha256` half of an artifact's identity and §13 binds approvals to it, so a caller-supplied
   * digest would let a producer bug or a stale value bind an approval to bytes nobody checked.
   */
  async register(input: RegisterArtifactInput): Promise<ArtifactRecord> {
    const { sha256, sizeBytes } = await digestFile(input.path);
    const provenance = artifactProvenanceSchema.parse(input.provenance);

    const artifact: ArtifactRef = {
      schemaVersion: SCHEMA_VERSION,
      artifactId: input.artifactId ?? newArtifactId(),
      kind: input.kind,
      uri: input.uri ?? pathToUri(input.path),
      sha256,
      mediaType: input.mediaType,
      sizeBytes,
      producerRunId: input.producerRunId,
      producerStageId: input.producerStageId,
      inputHashes: input.inputHashes ?? [],
      reconstructability: input.reconstructability,
      createdAt: input.createdAt ?? this.#now().toISOString(),
    };

    // Validate against Core before storing. The registry is a writer of ArtifactRefs, and a
    // record that fails Core's schema would be unreadable by every other package.
    assertValid("ArtifactRef", artifact);

    const record: ArtifactRecord = artifactRecordSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      artifact,
      provenance,
      registeredAt: this.#now().toISOString(),
    });

    return this.store.add(record);
  }

  /** One record by ID. */
  async get(artifactId: string): Promise<ArtifactRecord | undefined> {
    return this.store.get(artifactId);
  }

  /**
   * One record by ID, or a failure.
   *
   * @throws {AldusError} `ALDUS_ARTIFACT_NOT_FOUND`
   */
  async require(artifactId: string): Promise<ArtifactRecord> {
    const record = await this.store.get(artifactId);
    if (record === undefined) {
      throw artifactRegistryError(
        ArtifactRegistryErrorCodes.ARTIFACT_NOT_FOUND,
        "No artifact is registered under this ID.",
        { category: "not_found", retryable: false, details: { artifactId } },
      );
    }
    return record;
  }

  /**
   * Records holding a digest (contract §8.1 "approved artifacts MUST be addressed by ID and
   * hash").
   *
   * Returns a list, not one record: identical bytes registered by two Runs are two artifacts
   * that happen to share content, and collapsing them would lose the provenance distinguishing
   * them.
   */
  async findByDigest(sha256: string): Promise<ArtifactRecord[]> {
    return this.store.findByDigest(sha256);
  }

  /** Every record produced by one Run. */
  async listByRun(runId: string): Promise<ArtifactRecord[]> {
    const records = await this.store.list();
    return records.filter((record) => record.artifact.producerRunId === runId);
  }

  /** Every record in the workspace. */
  async list(): Promise<ArtifactRecord[]> {
    return this.store.list();
  }

  /** A lineage graph over the whole registry (contract §20). */
  async lineage(): Promise<LineageGraph> {
    return new LineageGraph(await this.store.list());
  }

  /**
   * Verify that an artifact's working file still holds the bytes it was registered with.
   *
   * @throws {AldusError} `ALDUS_DIGEST_MISMATCH` if the file has changed.
   */
  async verify(artifactId: string): Promise<void> {
    const record = await this.require(artifactId);
    const path = localPathFromUri(record.artifact.uri);
    if (path === undefined) {
      throw artifactRegistryError(
        ArtifactRegistryErrorCodes.ARTIFACT_NOT_FOUND,
        "This artifact's URI is not a local file, so the registry cannot re-read its bytes.",
        {
          category: "not_found",
          retryable: false,
          details: { artifactId, uri: record.artifact.uri },
        },
      );
    }
    await verifyFileDigest(path, record.artifact.sha256);
  }

  /**
   * Take archival custody of an artifact's bytes (contract §8.1).
   *
   * Idempotent: an artifact already archived under the same digest returns its existing record
   * without re-copying.
   */
  async archiveArtifact(artifactId: string): Promise<ArtifactRecord> {
    const record = await this.require(artifactId);
    if (record.archive !== undefined && record.archive.sha256 === record.artifact.sha256) {
      return record;
    }

    const path = localPathFromUri(record.artifact.uri);
    if (path === undefined) {
      throw artifactRegistryError(
        ArtifactRegistryErrorCodes.ARCHIVE_FAILED,
        "This artifact's URI is not a local file, so there are no local bytes to archive. A " +
          "remote-to-remote transfer needs an archive adapter that can reach the source.",
        {
          category: "io",
          retryable: false,
          details: { artifactId, uri: record.artifact.uri },
        },
      );
    }

    const receipt = await this.archive.put({
      sourcePath: path,
      sha256: record.artifact.sha256,
      now: this.#now().toISOString(),
    });

    return this.store.update(artifactId, (current) => ({ ...current, archive: receipt }));
  }

  /**
   * Archive every irreplaceable artifact that is not yet archived.
   *
   * The operation an operator actually wants before cleaning a workspace: §8.1's ordering stated
   * as one call, so the safe path is the easy one.
   */
  async archiveIrreplaceable(): Promise<ArtifactRecord[]> {
    const records = await this.store.list();
    const pending = records.filter(
      (record) =>
        record.artifact.reconstructability === "irreplaceable" && record.archive === undefined,
    );
    const archived: ArtifactRecord[] = [];
    for (const record of pending) {
      archived.push(await this.archiveArtifact(record.artifact.artifactId));
    }
    return archived;
  }

  /**
   * Record that one artifact replaces another (contract §15.1).
   *
   * The superseded record is retained, never deleted: §15.1 requires rejected takes to keep a
   * unique identity until retention policy allows cleanup, and a rejected take is evidence of
   * what was tried. Which take is *accepted* is a §13.3 human decision owned by WP-05 and WP-07;
   * this only records the replacement edge.
   */
  async supersede(supersededId: string, replacementId: string): Promise<ArtifactRecord> {
    await this.require(replacementId);
    return this.store.update(supersededId, (current) => ({
      ...current,
      supersededBy: replacementId,
    }));
  }

  /** Decide what a cleanup may remove, without removing anything (contract §8.1). */
  async planCleanup(candidateArtifactIds: readonly string[]): Promise<CleanupPlan> {
    return planCleanup(candidateArtifactIds, await this.store.list());
  }

  /**
   * Remove the working files of a plan, refusing if anything is blocked.
   *
   * Refuses rather than skipping. A cleanup that quietly omitted the blocked files would report
   * success while leaving the operator believing the workspace was tidy, and the next cleanup
   * would face the same silent omission. Registry records are never removed — only working
   * files, and only ones the plan cleared.
   *
   * @throws {AldusError} `ALDUS_CLEANUP_BLOCKED`
   */
  async executeCleanup(plan: CleanupPlan): Promise<CleanupOutcome> {
    if (!plan.safe) {
      throw artifactRegistryError(
        ArtifactRegistryErrorCodes.CLEANUP_BLOCKED,
        `Cleanup refused: ${plan.blocked.length} artifact(s) must be archived first. Contract ` +
          "§8.1 requires irreplaceable artifacts to be archived before disposable working files " +
          "are cleaned, and these bytes cannot be regenerated.",
        {
          category: "policy",
          retryable: false,
          details: {
            blocked: plan.blocked.map((block) => ({
              artifactId: block.record.artifact.artifactId,
              reason: block.reason,
            })),
          },
        },
      );
    }

    const removed: ArtifactRecord[] = [];
    const alreadyAbsent: ArtifactRecord[] = [];
    for (const record of plan.removable) {
      const path = localPathFromUri(record.artifact.uri);
      if (path === undefined) {
        alreadyAbsent.push(record);
        continue;
      }
      try {
        await unlink(path);
        removed.push(record);
      } catch {
        alreadyAbsent.push(record);
      }
    }
    return { removed, alreadyAbsent };
  }
}

/** A `file:` URI for a local path, without importing `node:url` at every call site. */
function pathToUri(path: string): string {
  const absolute = path.startsWith("/") ? path : `/${path}`;
  return `file://${encodeURI(absolute).replace(/#/g, "%23").replace(/\?/g, "%3F")}`;
}
