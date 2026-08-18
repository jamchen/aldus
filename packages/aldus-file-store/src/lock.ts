/**
 * Advisory locking for concurrent sessions.
 *
 * Architecture contract §19.1 requires Aldus to define "concurrency and lease semantics" and
 * permits simple file locking for V1 local execution, while requiring that the contract still
 * allow stronger distributed leases later. §10.2 makes Claude Code Remote Control an ordinary
 * interaction surface, so two sessions operating on one workspace is a normal situation rather
 * than an edge case.
 *
 * Everything here sits behind {@link LockManager} precisely so a distributed lease can replace
 * {@link FileLockManager} without any caller changing. Decisions are recorded in ADR-0005.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { hostname } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { newUlid } from "@aldus-runtime/core";

import {
  createExclusive,
  overwrite,
  readFileOrUndefined,
  removeIfPresent,
  isNotFound,
} from "./atomic.js";
import { FileStoreErrorCodes, fileStoreError } from "./errors.js";

/**
 * How long a lock stays valid without being renewed.
 *
 * A lock is held for the duration of a write, never across a human gate — contract §13 gates are
 * durable records, not held locks — so this bounds a write, not a workflow. Long enough that a
 * slow filesystem does not cause spurious theft; short enough that a killed process does not
 * block an operator for minutes.
 */
export const DEFAULT_LOCK_TTL_MS = 30_000;

/** How long {@link FileLockManager.acquire} waits for a contended lock before giving up. */
export const DEFAULT_LOCK_TIMEOUT_MS = 10_000;

/** Delay between acquisition attempts. */
export const DEFAULT_LOCK_RETRY_MS = 50;

/** A held lock. Released by the holder, or reclaimed by a contender once it expires. */
export interface Lease {
  /** Unique identity of this acquisition. Distinguishes a re-acquired lock from a held one. */
  readonly id: string;
  /** The resource this lease covers. */
  readonly resource: string;
  /** Extend the lease. Returns `false` if the lease was already lost. */
  renew(): Promise<boolean>;
  /** Release the lease. Returns `false` if it had already been lost to a contender. */
  release(): Promise<boolean>;
}

/** Options for acquiring a lock. */
export interface AcquireOptions {
  /** Give up after this long. Defaults to {@link DEFAULT_LOCK_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Lease lifetime without renewal. Defaults to {@link DEFAULT_LOCK_TTL_MS}. */
  ttlMs?: number;
}

/**
 * Mutual exclusion over named resources.
 *
 * The interface is deliberately narrow: acquire, and run something while holding. Anything a
 * distributed lease service cannot honour has no place here (contract §19.1).
 */
export interface LockManager {
  /** Acquire `resource`, waiting up to the timeout. */
  acquire(resource: string, options?: AcquireOptions): Promise<Lease>;
  /** Run `body` while holding `resource`, releasing it however `body` ends. */
  withLock<T>(
    resource: string,
    body: (lease: Lease) => Promise<T>,
    options?: AcquireOptions,
  ): Promise<T>;
}

/** Contents of a lockfile. Written as JSON so a stuck lock is diagnosable by reading it. */
interface LockRecord {
  lockId: string;
  resource: string;
  pid: number;
  host: string;
  acquiredAt: string;
  renewedAt: string;
  ttlMs: number;
}

/** Injection points so tests can control time without sleeping. */
export interface FileLockManagerOptions {
  /**
   * Clock used for lockfile timestamps and staleness, in milliseconds since the epoch.
   *
   * Deliberately NOT used for the acquisition deadline. A caller that freezes this clock is
   * describing when locks expire, not asking to wait forever — and since the retry loop sleeps
   * in real time, a frozen clock would make the deadline unreachable and the loop unbounded.
   * The deadline therefore always uses real time; see {@link FileLockManager.acquire}.
   */
  now?: () => number;
  /** Delay between acquisition attempts. Defaults to {@link DEFAULT_LOCK_RETRY_MS}. */
  retryMs?: number;
}

/**
 * File-backed advisory lock using `O_CREAT | O_EXCL`.
 *
 * The exclusive create is the whole mechanism: check-and-create is one syscall, so two processes
 * racing cannot both believe they won. Everything else — TTLs, liveness probes, reclaim — exists
 * only to stop a dead holder from blocking the workspace forever.
 */
