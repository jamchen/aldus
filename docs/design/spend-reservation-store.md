# Design pass: the spend reservation store (#155 step 2)

Realizes ADR-0044. No new ADR — nothing here changes its accepted atomicity or lifecycle
semantics, and the one place it sharpens them is noted at the end.

**Not implemented.** This is the shape for review.

## 0. The finding that shapes everything below

**`LockManager` does not fence. It detects.**

`FileLockManager` acquires with `O_CREAT | O_EXCL`, and a contender may reclaim a lease it judges
stale — by TTL expiry or by the holder's process being gone. `withLock` then checks on the way out:

```ts
const stillHeld = await lease.release();
if (!stillHeld) throw fileStoreError(FileStoreErrorCodes.LOCK_LOST, …);
```

That reports _"the operation's result is not trustworthy"_ **after the body has run**. Nothing stops
a holder that lost its lease from writing in the interval before it finds out. There is no fencing
token, and the port could not carry one today.

So a design of the form _acquire the lease, then append_ is safe only while nothing goes wrong, and
"nothing goes wrong" is the condition a concurrency mechanism exists to survive without.

**This is why compare-and-append is the recommendation rather than a preference.** The revision
check is the fence. The lease is an optimisation that reduces contention; correctness does not
depend on it, and must not, because the lock contract cannot supply it.

Do not claim distributed safety from this lock. What the file implementation provides is
mutual exclusion in the common case plus a conflict-detecting write; what makes it correct is the
second half.

## 1. The port

```ts
/** One appended fact about a reservation. Never edited. */
export interface SpendReservationTransition {
  transitionId: string;
  reservationId: string;
  grantId: string;
  kind: SpendTransitionKind;
  at: string;
  /** Kind-specific payload; see §2. */
  detail: Readonly<Record<string, unknown>>;
}

export interface GrantReservationStream {
  grantId: string;
  /** Number of transitions committed. The value a writer must expect to still be current. */
  revision: number;
  transitions: readonly SpendReservationTransition[];
}

export type CompareAndAppendResult =
  { kind: "appended"; revision: number } | { kind: "conflict"; currentRevision: number };

export interface SpendReservationStore {
  readGrant(grantId: string): Promise<GrantReservationStream>;

  /**
   * Append iff the stream is still at `expectedRevision`.
   *
   * The atomicity guarantee lives here rather than in a lock the caller must remember to take:
   * **no transition is appended on the assumption of revision N once another writer has committed
   * N+1.** A file implementation may take a lease and re-check; a SQL one may use a transaction;
   * a remote one may use compare-and-swap. The port states the guarantee, not the mechanism.
   */
  compareAndAppend(input: {
    grantId: string;
    expectedRevision: number;
    transitions: readonly SpendReservationTransition[];
  }): Promise<CompareAndAppendResult>;

  get(reservationId: string): Promise<SpendReservation | undefined>;
  listByRun(runId: string): Promise<readonly SpendReservation[]>;
}
```

**There is no public `append()`.** An unconditional append beside a conditional one is an unsafe
API a future caller reaches for at 5pm, and the unsafe path must be unrepresentable rather than
discouraged. `LockManager` is an implementation detail of the file adapter and appears in no
service signature.

## 2. Transitions

| kind                              | appended when                               | detail                                                                                   |
| --------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `reservation.reserved`            | authorization is committed, before dispatch | `authorizationId`, `operation`, `runId`, `stageId`, `attemptId`, `effectKey`, `reserved` |
| `reservation.dispatch_prepared`   | **before** the provider call                | `backendId`, `backendVersion`, `ceilingEnforced`, `appliedCeiling?`                      |
| `reservation.dispatch_identified` | `providerRequestId` becomes known           | `providerRequestId`                                                                      |
| `reservation.settled`             | a `CostRecord` is durable                   | `costIds`                                                                                |
| `reservation.released`            | free or voided outcome                      | `reason`                                                                                 |
| `reservation.billing_unknown`     | charged, amount not reported                | `costIds`                                                                                |
| `reservation.reconciled`          | a human or a provider lookup resolved it    | `costIds`, `resolution`, `decidedBy`                                                     |

`dispatch_identified` is split from `dispatch_prepared` deliberately — see §5's crash window.

