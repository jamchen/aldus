/**
 * File-backed storage for the TTS ledger (architecture contract §7, §15).
 *
 * `@aldus/tts-ledger` ships only in-memory stores, because §7 requires core models to be
 * independent of physical storage and the package holds to that. Wiring it to something durable
 * is composition, which ADR-0015 places here.
 *
 * ## Why these are not §7 run collections
 *
 * §7 names exactly four per-run collection files, and `RunCollectionName` in `@aldus/file-store`
 * is closed over them. Takes, plans, and scripts are none of those. Rather than widen a Core-side
 * type to fit one package, these live under `.aldus/tts/{run-id}/`, following the precedent
 * `@aldus/artifact-registry` set with `.aldus/artifacts/`: §7 calls its layout "recommended", and
 * a sibling directory is a smaller claim than a new entry in a closed enum every store must then
 * implement.
 *
 * ## Locking
 *
 * Each file has its own lock resource, never the Run lock. `FileEventStore.append` takes the Run
 * lock to assign an event sequence (ADR-0005) and locks are not re-entrant, so a store that held
 * the Run lock while the ledger emitted an event would be refused with `ALDUS_LOCK_REENTRANT`.
 * Separate resources also mean recording a take does not serialise against an unrelated stage
 * writing artifacts.
 *
 * ## Append-only
 *
 * There is no delete, matching `TakeStore`'s deliberate omission of one: §15.1 requires rejected
 * paid takes to be retained with unique identity, and an interface that cannot express deletion
 * is a stronger guarantee than one that declines to.
 */

import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  WorkspaceLayout,
  readFileOrUndefined,
  writeDocument,
  type LockManager,
} from "@aldus/file-store";
import type {
  LexiconEntry,
  LexiconStore,
  PerformanceScript,
  PlanStore,
  ScriptStore,
  TakeRecord,
  TakeStore,
  TtsRequestPlan,
} from "@aldus/tts-ledger";

import { ServiceErrorCodes, serviceError } from "./errors.js";

/** Directory under `.aldus` holding ledger state. */
export const TTS_DIRECTORY = "tts";

/** The files one Run's ledger state is kept in. */
export type LedgerFileName = "takes" | "plans" | "scripts" | "lexicon";

/** Where a Run's ledger files live (contract §7). */
export class LedgerLayout {
  readonly directory: string;

  constructor(aldusDirectory: string) {
    this.directory = join(aldusDirectory, TTS_DIRECTORY);
  }

  /** Absolute path of one Run's ledger file. */
  filePath(runId: string, file: LedgerFileName): string {
    return join(this.directory, runId, `${file}.json`);
  }

  /**
   * Lock resource for one Run's ledger file.
   *
   * Deliberately not `runLockResource(runId)`: the event sink takes that lock, and nesting is
   * refused rather than deadlocked (ADR-0005).
   */
  lockResource(runId: string, file: LedgerFileName): string {
    return `tts-${file}:${runId}`;
  }
}

/** Read a JSON array from disk, treating absence as empty. */
async function readArray<T>(path: string, what: string): Promise<T[]> {
  const contents = await readFileOrUndefined(path);
  if (contents === undefined || contents.trim().length === 0) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw serviceError(
      ServiceErrorCodes.LEDGER_FILE_MALFORMED,
      `The stored ${what} file is not valid JSON. Atomic writes make a torn file impossible, so ` +
        "this means it was edited or replaced by something other than Aldus.",
      { category: "io", retryable: false, details: { path } },
    );
  }
  if (!Array.isArray(parsed)) {
    throw serviceError(
      ServiceErrorCodes.LEDGER_FILE_MALFORMED,
      `The stored ${what} file is valid JSON but not an array.`,
      { category: "io", retryable: false, details: { path } },
    );
  }
  return parsed as T[];
}

/**
 * Append one record, preserving every existing element byte for byte.
 *
 * The raw parsed array is written back with one element added, so unknown properties written by a
 * newer minor version survive (ADR-0004 decision 3) without a merge to get wrong — the same shape
 * `@aldus/file-store`'s `appendToCollection` uses, and for the same reason.
 */
async function appendRaw(
  path: string,
  locks: LockManager,
  resource: string,
  record: unknown,
): Promise<void> {
  await locks.withLock(resource, async () => {
    await mkdir(dirname(path), { recursive: true });
    const existing = await readArray<unknown>(path, "ledger");
    await writeDocument(path, [...existing, record]);
  });
}

/** A {@link TakeStore} backed by `.aldus/tts/{run-id}/takes.json` (contract §15). */
export class FileTakeStore implements TakeStore {
  readonly #layout: LedgerLayout;
  readonly #locks: LockManager;