/**
 * Resources held by the current async scope.
 *
 * Tracked per async context rather than per manager, and that distinction is the whole point.
 * Two independent tasks in one process contending for the same lock is legitimate — one waits,
 * the other releases, both proceed. Re-acquiring a lock *inside the scope that already holds
 * it* is not: file locks are not re-entrant, so the acquirer is waiting on itself and will spin
 * until the acquisition deadline before failing with a misleading "held by another session".
 *
 * `AsyncLocalStorage` distinguishes the two exactly: a nested call inherits the scope, a sibling
 * task does not.
 *
 * Entries are keyed by manager **instance** as well as resource. Two managers in one process
 * stand for two independent holders — that is how a test simulates another machine stealing a
 * lease — and refusing one because the other holds the resource would be wrong.
 */
const heldByScope = new AsyncLocalStorage<ReadonlySet<string>>();

/** Scope key for one manager's hold on one resource. */
function scopeKey(manager: FileLockManager, resource: string): string {
  return `${manager.instanceId}\u0000${resource}`;
}

export class FileLockManager implements LockManager {
  readonly #directory: string;
  readonly #now: () => number;
  readonly #retryMs: number;
  readonly #host = hostname();
  /** Distinguishes this manager from another in the same process. @see scopeKey */
  readonly instanceId: string = newUlid();

  constructor(lockDirectory: string, options: FileLockManagerOptions = {}) {
    this.#directory = lockDirectory;
    this.#now = options.now ?? Date.now;
    this.#retryMs = options.retryMs ?? DEFAULT_LOCK_RETRY_MS;
  }

  /** Path of the lockfile backing `resource`. */
  pathFor(resource: string): string {
    // Resource names contain ':' and '/' (e.g. "run:run_01J…"); neither is safe in a filename on
    // every platform, so they are folded to '-'. Collisions between distinct resources would be
    // a correctness bug, so the mapping is injective for the character set actually used.
    return join(this.#directory, `${resource.replace(/[^A-Za-z0-9._-]/g, "-")}.lock`);
  }

  async acquire(resource: string, options: AcquireOptions = {}): Promise<Lease> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    const ttlMs = options.ttlMs ?? DEFAULT_LOCK_TTL_MS;
    const path = this.pathFor(resource);

    // Fail immediately rather than deadlocking. `FileEventStore.append` takes the Run lock to
    // assign a sequence (ADR-0005), so a caller that holds the Run lock and then emits an event
    // waits on itself — which without this check surfaces after a multi-second timeout as
    // "held by another session", pointing the reader at concurrency rather than at their own
    // call stack.
    if (heldByScope.getStore()?.has(scopeKey(this, resource)) === true) {
      throw fileStoreError(
        FileStoreErrorCodes.LOCK_REENTRANT,
        `The lock on "${resource}" is already held by this scope, and file locks are not ` +
          "re-entrant, so acquiring it again can never succeed. Either release the outer lock " +
          "before this call, or give the inner operation its own lock resource.",
        { category: "conflict", retryable: false, details: { resource } },
      );
    }

    // Real time, not `#now`: this bounds how long we actually sleep, and the retry loop below
    // sleeps in real milliseconds regardless of what clock the caller injected.
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      const lockId = newUlid();
      const record = this.#record(resource, lockId, ttlMs);

      if (await createExclusive(path, JSON.stringify(record, null, 2))) {
        // Read back before trusting the acquisition. If a contender reclaimed a stale lock at
        // the same moment, whichever record survives on disk is the real holder — and it may not
        // be ours.
        if (await this.#holds(path, lockId)) {
          return this.#lease(path, resource, lockId, ttlMs);
        }
        continue;
      }

      const existing = await this.#read(path);
      if (existing === undefined || this.#isDead(existing)) {
        // Only remove the exact record observed as dead. Without the identity check, a slow
        // contender could delete a lock that a third process had just legitimately acquired.
        await this.#reclaim(path, existing?.lockId);
        continue;
      }

      if (Date.now() >= deadline) {
        throw fileStoreError(
          FileStoreErrorCodes.LOCK_TIMEOUT,
          `Could not acquire the lock on "${resource}" within ${timeoutMs}ms. It is held by ` +
            `another session that is still renewing it.`,
          {
            category: "conflict",
            retryable: true,
            details: {
              resource,
              timeoutMs,
              heldByPid: existing.pid,
              heldByHost: existing.host,
              renewedAt: existing.renewedAt,
            },
          },
        );
      }

      await delay(this.#retryMs);
    }
  }