**Repeat semantics.** A transition whose `transitionId` is already present with byte-identical
`detail` is idempotent and the append reports success without a second entry. A `transitionId`
reused with different contents is refused: two different facts under one identity is the defect
this repository has removed four times elsewhere.

## 3. State machine

```text
                 ┌──────────────────────────────────────┐
                 │              reserved                │
                 │  (dispatch_prepared / _identified    │
                 │   annotate; they do not change state)│
                 └───┬──────────────┬──────────────┬────┘
                     │              │              │
                 settled        released     billing_unknown
                     │              │              │
                     ▼              ▼         ┌────┴─────┐
                 (terminal)    (terminal)  settled   released
                                              │         │
                                              ▼         ▼
                                          (terminal) (terminal)
```

`settled` and `released` are terminal: **a reservation that stopped consuming authorization never
resumes.** `billing_unknown` keeps consuming its full reserved amount and may resolve either way.
`reservation.reconciled` records how a `billing_unknown` was decided and is always accompanied by
the `settled` or `released` transition it justifies.

Any other transition is rejected at append time, inside the atomic boundary — not at read time,
where the stream would already be wrong.

## 4. Reserve and settle

```text
reserve(input):
  for attempt in 1..MAX_CONFLICT_RETRIES:
    stream   = store.readGrant(grantId)              # revision N
    state    = reduce(stream)                        # authoritative
    existing = state.byEffectKey(input.effectKey)

    if existing and terms identical:   return existing        # idempotent
    if existing and terms differ:      refuse EFFECT_KEY_CONFLICT

    refuse if checkSpendScope(grant, input.operation)
    availability = availableAuthorization(grant, costs, state.reservations)
    refuse if not availability.determinate                    # #150 composes here
    refuse if amount > availability.available

    result = store.compareAndAppend({ grantId, expectedRevision: N, transitions: [reserved] })
    if result.kind == "appended":  return projection
    # conflict: another writer committed. Recompute from scratch — never reuse `availability`.
  refuse RESERVATION_CONTENDED
```

A conflict is ordinary concurrency, not an error. **Availability is recomputed after every
conflict**, because the answer that lost the race was computed against a stream that no longer
exists.

```text
settle(reservation, observations):
  costIds = costs.append(...)          # 1. cost record durable FIRST
  store.compareAndAppend([settled])    # 2. then the transition
  # inactive only once both facts exist
```

If step 1 succeeds and step 2 fails, the reservation stays active and authorization is
conservatively over-counted until reconciliation — recoverable. The reverse would release
authorization while the charge is absent, which is not.

## 5. Failure and atomicity matrix

| moment                                             | durable facts                    | reservation reads as                            | retryable              |
| -------------------------------------------------- | -------------------------------- | ----------------------------------------------- | ---------------------- |
| crash before append                                | none                             | never existed                                   | yes — nothing happened |
| crash after `reserved`                             | reserved                         | authorization committed, **dispatch not begun** | yes                    |
| crash after `dispatch_prepared`, before the call   | reserved + prepared              | **may have begun — indeterminate**              | **no**                 |
| crash after the call, before `dispatch_identified` | reserved + prepared              | **may have begun — indeterminate**              | **no**                 |
| provider returned, cost append failed              | reserved + prepared + identified | dispatched, settlement unrecorded               | **no** — #152          |
| cost appended, settle transition failed            | cost record + reserved           | over-counted, reconcilable                      | **no**                 |
| both appended                                      | terminal                         | settled                                         | n/a                    |

**The crash window the ruling names is rows 3 and 4, and they are deliberately identical.** Between
appending dispatch intent and learning `providerRequestId`, nothing distinguishes "about to call"
from "called and lost the answer". That state stays **reserved and non-retryable until reconciled**,
and is never read as _not dispatched_ — reading it that way is how a paid call is repeated.

`dispatch_prepared` is appended _before_ the call precisely so this window is visible rather than
inferred. A reservation that merely exists is not proof the provider was called; a reservation
carrying `dispatch_prepared` is proof it **may** have been.

## 6. File-backed implementation

