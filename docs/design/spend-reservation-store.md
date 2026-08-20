# Design pass: the spend reservation store (#155 step 2)

Realizes ADR-0044. No new ADR — nothing here changes its accepted atomicity or lifecycle
semantics, and the one place it sharpens them is noted at the end.

**Not implemented.** This is the shape for review.

## 0. Two findings, and the second corrects the first

### `LockManager` does not fence. It detects.

`FileLockManager` acquires with `O_CREAT | O_EXCL`, and a contender may reclaim a lease it judges
stale — by TTL expiry or by the holder's process being gone. `withLock` then checks on the way out:

```ts
const stillHeld = await lease.release();
if (!stillHeld) throw fileStoreError(FileStoreErrorCodes.LOCK_LOST, …);
```

That reports _"the operation's result is not trustworthy"_ **after the body has run**. Nothing stops
a holder that lost its lease from writing in the interval before it finds out. There is no fencing
token, and the port could not carry one today.

**No distributed safety is claimed from this lock**, and none may be claimed unless the chosen
storage primitive supplies it.

### A revision check is not itself a fence — and the first draft of this document said it was

The first draft concluded _"the revision check is the fence"_. That is wrong, and it is wrong in the
way this repository keeps finding: a statement that sounds like a guarantee while naming no
mechanism that provides it.

A revision comparison followed by an ordinary write is still check-then-act:

```text
stream revision = N
  A reads N, passes the revision check
  A pauses, or loses its lease
  B reclaims the lease, reads N, passes the revision check, commits N+1
  A resumes and writes its own N+1
```

If the commit is a temp file renamed over the whole stream, **A's rename destroys B's committed
transition.** Both writers checked. The check fenced nothing, because no primitive made _"revision
is still N"_ and _"install N+1"_ one indivisible operation. `LOCK_LOST` afterwards does not restore
B's transition; it reports untrustworthiness once the loss has already happened.

**The correct statement, and the one this design is now built on:**

> A revision comparison that is not atomic with installation of the successor revision is not
> compare-and-append.

So the port's contract is a **linearizable conditional commit**, and every implementation must be
able to name its linearization point — the single operation at which exactly one writer wins the
successor of revision N. §6 names the file implementation's.

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
  /**
   * Number of **commits**, not of transitions.
   *
   * One commit may carry several transitions — `reservation.reconciled` must land atomically with
   * the `settled` or `released` it justifies, or a reader could observe a reconciliation
   * explaining a state that has not happened. So a commit is the unit of atomicity *and* the unit
   * of revision: one immutable commit file advances the revision exactly once, whatever it
   * contains.
   *
   * Defining this as `transitions.length` would make the CAS revision depend on batch sizes, so
   * two writers proposing different batch shapes could compute the same expected revision from
   * different histories.
   */
  revision: number;
  /** Every transition, flattened across commits, in commit order. For reduction only. */
  transitions: readonly SpendReservationTransition[];
}

export type CompareAndAppendResult =
  /** This call created a new durable fact. */
  | { kind: "appended"; revision: number }
  /** These exact transitions were already committed — by an earlier attempt of this same call. */
  | { kind: "already_present"; revision: number }
  /** Another commit won the successor of the expected revision. Re-read and recompute. */
  | { kind: "conflict"; currentRevision: number };

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

**A commit is a batch.** `compareAndAppend` takes several transitions because some facts must land
together: `reservation.reconciled` must be atomic with the `settled` or `released` it justifies, or
a reader could observe a reconciliation explaining a state that has not happened.

### Decision order, so a retry is deterministic

1. **Every** supplied transition identity already present with byte-identical contents →
   `already_present`.
2. Any supplied `transitionId` present with **different** contents → refuse, identity conflict.
   Two different facts under one identity is the defect this repository has removed four times.
3. Otherwise, `expectedRevision` stale → `conflict`.
4. Otherwise, attempt the conditional commit.

**Rule 1 outranks rule 3, and that is what makes a lost response recoverable.** A caller that
committed successfully and never saw the answer retries with the same identities; its commit has
advanced the stream past the revision it still expects, so evaluating the revision first would
return `conflict` and send it looping to rediscover its own success — with the retry bound deciding
whether it ever learned the truth.

**`already_present` is never reported as `appended`.** A replay is not a newly committed fact, and
in this domain the fact is money.

### Who owns what

The store owns **durability**: transition schema validation, `transitionId` uniqueness,
expected-revision atomicity, the durable commit.

`SpendService` owns **policy**: lifecycle legality, scope, availability, and whether a proposed
transition is legal for the current projection.

The expected revision is what makes the service's decision safe: it validated against a revision it
read, and if the state moved the commit conflicts rather than applying a decision made against a
stream that no longer exists. **The reservation state machine does not move into a generic
durability adapter** — a store that knew the lifecycle would be a store making policy.

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

