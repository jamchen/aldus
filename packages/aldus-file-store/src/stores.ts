/**
 * File-backed implementations of the contract §7 storage ports.
 *
 * Every mutating operation runs under a lock (contract §19.1) and writes atomically, so an
 * interrupted process leaves either the previous state or the new state, never a mixture. Every
 * read-modify-write preserves properties written by a newer schema version (ADR-0004 decision 3).
 *
 * These stores store and retrieve. They do not decide whether a Run may advance (WP-04), whether
 * a gate is satisfied (WP-05), or what an artifact's lineage is (WP-03).
 */

import { readdir } from "node:fs/promises";

import {
  validateRecord,
  fromStructuredError,
  type AldusEvent,
  type EpisodeRef,
  type RunManifest,
  type SchemaTypeFor,
  type VersionedSchemaName,
} from "@aldus-runtime/core";

import { appendLineSynced, isNotFound } from "./atomic.js";
import { appendToCollection, readCollection } from "./collections.js";
import { mergeForWrite, readDocument, writeDocument } from "./document.js";
import { FileStoreErrorCodes, fileStoreError } from "./errors.js";
import { readJsonLines, toJsonLine } from "./jsonl.js";
import { EPISODE_LOCK_RESOURCE, WorkspaceLayout, runLockResource } from "./layout.js";
import type { LockManager } from "./lock.js";
import type {
  EpisodeStore,
  EventReadOptions,
  EventReadResult,
  EventStore,
  RunCollectionName,
  RunCollectionTypes,
  RunStore,
} from "./ports.js";

/** Schema backing each per-run collection file (contract §7). */
export const RUN_COLLECTION_SCHEMAS = {
  artifacts: "ArtifactRef",
  approvals: "GateDecision",
  costs: "CostRecord",
  release: "ReleaseReceipt",
} as const satisfies Record<RunCollectionName, VersionedSchemaName>;

/* -------------------------------------------------------------------------------------------
 * Episode
 * ---------------------------------------------------------------------------------------- */

/** `.aldus/episode.json` (contract §6.1, §7). */
export class FileEpisodeStore implements EpisodeStore {
  readonly #layout: WorkspaceLayout;
  readonly #locks: LockManager;

  constructor(layout: WorkspaceLayout, locks: LockManager) {
    this.#layout = layout;
    this.#locks = locks;
  }

  async get(): Promise<EpisodeRef | undefined> {
    const document = await readDocument(this.#layout.episodePath(), "EpisodeRef");
    return document?.value;
  }

  async put(episode: EpisodeRef): Promise<void> {
    await this.#locks.withLock(EPISODE_LOCK_RESOURCE, async () => {
      await writeDocument(this.#layout.episodePath(), episode);
    });
  }

  async update(mutate: (current: EpisodeRef) => EpisodeRef): Promise<EpisodeRef> {
    return this.#locks.withLock(EPISODE_LOCK_RESOURCE, async () => {
      const path = this.#layout.episodePath();
      const document = await readDocument(path, "EpisodeRef");
      if (document === undefined) {
        throw fileStoreError(
          FileStoreErrorCodes.RECORD_NOT_FOUND,
          "This workspace has no Episode record, so there is nothing to update.",
          { category: "not_found", retryable: false, details: { path } },
        );
      }
      const next = mutate(document.value);
      assertValid("EpisodeRef", next);
      await writeDocument(path, mergeForWrite(document, next));
      return next;
    });
  }
}

/* -------------------------------------------------------------------------------------------
 * Run
 * ---------------------------------------------------------------------------------------- */

/** `.aldus/runs/{run-id}/` (contract §6.2, §7). */
export class FileRunStore implements RunStore {
  readonly #layout: WorkspaceLayout;
  readonly #locks: LockManager;

  constructor(layout: WorkspaceLayout, locks: LockManager) {
    this.#layout = layout;
    this.#locks = locks;
  }

  async list(): Promise<string[]> {
    try {
      const entries = await readdir(this.#layout.runsDirectory(), { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
    } catch (error) {
      // A workspace with no runs yet is ordinary, not an error.
      if (isNotFound(error)) return [];
      throw error;
    }
  }

  async get(runId: string): Promise<RunManifest | undefined> {
    const document = await readDocument(this.#layout.runFilePath(runId, "manifest"), "RunManifest");
    return document?.value;
  }

  async create(manifest: RunManifest): Promise<void> {
    await this.#locks.withLock(runLockResource(manifest.runId), async () => {
      const path = this.#layout.runFilePath(manifest.runId, "manifest");
      const existing = await readDocument(path, "RunManifest");
      if (existing !== undefined) {
        throw fileStoreError(
          FileStoreErrorCodes.RECORD_IDENTITY_MISMATCH,
          `A Run manifest already exists for "${manifest.runId}". Creating it again would ` +
            "overwrite an execution record, which contract §6.3 makes append-only.",
          { category: "conflict", retryable: false, details: { runId: manifest.runId } },
        );
      }
      await writeDocument(path, manifest);
    });
  }