| requirement                   | how                                                                                                                                                                                    |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| lease namespace               | `spend-reservation:${grantId}`, canonical grant identity, so separate grants never contend                                                                                             |
| validate before acquiring     | grant exists, scope permits the operation, amount well-formed — refuse before taking a lease nobody needs                                                                              |
| revision re-check under lease | re-read the stream inside `withLock` and compare to `expectedRevision`; append only on a match                                                                                         |
| crash-safe append             | write to a temp file in the same directory, `fsync`, atomic `rename`                                                                                                                   |
| stale writer                  | **cannot be prevented — see §0.** The revision check is what makes a stale write fail, and `withLock` additionally raises `LOCK_LOST` afterwards. The lease is not the safety property |
| bounded retry                 | small fixed cap, recomputing every time; then a structured `RESERVATION_CONTENDED` refusal                                                                                             |
| recovery after termination    | nothing to recover: the stream is the state, and a partial append leaves the previous file intact                                                                                      |
| concurrent grants             | different lease resources and different files, so they proceed independently                                                                                                           |

## 7. Rebuildability

The **transition stream is authoritative**. Revision is `transitions.length` — derived, never
stored, so a gap is not representable and a duplicate cannot advance it.

`get(reservationId)` and `listByRun(runId)` need a cross-grant lookup, which the per-grant streams
do not provide. The index that supplies it is a **hint, never a balance**: it maps
`reservationId → grantId` and `runId → grantId[]`, and every authoritative read then goes to the
grant stream and reduces it. A damaged or missing index is discarded and rebuilt by scanning; a
stale index can only cause a slower correct answer, never a different one.

That is ADR-0008's rule applied to money: the log is sufficient, the projection is a convenience,
and no cached figure is ever the answer to "how much is available".

## 8. Acceptance and mutation tests

Acceptance: two concurrent reservations against insufficient headroom and only one succeeds; the
same `effectKey` reserved twice returns one reservation; the same `effectKey` with different terms
refuses; N billed effects create N reservations; no provider call before the reservation commits; a
refused reservation produces no provider call; conflict retry recomputes rather than reusing;
settled and released are terminal; `billing_unknown` keeps consuming and blocks retry; a repeated
identical transition is idempotent and a reused id with different contents refuses; separate grants
proceed concurrently; `get`/`listByRun` return the same answer with the index deleted; a stream with
an illegal transition is refused rather than projected.

Mutations that must fail:

- check and reserve separated into a race-prone sequence — **the ruling names this one**;
- `expectedRevision` ignored, or the append made unconditional;
- availability reused after a conflict instead of recomputed;
- the lease held across the provider call;
- settle ordering reversed;
- an indeterminate dispatch window read as _not dispatched_;
- a terminal reservation returned to active;
- `billing_unknown` treated as releasing its amount;
- the index consulted as authoritative rather than as a hint.

## 9. Alternatives

**Unconditional `append()` under a caller-managed lock — rejected.** It is the shape the ruling
rules out, and §0 is why it is worse than it looks here specifically: the lock cannot fence, so
even a caller who remembers it is not safe. It makes correctness depend on a discipline _and_ on a
guarantee the lock does not provide.

**Callback-style transaction, `store.transact(grantId, body)` — rejected, and it was close.** It
makes the unsafe path unrepresentable too, and reads well. It loses on two counts: the body runs
inside the store's concurrency scope, which invites doing I/O there — including, eventually, the
provider call the dispatch boundary forbids — and the retry-on-conflict policy becomes the store's
rather than the service's, hiding from the caller that its availability calculation was thrown away
and redone.

**Store-owned high-level `reserve()` — rejected.** It puts policy in the storage port: scope
checking, availability, #150 composition and the refusal vocabulary would all move behind an
interface whose job is durability. ADR-0044 assigns lifecycle and availability decisions to
`SpendService`, and this would quietly reassign them.

**Compare-and-append — recommended.** The guarantee is in the operation rather than in a convention;
the port describes a property a file, a transaction or a remote CAS can each honour; the service
keeps the policy and visibly owns its retry loop; and it is the only option whose correctness does
not rest on the fencing `LockManager` cannot give.

## What this sharpens in ADR-0044

Nothing contradicts it. One thing is more specific than the ADR could be: **the lease is not the
atomicity mechanism**, because the lock contract detects loss rather than preventing writes. ADR-0044
says check-and-reserve happens "under a lease"; this says it happens under a _revision check_, with
the lease reducing contention. If that reads as a change to accepted atomicity semantics rather than
a realization of them, the ADR should be amended and this design should wait.