  constructor(layout: LedgerLayout, locks: LockManager) {
    this.#layout = layout;
    this.#locks = locks;
  }

  list(runId: string): Promise<TakeRecord[]> {
    return readArray<TakeRecord>(this.#layout.filePath(runId, "takes"), "takes");
  }

  append(runId: string, take: TakeRecord): Promise<void> {
    return appendRaw(
      this.#layout.filePath(runId, "takes"),
      this.#locks,
      this.#layout.lockResource(runId, "takes"),
      take,
    );
  }

  /**
   * Replace one take in place, by `takeId`.
   *
   * The port exists only so a human decision can be attached to an existing take, and this
   * refuses anything else: a `replace` that silently accepted an unknown id would let a caller
   * believe a decision had been recorded when nothing was.
   */
  async replace(runId: string, take: TakeRecord): Promise<void> {
    const path = this.#layout.filePath(runId, "takes");
    await this.#locks.withLock(this.#layout.lockResource(runId, "takes"), async () => {
      const existing = await readArray<TakeRecord>(path, "takes");
      const index = existing.findIndex((candidate) => candidate.takeId === take.takeId);
      if (index === -1) {
        throw serviceError(
          ServiceErrorCodes.LEDGER_TAKE_NOT_FOUND,
          `No take "${take.takeId}" is stored for run "${runId}", so there is nothing to replace.`,
          { category: "not_found", retryable: false, details: { runId, takeId: take.takeId } },
        );
      }
      const next = [...existing];
      next[index] = take;
      await writeDocument(path, next);
    });
  }
}

/** A {@link PlanStore} backed by `.aldus/tts/{run-id}/plans.json` (contract §15). */
export class FilePlanStore implements PlanStore {
  readonly #layout: LedgerLayout;
  readonly #locks: LockManager;

  constructor(layout: LedgerLayout, locks: LockManager) {
    this.#layout = layout;
    this.#locks = locks;
  }

  list(runId: string): Promise<TtsRequestPlan[]> {
    return readArray<TtsRequestPlan>(this.#layout.filePath(runId, "plans"), "plans");
  }

  append(runId: string, plan: TtsRequestPlan): Promise<void> {
    return appendRaw(
      this.#layout.filePath(runId, "plans"),
      this.#locks,
      this.#layout.lockResource(runId, "plans"),
      plan,
    );
  }
}

/** A {@link ScriptStore} backed by `.aldus/tts/{run-id}/scripts.json` (contract §14). */
export class FileScriptStore implements ScriptStore {
  readonly #layout: LedgerLayout;
  readonly #locks: LockManager;

  constructor(layout: LedgerLayout, locks: LockManager) {
    this.#layout = layout;
    this.#locks = locks;
  }

  list(runId: string): Promise<PerformanceScript[]> {
    return readArray<PerformanceScript>(this.#layout.filePath(runId, "scripts"), "scripts");
  }

  append(runId: string, script: PerformanceScript): Promise<void> {
    return appendRaw(
      this.#layout.filePath(runId, "scripts"),
      this.#locks,
      this.#layout.lockResource(runId, "scripts"),
      script,
    );
  }
}

/**
 * A read-only {@link LexiconStore} backed by `.aldus/tts/{run-id}/lexicon.json` (contract §15.2).
 *
 * Read-only because the port is: §15.2's lexicon is authored knowledge with provenance and an
 * approval status, which makes it Knowledge Pack content (§9) rather than something a runtime
 * mutates mid-production.
 */
export class FileLexiconStore implements LexiconStore {
  readonly #layout: LedgerLayout;

  constructor(layout: LedgerLayout) {
    this.#layout = layout;
  }

  list(runId: string): Promise<LexiconEntry[]> {
    return readArray<LexiconEntry>(this.#layout.filePath(runId, "lexicon"), "lexicon");
  }
}

/** Build every file-backed ledger store for a workspace. */
export function fileLedgerStores(
  layout: WorkspaceLayout,
  locks: LockManager,
): {
  layout: LedgerLayout;
  takes: FileTakeStore;
  plans: FilePlanStore;
  scripts: FileScriptStore;
  lexicon: FileLexiconStore;
} {
  const ledgerLayout = new LedgerLayout(layout.aldusDirectory);
  return {
    layout: ledgerLayout,
    takes: new FileTakeStore(ledgerLayout, locks),
    plans: new FilePlanStore(ledgerLayout, locks),
    scripts: new FileScriptStore(ledgerLayout, locks),
    lexicon: new FileLexiconStore(ledgerLayout),
  };
}
