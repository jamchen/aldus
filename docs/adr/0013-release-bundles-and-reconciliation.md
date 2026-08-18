# ADR-0013: Release bundles, adapter contracts, and reconciliation

- Status: Accepted
- Date: 2026-08-18
- Closes: nothing in §25; this records the decisions WP-12 had to make where §17 is silent
- Relates to: §1.1, §1.2, §4.2, §4.3, §13.4, §17, §19.1, §22, ADR-0005, ADR-0009

## Context

Contract §17 states that "publishing is a domain, not a single command", gives `ReleaseReceipt` a
field list, and sets four requirements it does not say how to meet:

> Each operation MUST be independently idempotent and resumable where the platform allows it.

> Pre-release hard gates and post-upload best-effort operations MUST be distinguished.

> Upload, review in platform UI, and public release SHOULD be separate states.

> [A `ReleaseBundle` MAY contain operations for] media upload; captions; thumbnail; title and
> description; privacy transition; playlist; podcast storage and RSS; notification channels.

§1.1 names the failure being guarded against: "unsafe all-or-nothing publish operations". §24
makes "release operations produce resumable receipts" a condition of V1 being done.

There is also a conflict inside the contract itself. §22's description of this work package names
two specific publishing platforms, while §4.2 forbids Core from owning "YouTube channel IDs or
podcast feeds", §1.2 rules out "prescrib[ing] YouTube or Podcast as the only release targets", and
§4.3 places release configuration in Integration. §22's wording is a description of what an
adopter will need, not licence to put it in the runtime.

## Decision

### 1. This package contains no platform client and names no platform

What ships is the adapter contract plus the resumable machinery around it. `ReleaseAdapter` has
two members — `execute` and an optional `lookup` — and the only implementation here is a
recording test double. There is no HTTP client and no platform SDK dependency.

Resolving §22's wording against §4.2 this way is not a close call: a package that knew how to talk
to a particular platform would make every adopter of Aldus depend on that platform's client, and
§4.3's dependency direction (`Adopter Integration → Aldus public contracts`) would be inverted the
moment a second adopter published somewhere else.

`lookup` is optional because §17 qualifies resumability with "where the platform allows it". A
destination with no way to query prior state genuinely cannot support reconciliation, and the
executor reports that rather than pretending otherwise — see decision 5.

### 2. Operation kinds and destinations are open strings

§17's list of candidate operations is an illustration. Modelling it as an enumeration would mean
an adopter needing a ninth kind must change Core, and would encode one publishing model as the
publishing model. `kind` and `destination` are open strings throughout, matching how
`ReleaseReceipt` already declares them.

### 3. The required/best-effort distinction is structural, not a field

A bundle holds two lists: `required` and `bestEffort`. The types are distinct and branded, so a
`RequiredOperation` cannot be placed in the best-effort list or vice versa — the compiler refuses.

The obvious alternative is `criticality: "required" | "best_effort"` on a flat list. Rejected: a
field is set at a call site, often far from where the consequence lands, and setting it wrongly
turns a failed thumbnail into a failed release or — much worse — a failed media upload into a
release that reports success. Requiring the caller to _place_ the operation makes that mistake a
type error rather than a typo. This is the same reasoning ADR-0009 applied to
`enforcement: "blocking" | "advisory"` rather than `blocking: boolean`.

Consequences of the split are enforced in execution order: required operations run first, and the
first failure stops the bundle, including the best-effort work. §17 calls those operations
"post-upload", and announcing a release that did not happen is worse than not announcing one that
did.

### 4. Idempotency keys are derived, never supplied

`deriveIdempotencyKey` digests the bundle id, operation id, kind, destination, and the sorted
input hashes. A resumed execution therefore computes the identical key without having to have
remembered one, which is what makes resumption work after a process died holding nothing.

Sorting the input hashes makes the key depend on the _set_ of things released rather than the
order a caller listed them. Changing what is released changes the key, so a re-cut render cannot
inherit the previous render's receipt and be skipped — the failure mode a caller-supplied
stable key would have introduced.

The key is passed to the adapter, so a platform that accepts client-supplied idempotency keys can
deduplicate remotely as well as locally.

### 5. An unconfirmed outcome is reconciled, never retried

`ReleaseReceipt` already has a `pending` status, and Core's own schema comment says why: an
operation whose outcome is not yet known must be representable "so it can be reconciled rather
than blindly retried".

So `AdapterOutcome` has three cases, not two. `pending` means the outcome is genuinely unknown — a
timeout, a connection lost after the request was accepted, a platform that acknowledges
asynchronously. Execution then does the following:

