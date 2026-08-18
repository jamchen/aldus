/**
 * Storage ports.
 *
 * Architecture contract §7 names `EpisodeStore`, `RunStore`, `EventStore`, `ArtifactStore`, and
 * `SecretResolver` as bare interfaces with no members, and requires that "core models MUST be
 * independent of physical storage" so that the databases, object stores, and cloud drives §7
 * lists remain possible as adapters rather than becoming assumptions. Those services are
 * deliberately not named here: §4.2 keeps provider and platform identities out of the runtime.
 *
 * These are the members. Each interface is kept to operations this package actually implements
 * and tests: an aspirational method on a port is worse than an absent one, because a second
 * adapter is written against it and only discovers at runtime that nothing honours it.
 *
 * `ArtifactStore` is deliberately absent — it belongs to WP-03. `SecretResolver` is absent
 * because nothing in this package resolves a secret.
 */

import type {
  AldusEvent,
  ArtifactRef,
  CostRecord,
  EpisodeRef,
  GateDecision,
  ReleaseReceipt,
  RunManifest,
} from "@aldus-runtime/core";

/**
 * The durable content identity of a workspace (contract §6.1).
 *
 * Workspace-scoped rather than keyed by ID: §7's layout places exactly one `episode.json` at the
 * root of a workspace, so an `episodeId` parameter would imply a multiplicity the layout does
 * not have.
 */
export interface EpisodeStore {
  /** The stored Episode, or `undefined` if the workspace has none yet. */
  get(): Promise<EpisodeRef | undefined>;
  /** Write the Episode, replacing any previous one. */
  put(episode: EpisodeRef): Promise<void>;
  /**
   * Read, transform, and write under a lock, preserving properties written by a newer schema
   * version (ADR-0004 decision 3).
   */
  update(mutate: (current: EpisodeRef) => EpisodeRef): Promise<EpisodeRef>;
}

/** The four per-run collection files of contract §7. */
export type RunCollectionName = "artifacts" | "approvals" | "costs" | "release";

/** Record type stored in each per-run collection. */
export interface RunCollectionTypes {
  artifacts: ArtifactRef;
  approvals: GateDecision;
  costs: CostRecord;
  release: ReleaseReceipt;
}

/**
 * Run manifests and their materialized side records (contract §6.2, §7).
 *
 * This port stores and retrieves; it does not interpret. Deciding whether a Run may advance is
 * WP-04's, and evaluating a gate is WP-05's.
 */
export interface RunStore {
  /** IDs of every Run in the workspace, ascending. */
  list(): Promise<string[]>;
  /** A Run's manifest, or `undefined` if it does not exist. */
  get(runId: string): Promise<RunManifest | undefined>;
  /**
   * Write a Run that does not yet exist.
   *
   * @throws {AldusError} `ALDUS_RECORD_IDENTITY_MISMATCH` if a manifest already exists for the ID.
   */
  create(manifest: RunManifest): Promise<void>;
  /**
   * Read, transform, and write under a lock, preserving properties written by a newer schema
   * version (ADR-0004 decision 3).
   *
   * @throws {AldusError} `ALDUS_RECORD_NOT_FOUND` if the Run does not exist.
   */
  update(runId: string, mutate: (current: RunManifest) => RunManifest): Promise<RunManifest>;
  /** Every record in one of the Run's collection files. */
  listRecords<C extends RunCollectionName>(
    runId: string,
    collection: C,
  ): Promise<RunCollectionTypes[C][]>;
  /** Append one record to a collection file, under a lock. */
  addRecord<C extends RunCollectionName>(
    runId: string,
    collection: C,
    record: RunCollectionTypes[C],
  ): Promise<void>;
}

/** What an event log read found, including anything it had to recover from. */
export interface EventReadResult {
  /** Validated events in file order. */
  events: AldusEvent[];
  /** Raw text of a truncated final line, if the log had one (contract §19.1). */
  tornTail?: string;
}

/** Options for reading an event log. */
export interface EventReadOptions {
  /** Fail on a torn tail rather than recovering from it. Default `false`. */
  strictTail?: boolean;
}

/**
 * The append-only event log required by contract §6.4.
 *
 * There is no update or delete. §6.4 requires events to be immutable, and an interface that
 * cannot express mutation is a stronger guarantee than one that merely declines to.
 */
export interface EventStore {
  /**
   * Append one event, assigning its `sequence` if absent (ADR-0005).
   *
   * @returns the event as stored, including the assigned sequence.
   */
  append(runId: string, event: AldusEvent): Promise<AldusEvent>;
  /** Read a Run's events. */
  read(runId: string, options?: EventReadOptions): Promise<EventReadResult>;
  /** The sequence the next appended event will receive. */
  nextSequence(runId: string): Promise<number>;
}
