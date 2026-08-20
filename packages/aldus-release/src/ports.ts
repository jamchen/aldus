/**
 * Ports the release executor reads and writes through.
 *
 * Contract §7 requires core models to be independent of physical storage, so this package binds
 * to interfaces rather than to a store. Each is kept to the operations actually used and tested:
 * an aspirational method on a port is worse than an absent one, because a second adapter is
 * written against it and only discovers at runtime that nothing honours it.
 */

import type { AldusEvent, ReleaseReceipt } from "@aldus-runtime/core";
import type { EventStore, RunStore } from "@aldus-runtime/file-store";

/**
 * Storage for release receipts (contract §7 `release.json`).
 *
 * There is no update in place and no delete. §17's receipts are an audit record of what was
 * attempted against a destination: an operation retried after a failure produces a second
 * receipt, not an edit to the first, because the fact that the first attempt failed is what
 * explains the retry. {@link latestByKey} resolves the current outcome by reading them in order.
 */
export interface ReleaseReceiptStore {
  /** Every receipt recorded for a Run, in the order they were appended. */
  list(runId: string): Promise<ReleaseReceipt[]>;
  /** Append one receipt. */
  append(runId: string, receipt: ReleaseReceipt): Promise<void>;
}

/**
 * Where lifecycle events go (contract §6.4).
 *
 * §6.4 requires **every** state mutation to emit an immutable event, so recording a receipt and
 * emitting its event are one operation from the executor's point of view.
 */
export interface ReleaseEventSink {
  /** Emit one event. */
  emit(event: AldusEvent): Promise<void>;
}

/**
 * The most recent receipt per idempotency key.
 *
 * Later receipts win, which is what makes a retry after a failure resolve to the retry's outcome
 * rather than the original failure.
 */
export function latestByKey(receipts: readonly ReleaseReceipt[]): Map<string, ReleaseReceipt> {
  const latest = new Map<string, ReleaseReceipt>();
  for (const receipt of receipts) latest.set(receipt.idempotencyKey, receipt);
  return latest;
}

/** An in-memory {@link ReleaseReceiptStore}, for tests and for dry runs. */
export class MemoryReleaseReceiptStore implements ReleaseReceiptStore {
  readonly #byRun = new Map<string, ReleaseReceipt[]>();

  list(runId: string): Promise<ReleaseReceipt[]> {
    return Promise.resolve([...(this.#byRun.get(runId) ?? [])]);
  }

  append(runId: string, receipt: ReleaseReceipt): Promise<void> {
    const existing = this.#byRun.get(runId);
    if (existing === undefined) this.#byRun.set(runId, [receipt]);
    else existing.push(receipt);
    return Promise.resolve();
  }

  /**
   * Discard every receipt for a Run, as a lost or never-written `release.json` would.
   *
   * Exists for the reconciliation tests: losing a receipt whose operation succeeded remotely is
   * the exact condition §17's reconciliation requirement addresses, and it has to be reproducible
   * to be tested.
   */
  forget(runId: string): void {
    this.#byRun.delete(runId);
  }
}

/** An in-memory {@link ReleaseEventSink} that retains what it was given, for tests. */
export class MemoryReleaseEventSink implements ReleaseEventSink {
  readonly events: AldusEvent[] = [];

  emit(event: AldusEvent): Promise<void> {
    this.events.push(event);
    return Promise.resolve();
  }
}

/**
 * A {@link ReleaseReceiptStore} backed by `@aldus-runtime/file-store`'s per-Run `release.json` (§7).
 *
 * `RunStore.addRecord` takes the Run lock itself, so this must not be called from inside code
 * that already holds it — file locks are not re-entrant and the acquisition is refused outright
 * (ADR-0005). The executor therefore holds no Run lock while writing receipts.
 */
export function runStoreReceipts(runs: RunStore): ReleaseReceiptStore {
  return {
    list: (runId) => runs.listRecords(runId, "release"),
    append: (runId, receipt) => runs.addRecord(runId, "release", receipt),
  };
}

/**
 * A {@link ReleaseEventSink} backed by `@aldus-runtime/file-store`'s event log (§6.4).
 *
 * Carries the same caution as {@link runStoreReceipts}: `EventStore.append` takes the Run lock to
 * assign a sequence (ADR-0005).
 */
export function eventStoreSink(events: EventStore): ReleaseEventSink {
  return {
    emit: async (event) => {
      await events.append(event.runId, event);
    },
  };
}