  async withLock<T>(
    resource: string,
    body: (lease: Lease) => Promise<T>,
    options: AcquireOptions = {},
  ): Promise<T> {
    const lease = await this.acquire(resource, options);
    const scope = new Set(heldByScope.getStore() ?? []);
    scope.add(scopeKey(this, resource));
    let result: T;
    try {
      result = await heldByScope.run(scope, () => body(lease));
    } catch (error) {
      // Release without masking the body's failure: the original error is the useful one.
      await lease.release().catch(() => undefined);
      throw error;
    }

    const stillHeld = await lease.release();
    if (!stillHeld) {
      // The body ran to completion believing it held the lock, and did not. Whatever it wrote may
      // have interleaved with another writer, so reporting success would be a lie.
      throw fileStoreError(
        FileStoreErrorCodes.LOCK_LOST,
        `The lease on "${resource}" was lost while the operation was still running, so another ` +
          "session may have written concurrently. The operation's result is not trustworthy.",
        { category: "conflict", retryable: true, details: { resource } },
      );
    }
    return result;
  }

  #record(resource: string, lockId: string, ttlMs: number): LockRecord {
    const timestamp = new Date(this.#now()).toISOString();
    return {
      lockId,
      resource,
      pid: process.pid,
      host: this.#host,
      acquiredAt: timestamp,
      renewedAt: timestamp,
      ttlMs,
    };
  }

  #lease(path: string, resource: string, lockId: string, ttlMs: number): Lease {
    const manager = this;
    return {
      id: lockId,
      resource,
      async renew(): Promise<boolean> {
        if (!(await manager.#holds(path, lockId))) return false;
        const record = manager.#record(resource, lockId, ttlMs);
        const existing = await manager.#read(path);
        record.acquiredAt = existing?.acquiredAt ?? record.acquiredAt;
        await overwrite(path, JSON.stringify(record, null, 2));
        return true;
      },
      async release(): Promise<boolean> {
        if (!(await manager.#holds(path, lockId))) return false;
        await removeIfPresent(path);
        return true;
      },
    };
  }

  async #read(path: string): Promise<LockRecord | undefined> {
    let contents: string | undefined;
    try {
      contents = await readFileOrUndefined(path);
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
    if (contents === undefined) return undefined;
    try {
      const parsed: unknown = JSON.parse(contents);
      if (typeof parsed !== "object" || parsed === null) return undefined;
      return parsed as LockRecord;
    } catch {
      // An unparseable lockfile is treated as dead rather than as a permanent blocker: it can
      // only arise from a crash mid-create, and refusing to proceed would wedge the workspace.
      return undefined;
    }
  }

  async #holds(path: string, lockId: string): Promise<boolean> {
    const record = await this.#read(path);
    return record?.lockId === lockId;
  }

  /**
   * True if the lock's holder can no longer be renewing it.
   *
   * Two independent signals. The TTL is the portable one. The liveness probe is stronger but only
   * meaningful on the same host — a PID on another machine says nothing about a process here —
   * so it is used only when the hostnames match.
   */
  #isDead(record: LockRecord): boolean {
    const renewedAt = Date.parse(record.renewedAt);
    if (Number.isNaN(renewedAt)) return true;

    const ttl =
      typeof record.ttlMs === "number" && record.ttlMs > 0 ? record.ttlMs : DEFAULT_LOCK_TTL_MS;
    if (this.#now() - renewedAt > ttl) return true;

    if (record.host === this.#host && typeof record.pid === "number") {
      try {
        // Signal 0 performs the permission and existence checks without delivering a signal.
        process.kill(record.pid, 0);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // ESRCH: no such process. EPERM means it exists but belongs to another user, so it is
        // alive and the lock is legitimately held.
        if (code === "ESRCH") return true;
      }
    }
    return false;
  }

  async #reclaim(path: string, observedLockId: string | undefined): Promise<void> {
    if (observedLockId === undefined) {
      await removeIfPresent(path);
      return;
    }
    const current = await this.#read(path);
    if (current?.lockId === observedLockId) {
      await removeIfPresent(path);
    }
  }
}
