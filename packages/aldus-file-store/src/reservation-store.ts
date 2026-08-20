/**
 * Durable storage for spend reservation transitions (ADR-0044; #155 step 2).
 *
 * The store owns **durability**: schema validation, transition-identity uniqueness,
 * expected-revision atomicity, the durable commit. It does not own the reservation lifecycle —
 * a store that knew the state machine would be a store making policy, and `SpendService` owns that.
 *
 * ## Why there is no `append()`
 *
 * An unconditional append beside a conditional one is an unsafe API a future caller reaches for,
 * so the unsafe path is unrepresentable rather than discouraged.
 *
 * ## Why the lease is not the safety property
 *
 * `LockManager` **detects** lease loss; it does not fence. `withLock` reports `LOCK_LOST` after the
 * body has run, so a holder that lost its lease can still write in the interval before it finds
 * out. A revision comparison followed by an ordinary write is therefore still check-then-act: two
 * writers can both pass the check at revision N, and a replacing write lets the slower one destroy
 * the faster one's committed transition.
 *
 * The linearization point is `link()`, which refuses to replace an existing target. One commit file
 * **is** one revision, so exactly one writer can create a given name.
 */

import { link, mkdir, open, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  spendReservationTransitionSchema,
  reduceReservations,
  type SpendReservation,
  type SpendReservationTransition,
} from "@aldus-runtime/core";

import { FileStoreErrorCodes, fileStoreError } from "./errors.js";
import type { LockManager } from "./lock.js";

/** A grant's committed history, and the revision a writer must expect to still be current. */
export interface GrantReservationStream {
  grantId: string;
  /**
   * Number of **commits**, not of transitions.
   *
   * One commit may carry several transitions — a reconciliation must land atomically with the
   * settlement it justifies. Defining this as `transitions.length` would make the revision depend
   * on batch shapes, so two writers proposing different batches could compute the same expected
   * revision from different histories.
   */
  revision: number;
  /** Every transition, flattened across commits, in commit order. For reduction. */
  transitions: readonly SpendReservationTransition[];
}

/** @see SpendReservationStore.compareAndAppend */
export type CompareAndAppendResult =
  /** This call created a new durable fact. */
  | { kind: "appended"; revision: number }
  /** These exact transitions were already committed, by an earlier attempt of this same call. */
  | { kind: "already_present"; revision: number }
  /** Another commit won the successor of the expected revision. Re-read and recompute. */
  | { kind: "conflict"; currentRevision: number };

/** Durable transition storage with atomic conditional commit (ADR-0044). */
export interface SpendReservationStore {
  readGrant(grantId: string): Promise<GrantReservationStream>;
  /**
   * Commit iff the stream is still at `expectedRevision`.
   *
   * Decision order, so a retry is deterministic:
   *
   * 1. every supplied identity present with byte-identical contents → `already_present`;
   * 2. any supplied identity present with different contents → refuse;
   * 3. `expectedRevision` stale → `conflict`;
   * 4. otherwise attempt the conditional commit.
   *
   * Rule 1 outranks rule 3 so a caller that committed and lost the response terminates instead of
   * looping to rediscover its own success.
   */
  compareAndAppend(input: {
    grantId: string;
    expectedRevision: number;
    transitions: readonly SpendReservationTransition[];
  }): Promise<CompareAndAppendResult>;
  get(reservationId: string): Promise<SpendReservation | undefined>;
  listByRun(runId: string): Promise<readonly SpendReservation[]>;
}

/** One committed batch, as stored. */
interface CommitFile {
  revision: number;
  transitions: SpendReservationTransition[];
}

/** Wiring for {@link FileSpendReservationStore}. */
export interface FileSpendReservationStoreOptions {
  root: string;
  /** Reduces contention. **Not** the correctness mechanism — see the module docstring. */
  locks?: LockManager;
}