  async update(runId: string, mutate: (current: RunManifest) => RunManifest): Promise<RunManifest> {
    return this.#locks.withLock(runLockResource(runId), async () => {
      const path = this.#layout.runFilePath(runId, "manifest");
      const document = await readDocument(path, "RunManifest");
      if (document === undefined) {
        throw fileStoreError(
          FileStoreErrorCodes.RECORD_NOT_FOUND,
          `No Run manifest exists for "${runId}".`,
          { category: "not_found", retryable: false, details: { runId } },
        );
      }
      const next = mutate(document.value);
      if (next.runId !== runId) {
        throw fileStoreError(
          FileStoreErrorCodes.RECORD_IDENTITY_MISMATCH,
          `An update to Run "${runId}" returned a manifest identifying itself as ` +
            `"${next.runId}". Writing it would file one Run's state under another's identity.`,
          { category: "conflict", retryable: false, details: { runId, returnedRunId: next.runId } },
        );
      }
      assertValid("RunManifest", next);
      await writeDocument(path, mergeForWrite(document, next));
      return next;
    });
  }

  async listRecords<C extends RunCollectionName>(
    runId: string,
    collection: C,
  ): Promise<RunCollectionTypes[C][]> {
    const schema = RUN_COLLECTION_SCHEMAS[collection];
    const stored = await readCollection(this.#layout.runFilePath(runId, collection), schema);
    return stored.values as RunCollectionTypes[C][];
  }

  async addRecord<C extends RunCollectionName>(
    runId: string,
    collection: C,
    record: RunCollectionTypes[C],
  ): Promise<void> {
    await this.#locks.withLock(runLockResource(runId), async () => {
      const schema = RUN_COLLECTION_SCHEMAS[collection];
      assertValid(schema, record);
      await appendToCollection(
        this.#layout.runFilePath(runId, collection),
        schema,
        record as SchemaTypeFor<typeof schema>,
      );
    });
  }
}

/* -------------------------------------------------------------------------------------------
 * Events
 * ---------------------------------------------------------------------------------------- */

/** `.aldus/runs/{run-id}/events.jsonl` (contract §6.4, §7). */
export class FileEventStore implements EventStore {
  readonly #layout: WorkspaceLayout;
  readonly #locks: LockManager;

  constructor(layout: WorkspaceLayout, locks: LockManager) {
    this.#layout = layout;
    this.#locks = locks;
  }

  async append(runId: string, event: AldusEvent): Promise<AldusEvent> {
    return this.#locks.withLock(runLockResource(runId), async () => {
      const path = this.#layout.runFilePath(runId, "events");
      const existing = await this.#readValidated(path, {});

      const expected = nextSequenceOf(existing.events);
      if (event.sequence !== undefined && event.sequence !== expected) {
        throw fileStoreError(
          FileStoreErrorCodes.EVENT_OUT_OF_SEQUENCE,
          `Event sequence ${event.sequence} does not follow the log, which expects ${expected}. ` +
            "A per-run sequence is a total order (ADR-0005); a gap or a repeat would make the " +
            "log unorderable across concurrent sessions.",
          {
            category: "conflict",
            retryable: false,
            details: { runId, expected, received: event.sequence },
          },
        );
      }

      if (existing.events.some((stored) => stored.eventId === event.eventId)) {
        throw fileStoreError(
          FileStoreErrorCodes.EVENT_DUPLICATE,
          `Event "${event.eventId}" is already in the log for Run "${runId}". Appending it again ` +
            "would record one mutation twice (contract §6.4).",
          { category: "conflict", retryable: false, details: { runId, eventId: event.eventId } },
        );
      }

      const stored: AldusEvent = { ...event, sequence: expected };
      assertValid("AldusEvent", stored);
      await appendLineSynced(path, toJsonLine(stored));
      return stored;
    });
  }

  async read(runId: string, options: EventReadOptions = {}): Promise<EventReadResult> {
    return this.#readValidated(this.#layout.runFilePath(runId, "events"), options);
  }

  async nextSequence(runId: string): Promise<number> {
    const result = await this.read(runId);
    return nextSequenceOf(result.events);
  }

  async #readValidated(path: string, options: EventReadOptions): Promise<EventReadResult> {
    const lines = await readJsonLines(path, {
      path,
      ...(options.strictTail === undefined ? {} : { strictTail: options.strictTail }),
    });

    const events: AldusEvent[] = [];
    for (let index = 0; index < lines.values.length; index += 1) {
      const result = validateRecord("AldusEvent", lines.values[index]);
      if (!result.ok) {
        const error = fromStructuredError(result.error);
        throw fileStoreError(
          FileStoreErrorCodes.EVENT_LOG_CORRUPT,
          `Line ${index + 1} of the event log parsed as JSON but is not a valid AldusEvent: ${error.message}`,
          { category: "io", retryable: false, details: { path, line: index + 1 } },
        );
      }
      events.push(result.value);
    }

    return lines.tornTail === undefined ? { events } : { events, tornTail: lines.tornTail };
  }
}

/**
 * The sequence the next event should carry.
 *
 * Derived from the highest stored sequence rather than the event count, so a log read after a
 * torn-tail recovery still assigns a sequence strictly greater than anything already durable.
 */
export function nextSequenceOf(events: readonly AldusEvent[]): number {
  let highest = -1;
  for (const event of events) {
    if (event.sequence !== undefined && event.sequence > highest) highest = event.sequence;
  }
  return highest + 1;
}

/** Validate before writing, so a malformed record never reaches disk. */
function assertValid<N extends VersionedSchemaName>(schema: N, value: unknown): void {
  const result = validateRecord(schema, value);
  if (!result.ok) throw fromStructuredError(result.error);
}
