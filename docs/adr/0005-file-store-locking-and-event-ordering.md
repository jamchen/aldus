# ADR-0005: File-store locking and event ordering

- Status: Accepted
- Date: 2026-08-18
- Closes: architecture contract §25 item 3 (event ordering and file-lock implementation for local concurrent sessions)
- Relates to: §6.4 Event log, §7 Storage contracts, §19.1 Reliability, §10.2 Remote Control, ADR-0004

## Context

§19.1 requires Aldus to define concurrency and lease semantics, permits "simple file locking" for
V1 local interactive execution, and requires that the contract still allow stronger distributed
leases later. §25 item 3 leaves the mechanism open.

Concurrency here is not hypothetical. §10.2 treats Claude Code Remote Control as an ordinary
interaction surface, so an operator may drive one workspace from a terminal and a phone at once,
and §5.1 notes long pauses between stages are normal — which means sessions overlap in wall-clock
time far more often than they contend for the same instant.

Ordering is a separate problem from exclusion. Core mints ULIDs that sort by creation time and
are monotonic _within one process_: `createIdFactory` keeps per-factory state, and the
module-level factory is per-process. Two sessions appending to one `events.jsonl` therefore
produce IDs that sort by wall clock but carry no guarantee of a total order, because their clocks
are independent and their per-process counters are unrelated. §6.4 requires an immutable record
of every mutation; a log whose order cannot be reconstructed is a weaker artifact than that.

## Decision

### 1. Locks are advisory, file-based, and per-resource

`O_CREAT | O_EXCL` lockfile creation is the primitive. Check-and-create is a single syscall, so
two processes racing cannot both believe they won — everything else in the mechanism exists only
to stop a _dead_ holder from blocking the workspace.

Two resources are locked, not one:

- `episode` — the workspace-wide `episode.json`.
- `run-{run-id}` — one Run and all its files.

A single workspace-wide lock was the simpler option and is rejected: it would serialise work on
unrelated Runs, and §5.1's expectation of long-running interactive editing makes that a real cost
rather than a theoretical one.

### 2. Lockfiles live in `.aldus/locks/`, not in the run directory

§7 lists exactly six files in a run directory, and §7 recommends the layout be Git-friendly. A
lockfile among tracked state would carry one machine's PID into every checkout. `.aldus/locks/`
is created with a `.gitignore` that excludes its own contents.

### 3. A lease expires after 30 seconds without renewal

A lock is held for the duration of a **write**, never across a human gate — §13 gate decisions
are durable records, not held locks — so the TTL bounds a filesystem operation, not a workflow.
Thirty seconds is long enough that a slow or networked filesystem does not cause spurious theft,
short enough that a killed process does not block an operator for minutes.

There is no background heartbeat. A timer that renews a lock while the holder is wedged converts
a recoverable stall into a permanent one, and every operation in this package is short enough not
to need one. `Lease.renew()` is available for a caller that genuinely needs longer.

### 4. A dead holder is detected two ways

- **TTL expiry** — `renewedAt` older than the lease's TTL. Portable, and the only signal
  available across machines.
- **Process liveness** — `process.kill(pid, 0)` returning `ESRCH`. Stronger and immediate, but
  meaningful _only when the hostname matches_: a PID from another machine says nothing about a
  process on this one, and treating it as authoritative would let one machine steal another's
  live lock. `EPERM` means the process exists under another user, so the lock is legitimately
  held.

Reclaiming removes only the exact record observed as dead, identified by its `lockId`. Without
that check, a slow contender could delete a lock a third process had just legitimately acquired.
After an exclusive create succeeds, the acquirer re-reads the file and confirms its own `lockId`
is present; if a concurrent reclaim overwrote it, the acquisition is retried rather than
trusted.

An unparseable lockfile is treated as dead. It can only arise from a crash mid-create, and
refusing to proceed would wedge the workspace with no recovery short of manual deletion.

### 5. `withLock` fails loudly if the lease was lost mid-operation