// The store has no retry policy on purpose. A conflict is returned, not absorbed: the caller's
// availability answer was computed against a stream that no longer exists, and only the caller can
// recompute it. A store that retried internally would hide that from the caller — the same reason
// ADR-0044 rejects a callback transaction.

export class FileSpendReservationStore implements SpendReservationStore {
  readonly #root: string;
  readonly #locks: LockManager | undefined;

  constructor(options: FileSpendReservationStoreOptions) {
    this.#root = options.root;
    this.#locks = options.locks;
  }

  async readGrant(grantId: string): Promise<GrantReservationStream> {
    const commits = await this.#readCommits(grantId);
    return {
      grantId,
      revision: commits.length,
      transitions: commits.flatMap((commit) => commit.transitions),
    };
  }

  async compareAndAppend(input: {
    grantId: string;
    expectedRevision: number;
    transitions: readonly SpendReservationTransition[];
  }): Promise<CompareAndAppendResult> {
    for (const transition of input.transitions) {
      const parsed = spendReservationTransitionSchema.safeParse(transition);
      if (!parsed.success) {
        throw fileStoreError(
          FileStoreErrorCodes.RESERVATION_TRANSITION_INVALID,
          "A reservation transition does not satisfy its schema, so it must not become durable.",
          {
            category: "validation",
            retryable: false,
            details: { grantId: input.grantId, issue: parsed.error.issues[0]?.path.join(".") },
          },
        );
      }
    }

    const commit = async (): Promise<CompareAndAppendResult> => {
      const commits = await this.#readCommits(input.grantId);
      const identity = this.#checkIdentities(commits, input.transitions, input.grantId);
      if (identity !== undefined) return identity;
      if (commits.length !== input.expectedRevision) {
        return { kind: "conflict", currentRevision: commits.length };
      }
      return this.#install(input.grantId, commits.length + 1, [...input.transitions]);
    };

    // The lease reduces contention and nothing more: `#install` is safe without it, because
    // `link()` refuses to replace a winner. If the lease is lost, the commit's own identity is
    // what answers whether it landed — see `#install`.
    const locks = this.#locks;
    if (locks === undefined) return commit();
    try {
      return await locks.withLock(`spend-reservation:${input.grantId}`, commit);
    } catch (error) {
      // `LOCK_LOST` after a successful commit is not a failure: the commit is immutable and ours.
      if ((error as { code?: string }).code === FileStoreErrorCodes.LOCK_LOST) {
        const commits = await this.#readCommits(input.grantId);
        const identity = this.#checkIdentities(commits, input.transitions, input.grantId);
        if (identity !== undefined) return identity;
      }
      throw error;
    }
  }

  async get(reservationId: string): Promise<SpendReservation | undefined> {
    // An index would be a hint, and a hint cannot establish absence: a syntactically valid but
    // stale index is missing the newest reservation, and nothing about it looks damaged. So a miss
    // scans the canonical streams rather than returning `undefined` (ADR-0044).
    for (const grantId of await this.#grantIds()) {
      const stream = await this.readGrant(grantId);
      const found = reduceReservations(stream.transitions).find(
        (reservation) => reservation.reservationId === reservationId,
      );
      if (found !== undefined) return found;
    }
    return undefined;
  }

  async listByRun(runId: string): Promise<readonly SpendReservation[]> {
    // Scans for the same reason: completeness is a claim about everything, and an index is a claim
    // about what it happened to record.
    const found: SpendReservation[] = [];
    for (const grantId of await this.#grantIds()) {
      const stream = await this.readGrant(grantId);
      found.push(
        ...reduceReservations(stream.transitions).filter(
          (reservation) => reservation.runId === runId,
        ),
      );
    }
    return found;
  }

