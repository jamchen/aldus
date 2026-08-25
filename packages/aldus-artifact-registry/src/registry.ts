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
} from "@aldus-runtime/core";
import { WorkspaceLayout, isNotFound, type LockManager } from "@aldus-runtime/file-store";

import { LocalDirectoryArchive, localPathFromUri, type ArtifactArchive } from "./archive.js";
import { planCleanup, type CleanupPlan } from "./cleanup.js";
import { digestFile, sha256File, verifyFileDigest } from "./digest.js";
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
  /** What produced the bytes. Opaque to Core (§4.2). @see ArtifactRef.producer */
  producers?: ArtifactRef["producers"];
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
/**
 * A short, value-free description of a filesystem error (§19.2).
 *
 * The `code` and nothing else: an error message can carry a path, and a path can carry an
 * adopter's episode naming. The operator has the artifact id from the record beside it.
 */
function describeIoError(error: unknown): string {
  const code =
    typeof error === "object" && error !== null && "code" in error ? String(error.code) : "unknown";
  return `the filesystem refused the delete (${code})`;
}

export interface CleanupOutcome {
  /** Artifacts whose working file was removed. */
  removed: ArtifactRecord[];
  /** Artifacts whose working file was already absent. */
  alreadyAbsent: ArtifactRecord[];
  /**
   * Artifacts whose working file could not be removed, with the reason (#94).
   *
   * Distinct from {@link CleanupOutcome.alreadyAbsent}, which is a claim that the file is gone.
   * A permissions error, a read-only mount or `EBUSY` all leave the bytes on disk, and reporting
   * them as absent tells the operator the opposite of what happened. Empty in the ordinary case.
   */
  failed: { record: ArtifactRecord; reason: string }[];
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

    // The URI must lead back to the bytes it was built from, checked here rather than trusted.
    //
    // #103 was a percent-encoding bug in `localPathFromUri`, invisible for every ASCII path and
    // therefore invisible until an adopter whose episode slugs carry Han characters tried to
    // archive. What made it expensive is *when* it surfaced: registration, digesting and
    // reporting all read the path they were handed, so a Run completed and reported clean, and
    // the failure appeared at archival — §8.1's precondition for cleanup, and the last thing
    // anyone does.
    //
    // Round-tripping at registration moves that to the first moment the URI exists. This costs
    // one string comparison and would have caught #103 on the first non-ASCII artifact ever
    // registered, rather than after a release.
    const uri = input.uri ?? pathToUri(input.path);
    if (input.uri === undefined && localPathFromUri(uri) !== input.path) {
      throw artifactRegistryError(
        ArtifactRegistryErrorCodes.ARTIFACT_URI_UNRESOLVABLE,
        "The URI built for this artifact does not lead back to the file it was built from, so " +
          "nothing that later resolves the URI — archival above all — would reach these bytes. " +
          "This is a defect in the runtime's path handling, not in the artifact.",
        {
          category: "internal",
          retryable: false,
          // §19.2: the artifact id and the mismatch, never the paths themselves — a working path
          // carries an adopter's episode naming.
          details: { sha256, resolved: localPathFromUri(uri) !== undefined },
        },
      );
    }
    const provenance = artifactProvenanceSchema.parse(input.provenance);

    const artifact: ArtifactRef = {
      schemaVersion: SCHEMA_VERSION,
      artifactId: input.artifactId ?? newArtifactId(),
      kind: input.kind,
      uri,
      sha256,
      mediaType: input.mediaType,
      sizeBytes,
      producerRunId: input.producerRunId,
      producerStageId: input.producerStageId,
      ...(input.producers === undefined ? {} : { producers: input.producers }),
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

    // Re-verify before deleting anything. `plan.safe` was computed against a records snapshot;
    // the bytes are deleted now. A working path can be rewritten and re-registered in between —
    // §8.1's `req-00.wav` case — and the plan would then clear a path holding bytes it never
    // examined. Checked as a whole pass first, so a stale plan removes nothing rather than some.
    const stale: { artifactId: string; path: string }[] = [];
    const unreadable: { artifactId: string; path: string }[] = [];
    const targets: { record: ArtifactRecord; path: string }[] = [];
    for (const record of plan.removable) {
      const path = localPathFromUri(record.artifact.uri);
      if (path === undefined) continue;
      let actual: string;
      try {
        actual = await sha256File(path);
      } catch (error) {
        // A file that is genuinely gone is not the hazard — nothing is lost by not deleting it.
        // A file that cannot be *read* is a different answer, and folding the two together says
        // "already absent" about bytes that are still on disk (#94). Unverifiable means unsafe to
        // delete, so it refuses here, before anything has been removed.
        if (isNotFound(error)) continue;
        unreadable.push({ artifactId: record.artifact.artifactId, path });
        continue;
      }
      if (actual === record.artifact.sha256) targets.push({ record, path });
      else stale.push({ artifactId: record.artifact.artifactId, path });
    }

    if (unreadable.length > 0) {
      throw artifactRegistryError(
        ArtifactRegistryErrorCodes.CLEANUP_UNVERIFIABLE,
        `Cleanup refused: ${unreadable.length} working file(s) exist but could not be read, so ` +
          "there is no way to confirm they still hold the bytes this plan cleared. Deleting them " +
          "unverified is exactly the risk the check before this one exists to remove.",
        {
          category: "io",
          retryable: true,
          details: { unreadable: unreadable.map((entry) => entry.artifactId) },
        },
      );
    }

    if (stale.length > 0) {
      throw artifactRegistryError(
        ArtifactRegistryErrorCodes.CLEANUP_STALE_PLAN,
        `Cleanup refused: ${stale.length} working file(s) no longer hold the bytes this plan ` +
          "cleared, so something rewrote them after the plan was made. Deleting them would " +
          "discard bytes nothing ever examined. Re-plan against the current registry.",
        {
          category: "conflict",
          retryable: true,
          details: { stale: stale.map((entry) => entry.artifactId) },
        },
      );
    }

    const removed: ArtifactRecord[] = [];
    const alreadyAbsent: ArtifactRecord[] = [];
    const failed: { record: ArtifactRecord; reason: string }[] = [];
    const verified = new Map(targets.map((target) => [target.record.artifact.artifactId, target]));
    for (const record of plan.removable) {
      const target = verified.get(record.artifact.artifactId);
      if (target === undefined) {
        alreadyAbsent.push(record);
        continue;
      }
      try {
        await unlink(target.path);
        removed.push(record);
      } catch (error) {
        // Collected rather than thrown: deletion is already underway, and a partial cleanup that
        // throws tells the operator less than one that finishes and reports what did not work.
        //
        // The `isNotFound` branch covers one narrow case and no test reaches it: the pre-check
        // above already established this file exists and hashes correctly, so an `ENOENT` here
        // means something else deleted it in between. That is a race no test in this file can
        // construct without a seam, and it is deliberately *not* reported as a failure — the
        // operator wanted the file gone and it is gone. Stated rather than left to be discovered,
        // because an untested branch that looks load-bearing is worth flagging as untested.
        if (isNotFound(error)) alreadyAbsent.push(record);
        else failed.push({ record, reason: describeIoError(error) });
      }
    }
    return { removed, alreadyAbsent, failed };
  }
}

/** A `file:` URI for a local path, without importing `node:url` at every call site. */
function pathToUri(path: string): string {
  const absolute = path.startsWith("/") ? path : `/${path}`;
  return `file://${encodeURI(absolute).replace(/#/g, "%23").replace(/\?/g, "%3F")}`;
}