If the body completed but the lease had been stolen, `withLock` throws `ALDUS_LOCK_LOST` rather
than returning. A body that ran believing it held exclusivity, and did not, may have interleaved
with another writer; reporting success would be a lie. If the body itself threw, that error
propagates unchanged — a lock diagnostic must never mask the failure a caller actually needs.

### 6. Events carry a required per-run sequence, assigned by the store

`AldusEvent.sequence` stays optional in the Core schema (ADR-0004), and the **store** requires
it: `append` assigns `max(sequence) + 1` under the Run's lock, and rejects an explicitly supplied
sequence that is not exactly the expected next value. Duplicate `eventId`s are rejected.

This is what makes the log totally ordered regardless of which session wrote which line, without
a schema change and without depending on clock agreement between machines. Enforcing it in the
store rather than the schema is deliberate: a different `EventStore` — a database with its own
sequence, say — can satisfy §6.4 differently, and a required schema field would have forced its
shape on every adapter.

The next sequence is derived from the highest stored value rather than the line count, so a log
read after a torn-tail recovery still assigns a value strictly greater than anything durable.

## Consequences

- **Locks are not re-entrant, and that is now enforced rather than merely true.** Because
  `append` takes the Run lock to assign a sequence, a caller that holds the Run lock and then
  emits an event waits on itself. This was found while building WP-04, where it presented as
  every test timing out. `acquire` now refuses immediately with `ALDUS_LOCK_REENTRANT` when the
  current async scope already holds the resource through the same manager, instead of spinning
  to the acquisition deadline and reporting "held by another session" — a message that sends the
  reader looking for a concurrent process that does not exist.

  The check is scoped by async context _and_ by manager instance, which is what keeps it from
  refusing legitimate work: two sibling tasks contending for one lock must still queue, and two
  managers in one process stand for two independent holders. The remedy for a genuine nesting is
  to give the inner operation its own lock resource, as the stage runner does for its cache.

- Two sessions may work on different Runs concurrently without contending at all.
- A crashed session's lock is reclaimed within 30 seconds, or immediately if it died on this
  host.
- `append` reads the whole event log to compute the next sequence and detect duplicates, so it is
  O(n) in the number of events for a Run. Acceptable for V1 local interactive use, where a Run's
  event count is bounded by human-paced editing. The fix, when it is needed, is a maintained
  index or a store that delegates ordering to a database — neither of which changes the port.
- The reclaim path has a narrow race: two contenders can both observe the same stale lock and
  both attempt to remove it. The `lockId` check plus the post-acquire verification reduce the
  outcome to a retry rather than a double-acquire. A genuinely atomic compare-and-delete is not
  available through Node's `fs`, so this is the honest limit of the file-based approach — and
  the reason the port exists for a real lease service to replace it.
- Locks are **advisory**. Nothing prevents a process that ignores this package from writing to
  `.aldus/` directly. Atomic writes mean such a writer cannot produce a torn file, but it can
  overwrite a concurrent update.

## Alternatives considered

- **`flock`/`fcntl` advisory locks.** Rejected: Node exposes no portable binding, behaviour over
  network filesystems is inconsistent, and the lock vanishes with the file descriptor, which
  makes stale-lock diagnosis impossible — an operator cannot read a stuck lock to see who holds
  it.
- **A single workspace-wide lock.** Rejected: serialises unrelated Runs (decision 1).
- **Background heartbeat timer.** Rejected: turns a wedged holder into a permanent blocker
  (decision 3).
- **Making `sequence` required in the Core schema.** Rejected: forces one ordering strategy on
  every future adapter, and ADR-0003 makes promoting an optional field to required a MAJOR bump —
  expensive to undo if a database-backed store orders differently.
- **Ordering by `eventId` alone.** Rejected: ULID monotonicity is a per-process guarantee, so two
  sessions with even slightly disagreeing clocks produce a log whose order cannot be
  reconstructed.
- **Refusing to write when any lock is contended.** Rejected: turns ordinary interactive overlap
  into a hard failure, when waiting a few tens of milliseconds resolves nearly every real case.