**Where that is enforced.** `SpendService` decides legality against the projection it reduced, then
commits with the expected revision it read. If another writer moved the state in between, the
commit conflicts and the service re-reduces and re-decides. The store does not know the state
machine; it enforces schema, identity and atomicity, and the expected revision is what makes a
policy decision taken a moment ago still safe to apply.

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
  # Cost ids are derived ONCE, before the loop, and are stable across every retry.
  costIds = deriveCostIds(reservation.reservationId, observations)
  costs.appendIdempotent(costIds, observations)      # 1. cost record durable FIRST

  for attempt in 1..MAX_CONFLICT_RETRIES:
    stream = store.readGrant(reservation.grantId)
    state  = reduce(stream)
    current = state.byId(reservation.reservationId)

    if current.terminal and current.costIds == costIds:  return current    # already settled by us
    if current.terminal and current.costIds != costIds:  refuse SETTLEMENT_CONFLICT

    result = store.compareAndAppend({ expectedRevision: stream.revision, transitions: [settled] })
    if result.kind in ("appended", "already_present"):  return projection
    # conflict: an UNRELATED transition advanced this grant. Re-read and try again — it is not a
    # reason to send an operator to reconciliation.
  refuse SETTLEMENT_CONTENDED
```

**Cost ids are derived once and reused.** Retrying after a transition conflict must not append a
second cost record under fresh ids: the money was charged once, and a retry loop that mints new
identities each pass turns a storage conflict into duplicated spend. `appendIdempotent` is a
no-op when the ids are already present.

**A conflict here is usually somebody else's reservation.** Grants are shared, so an unrelated
transition advancing the stream between the cost append and the settlement is ordinary — and
forcing manual reconciliation for it would make every busy grant look broken. Only a reservation
that reached a terminal state under _different_ cost ids is a genuine conflict.

If step 1 succeeds and the loop exhausts, the reservation stays active and authorization is
conservatively over-counted until reconciliation — recoverable. The reverse ordering would release
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

### The linearization point is `link()`, not `rename()`

The stream is **not** one file rewritten. It is a directory of immutable, single-writer commit
records:

```text
spend/<grantId>/commits/000001.json
spend/<grantId>/commits/000002.json
```

One file **is** one revision. Installing revision N+1 is installing `00000(N+1).json`, and the
commit sequence is:

```text
write the complete commit payload to a temp file in the same directory
fsync the temp file
link(temp, commits/<N+1>.json)      ← THE LINEARIZATION POINT
    ├── succeeds        → appended
    └── EEXIST          → conflict; somebody else won N+1