- Reconciliation runs **before** execution by default, so the safe path is what a caller gets
  without asking for it.
- Only operations without a terminal receipt are looked up. Asking again about a settled
  operation would turn reconciliation into polling.
- If the destination holds the result, the local record is repaired with a `succeeded` receipt
  and the operation is not repeated.
- If an operation has a `pending` receipt and its adapter has no `lookup`, execution **refuses**
  with `ALDUS_RELEASE_RECONCILIATION_UNAVAILABLE` rather than retrying. This is the one place the
  package would rather stop than act: retrying something that may already have published is the
  precise failure §1.1 calls unsafe, and it is not reversible from here.

An operation with _no_ receipt at all and no `lookup` is executed normally. Absence of a receipt
before any attempt is not ambiguity, and refusing it would make an un-queryable destination
unusable rather than merely un-resumable.

### 6. Authority is consumed from the gate engine, never re-decided

`@aldus/gate-engine` already models §13.4's separation of uploading from making public as two
gates granting two operations, and derives staleness from bound digests (ADR-0009). This package
asks it through a narrow `ReleaseAuthorizer` port and obeys the answer. It holds no opinion about
what "approved" or "stale" means.

A refusal on a **required** operation throws, non-retryably. §13.4 binds release approval to exact
inputs; continuing past a refusal with a warning would publish something unapproved, and a warning
that still publishes is not a gate. A refusal on a **best-effort** operation records a `skipped`
receipt and continues — it was never attempted, and a `failed` receipt would claim the destination
rejected it.

Subjects are read afresh on every check, so an approval that was valid when a bundle was assembled
and has drifted since is refused at the moment of release rather than at the moment of planning.

### 7. Bundle progress is derived from receipts, never stored

There is no persisted bundle state and no new file in §7's layout. `status()` recomputes
everything from the receipts in `release.json`.

Same reasoning as ADR-0009: a stored "in progress" flag outlives the crash that interrupted the
work it describes, and an operator then reads a status that was true once and is not true now.
Receipts are append-only — a retry after a failure appends rather than edits, because the fact
that the first attempt failed is what explains the retry — and the latest receipt per idempotency
key resolves the current outcome.

### 8. The executor holds no Run lock

`RunStore.addRecord` and `EventStore.append` each take the Run lock, and file locks are not
re-entrant (ADR-0005). An executor that took the Run lock around a bundle would be refused with
`ALDUS_LOCK_REENTRANT` on its first receipt. It therefore takes none, and a test exercises the
real file-backed stores end to end so that a future refactor reintroducing a lock fails loudly.

## Consequences

- An adopter writes one `ReleaseAdapter` per destination and gets idempotency, resumption,
  reconciliation, gate enforcement, receipts, and events without writing any of them.
- A destination whose adapter cannot implement `lookup` still works for first releases, but an
  operation left `pending` there needs an operator to establish the outcome. That is the honest
  position, and the error says so.
- Because progress is derived, two sessions executing the same bundle concurrently could both
  attempt an operation that neither has a receipt for yet. The idempotency key is what makes that
  safe at the destination, which is why it is passed through. A stronger guarantee would need a
  bundle-level lease, and ADR-0005's lock abstraction is where that would go.
- Best-effort failures are invisible unless someone reads the warnings or the receipts. That is
  the intended trade — §17 says they must not fail the release — but a surface that surfaces them
  belongs to WP-08's `status`.

## Alternatives considered

- **A `criticality` field on a flat operation list.** Rejected: see decision 3. Smaller, and it
  makes the most damaging mistake a one-word typo.
- **Executing the bundle as a transaction, all or nothing.** Rejected outright: §1.1 names
  "unsafe all-or-nothing publish operations" as a failure V1 must reduce, and there is no way to
  roll back a publish at most destinations anyway.
- **Caller-supplied idempotency keys.** Rejected: a caller that reuses a key after changing what
  is released silently inherits the old outcome, and one that forgets to reuse a key loses
  resumption entirely. Deriving removes both failure modes.
- **Retrying `pending` operations after a timeout.** Rejected: it is exactly the double publish
  this package exists to prevent, and the test file reproduces that duplicate before proving the
  prevention.
- **Re-deriving release approval here from `GateDecision` records.** Rejected: a second approval
  path is how an approval nobody recorded ends up authorizing something (§3.6).
- **A `ReleaseBundleStore` persisting progress.** Rejected: see decision 7. The receipts already
  say everything a bundle's state can be derived from, and a second record can only disagree.