  /** Rule 1 and rule 2 of the decision order. */
  #checkIdentities(
    commits: readonly CommitFile[],
    proposed: readonly SpendReservationTransition[],
    grantId: string,
  ): CompareAndAppendResult | undefined {
    const present = new Map<string, SpendReservationTransition>();
    for (const commit of commits) {
      for (const transition of commit.transitions) present.set(transition.transitionId, transition);
    }

    let allPresent = proposed.length > 0;
    for (const transition of proposed) {
      const existing = present.get(transition.transitionId);
      if (existing === undefined) {
        allPresent = false;
        continue;
      }
      if (JSON.stringify(existing) !== JSON.stringify(transition)) {
        throw fileStoreError(
          FileStoreErrorCodes.RESERVATION_TRANSITION_CONFLICT,
          `Transition "${transition.transitionId}" already exists with different contents. Two ` +
            "different facts under one identity cannot both be true, so this is refused rather " +
            "than resolved (ADR-0044).",
          {
            category: "conflict",
            retryable: false,
            details: { grantId, transitionId: transition.transitionId },
          },
        );
      }
    }
    return allPresent ? { kind: "already_present", revision: commits.length } : undefined;
  }

  /**
   * The linearization point, and the durability step after it.
   *
   * `link()` wins the revision; the directory `fsync` is what permits acknowledging it. Between the
   * two the writer has won and cannot prove it survived a power loss, so the commit is not
   * reported as appended — the caller retries with the same stable identities and rule 1 resolves
   * it either way.
   */
  async #install(
    grantId: string,
    revision: number,
    transitions: SpendReservationTransition[],
  ): Promise<CompareAndAppendResult> {
    const dir = join(this.#root, grantId, "commits");
    await mkdir(dir, { recursive: true });
    const final = join(dir, `${String(revision).padStart(6, "0")}.json`);
    const temp = `${final}.${Math.random().toString(36).slice(2)}.tmp`;

    const payload: CommitFile = { revision, transitions };
    // Complete before visible: a partial file that *exists* would block the true winner from this
    // revision forever, which is why this is not `open(final, "wx")` and a direct write.
    await writeFile(temp, JSON.stringify(payload), "utf8");
    await this.#fsync(temp);

    try {
      await link(temp, final);
    } catch (error) {
      await unlink(temp).catch(() => undefined);
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        const commits = await this.#readCommits(grantId);
        return { kind: "conflict", currentRevision: commits.length };
      }
      throw error;
    }
    await unlink(temp).catch(() => undefined);
    // Durability, separate from linearization. Only after this may the commit be acknowledged.
    await this.#fsync(dir);
    return { kind: "appended", revision };
  }

  async #fsync(path: string): Promise<void> {
    const handle = await open(path, "r").catch(() => undefined);
    if (handle === undefined) return;
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async #grantIds(): Promise<string[]> {
    try {
      return (await readdir(this.#root, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      return [];
    }
  }

  async #readCommits(grantId: string): Promise<CommitFile[]> {
    const dir = join(this.#root, grantId, "commits");
    let names: string[];
    try {
      names = (await readdir(dir)).filter((name) => name.endsWith(".json")).sort();
    } catch {
      return [];
    }

    const commits: CommitFile[] = [];
    for (const [index, name] of names.entries()) {
      const parsed = JSON.parse(await readFile(join(dir, name), "utf8")) as CommitFile;
      // A gap is not producible by a correct writer — a commit may only claim N+1 having read N as
      // current — so a gap is corruption. Refusing beats reducing a shorter stream and reporting a
      // smaller balance as though it were the answer.
      if (parsed.revision !== index + 1) {
        throw fileStoreError(
          FileStoreErrorCodes.RESERVATION_STREAM_CORRUPT,
          `The reservation stream for grant "${grantId}" is missing revision ${index + 1}. A gap ` +
            "cannot be produced by a correct writer, so this stream is not projected: a shorter " +
            "history would understate committed authorization.",
          {
            category: "conflict",
            retryable: false,
            details: { grantId, expectedRevision: index + 1, found: parsed.revision },
          },
        );
      }
      commits.push(parsed);
    }
    return commits;
  }
}