unlink the temp file
fsync the directory
```

`link()` refuses to replace an existing target and is atomic on a POSIX filesystem. **Exactly one
writer can create a given name**, so the interleaving in §0 ends differently: A resumes, attempts
`link` to `000002.json`, gets `EEXIST`, and learns it lost — with B's transition intact.

### Winning the revision and being durable are different facts

```text
link() success   = this writer won the revision
directory fsync  = the winning revision may be acknowledged as durable
```

A commit is **not** reported as appended until the containing directory has been `fsync`ed. Between
the two the writer has won and cannot prove it survived a power loss, and that window has its own
rule:

- **do not dispatch the paid effect** — an unacknowledged commit is not authorization;
- do not report an ordinary success;
- resolve by retrying with the **same stable transition identities**;
- if the immutable commit exists with identical contents → complete the durability step and return
  `already_present`;
- if it does not exist → retry the conditional append;
- if durability still cannot be established → fail closed with a structured indeterminate-storage
  outcome.

The stable identities are what make that recovery possible: without them a retry cannot tell its own
earlier commit from somebody else's.

`rename()` is what makes the first draft's design wrong: it replaces silently, so the loser
overwrites the winner and neither is told. `open(…, "wx")` also refuses to clobber, but the write
that follows is not atomic — a crash mid-write leaves a file that _exists_ and cannot be parsed,
blocking the true winner from ever claiming that revision. Only the temp-then-link split gives both
properties: complete before visible, and visible only once.

Revision is then `the highest N for which 000001..N all exist` — derived from the directory, never
stored. A gap is not producible by a correct writer (you may only claim N+1 having read N as
current), so a gap is corruption: refuse to project, with a structured error naming the missing
revision, rather than silently reducing a shorter stream.

### The lease is a contention optimisation, and correctness survives without it

Correctness must hold under lease expiry, a paused former holder, stale-lock reclamation,
`LOCK_LOST` after the body, and two writers reaching `link()` at once. It does, because none of
those can make `link()` succeed twice for one name.

**If the lease is lost after a successful commit, the commit still won.** The store re-reads
`commits/<N+1>.json` and compares its `transitionId` set to what it wrote: if they match, it
reports `appended`. Turning a durable, immutable, provably-ours commit into an ambiguous failure
because `withLock` complained on the way out would manufacture a reconciliation case out of a
success.

| requirement                   | how                                                                                                                                                                               |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| lease namespace               | `spend-reservation:${grantId}` — canonical grant identity, so separate grants never contend                                                                                       |
| validate before acquiring     | grant exists, scope permits the operation, amount well-formed                                                                                                                     |
| revision re-check under lease | re-read the directory inside `withLock`; the `link` still decides                                                                                                                 |
| crash-safe append             | temp file, `fsync`, `link` (linearization), `fsync` directory (durability); a crash between the two is unacknowledged, undispatched, and resolved by retrying the same identities |
| stale writer                  | **cannot write over a winner** — `link` returns `EEXIST`. The lease does not provide this and never did                                                                           |
| bounded retry                 | small fixed cap, recomputing availability every pass, then `RESERVATION_CONTENDED`                                                                                                |
| recovery after termination    | nothing to recover: committed files are immutable, and an orphaned temp file is unreferenced garbage                                                                              |
| concurrent grants             | separate directories and separate lease resources                                                                                                                                 |

### What is still not claimed

`link()` gives single-writer-wins on **one filesystem**. It is not a distributed guarantee: two
hosts against one network filesystem inherit that filesystem's semantics, which are not this
design's to assert. A distributed deployment needs a store whose primitive supplies it — SQLite,
a database transaction, or a service with compare-and-swap — behind the same port.

## 7. Rebuildability

The **transition stream is authoritative**. Revision is the number of committed batches — derived
from the directory, never stored — so a gap is not representable and a duplicate cannot advance it.

### The index is a hint, and a hint cannot establish absence

The first draft said a stale index "can only cause a slower correct answer, never a different one".
That is false for the case that matters: **a syntactically valid but stale index is missing the
newest reservation**, and "rebuild when damaged or missing" does not detect that, because nothing
about it is damaged.

So the index may narrow work, never conclude it:

- **`get(reservationId)`** — an index hit is a _candidate_: read that grant's stream and confirm.
  An index **miss must fall back to scanning the canonical streams** before returning `undefined`.
  Absence is a claim about everything, and an index is a claim about what it happened to record.
- **`listByRun(runId)`** — an index result is never treated as complete unless completeness is
  proven against authoritative stream revisions: the index would have to record, per grant, the
  revision it was built from, and every one of those would have to still be current. Without that
  checkpoint, `listByRun` scans. The index may order or narrow candidate reads only where doing so
  cannot omit a result.

That is ADR-0008's rule applied to money: the log is sufficient, the projection is a convenience,
and no cached figure is ever the answer to "how much is available" — nor to "is there anything
else".

## 8. Acceptance and mutation tests

Acceptance: two writers reaching the commit primitive for the same revision and exactly one
winning, with the loser's payload absent from the stream; a paused writer resuming after another
committed and being refused rather than clobbering; **a failure injected between `link()` and the
directory `fsync`, after which the effect was not dispatched and a retry with the same identities
returns `already_present` rather than committing twice**; an index missing the newest reservation,
where `get` still finds it and `listByRun` still returns it; two concurrent reservations against
insufficient headroom and only one succeeds; the
same `effectKey` reserved twice returns one reservation; the same `effectKey` with different terms
refuses; N billed effects create N reservations; no provider call before the reservation commits; a
refused reservation produces no provider call; conflict retry recomputes rather than reusing;
settled and released are terminal; `billing_unknown` keeps consuming and blocks retry; a repeated
identical transition is idempotent and a reused id with different contents refuses; separate grants
proceed concurrently; `get`/`listByRun` return the same answer with the index deleted; a stream with
an illegal transition is refused rather than projected.

Mutations that must fail:

- check and reserve separated into a race-prone sequence — **the ruling names this one**;
- `link()` replaced by `rename()`, so a loser silently overwrites a winner;
- the commit written directly with `open(…, "wx")`, so a crash mid-write blocks the revision;
- `already_present` reported as `appended`, so a replay reads as a new durable fact;
- identity precedence inverted, so a caller whose commit already won loops on `conflict`;
- cost ids regenerated inside the settlement retry, so a conflict duplicates spend;
- a lost lease after a successful commit reported as failure;
- `expectedRevision` ignored, or the append made unconditional;
- availability reused after a conflict instead of recomputed;
- the lease held across the provider call;
- settle ordering reversed;
- an indeterminate dispatch window read as _not dispatched_;
- a terminal reservation returned to active;
- `billing_unknown` treated as releasing its amount;
- the index consulted as authoritative rather than as a hint;
- an index miss returned as `undefined` without scanning the canonical streams;
- a commit acknowledged before the directory `fsync`;
- revision computed from `transitions.length` rather than the commit count.

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

## ADR-0044 amendment (required, applied)

ADR-0044 said check-and-reserve happens _"under a lease"_, which reads as though the lease provides
atomicity. The design pass proved `LockManager` does not. The ADR now says:

> Check-and-reserve commits through a **linearizable compare-and-append** operation scoped by
> `grantId`. The file-backed implementation may use `LockManager` to reduce contention, but the
> lease is not the correctness mechanism: it detects lease loss after the body and supplies no
> fencing token. Correctness rests on a storage primitive that permits exactly one writer to
> install the successor of an expected revision.
>
> **A revision comparison that is not atomic with installation of the successor revision is not
> compare-and-append.**

Recorded there rather than only here, because the sentence it replaces is the one an implementer
would have read.
