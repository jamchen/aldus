# ADR-0009: Gate binding, cascading invalidation, and spend grants

- Status: Accepted
- Date: 2026-08-18
- Closes: nothing in §25; this records the decisions WP-05 had to make where §13 is silent
- Relates to: §3.6, §12, §12.1, §13, §17, §19.2, §19.3, §24, ADR-0004, ADR-0005, ADR-0006

## Context

Contract §13 gives `GateDecision` a field list and four worked examples, but leaves the mechanics
of enforcement open. Three requirements in particular have no stated implementation:

> §13.1 — Any content-changing edit MUST invalidate it **and downstream approvals**.

> §13.2 — Paid TTS MUST NOT run until the operator approves [five things, including a] maximum
> authorized cost. The authorization MUST be invalidated if any bound value changes.

> §13.4 — Uploading and making public SHOULD be separate operations.

§24 makes two of these conditions of V1 being done: "paid TTS cannot execute without valid
hash-bound authorization" and "Human Gate decisions survive Agent session changes". §1.1 names the
failures being guarded against — duplicate paid TTS requests, and unsafe all-or-nothing publishes.

Two things make this harder than storing a boolean per gate. First, "downstream approvals" implies
a dependency structure §13 never defines. Second, §13.2 requires the operator to approve a
_maximum authorized cost_, but `GateDecision` stores only `subjectHashes` — digests, not values —
so the ceiling cannot simply live in the decision.

## Decision

### 1. Invalidation is derived on every evaluation, never stored

A gate's state is computed from three inputs: its latest decision, the current digests of what it
binds, and the states of the gates it depends on. Nothing is marked invalid; there is no validity
flag anywhere.

The alternative — writing invalidation records and walking the graph marking approvals dead — has a
failure mode the contract cannot tolerate. If that walk is interrupted, or a dependency edge is
added after some approvals already exist, an approval stays marked valid while what it approved has
moved underneath it. §13.2 forbids exactly that, and a safety property that depends on a background
pass having completed is not a safety property.

Deriving instead means a stale approval has nowhere to survive. It also makes adding a dependency
edge take effect immediately, with no migration over stored state.

The cost is that evaluation needs the current subject digests supplied by the caller. That is
accepted: the caller is the only party that knows what the content currently _is_.

### 2. A decision binds a sorted multiset of raw content digests

`subjectHashes` stores the raw SHA-256 of each bound value, sorted, with duplicates preserved.

**Raw, not a digest of `key + value`.** Hashing the pair would bind the key association more
tightly, but it would make a `subjectHash` unmatchable against an `ArtifactRef.sha256`, and §20
requires production trace to answer which inputs produced a result. Interoperability with the
artifact record is worth more than the marginal strength.

**A multiset, not a set.** Two subjects that happen to share a value are still two subjects.
Collapsing them would hide a change when one of them moves.

**No sidecar record of key-to-hash.** A separate record mapping keys to hashes could drift from the
decision it describes, and a safety check that depends on two records agreeing fails open the day
they disagree. The key-level explanation is instead _derived_ by diffing current subjects against
the stored list. Detection is therefore exact; attribution is best-effort, and in the one ambiguous
case — two subjects sharing a value, one of which changed — it may name both. That ordering is
deliberate: §13.2 requires detection, not attribution.

**A decision must bind everything its gate declares.** A decision covering four of five listed
values is refused rather than accepted-and-partially-bound, because §13.2 requires the operator to
approve all of them.

### 3. Only blocking gates propagate, and the sharper state wins

The cascade follows `dependsOn` edges, which are declared per gate rather than inferred from an
ordering the engine invents. Two refinements matter:

**Advisory gates do not propagate.** §12 level 2 is a signal that "reports a possible issue without
blocking". If an un-run advisory halted everything downstream, every advisory would be a hard gate
with a friendlier name and §12's four levels would collapse into two.

**A gate that is itself broken keeps its own state.** When a gate is both stale on its own account
and blocked upstream, it reports `stale` with `blockedBy` alongside — an operator told only
"blocked upstream" would fix the upstream gate and be surprised this one still needs re-approving.
A `pending` gate has no decision to preserve, so there `blocked_upstream` is the more useful label.

**A waiver unblocks but still expires.** §13 keeps `waived` distinct from `approved` because it
records that a check was bypassed. Bypassing is its purpose, so it unblocks downstream — but
waiving a check for one version of the content says nothing about the next, so drift voids a waiver
exactly as it voids an approval.

### 4. A spend grant's limits are themselves a bound subject

A `SpendGrant` holds the actual ceiling values, and `grantLimitsDigest(grant)` is included among
the gate's bound subjects. Authorizing a spend checks three things: the gate is satisfied, the
grant's limits digest appears in that decision's `subjectHashes`, and the amount fits the remaining
budget.

This is what resolves the tension in §13.2. Enforcing a ceiling needs its _value_; binding it needs
its _digest_. Holding the value beside the decision alone would let someone raise the ceiling
without touching the approval; holding only a digest would leave nothing to enforce. Doing both
means raising a limit changes the digest, which drifts from `subjectHashes`, which voids the
authorization — so the ceiling cannot move without an operator re-approving it.

Only the limits are digested, not the grant's identity: re-issuing an identical ceiling under a new
`grantId` should not read as approving something different.

A grant citing a superseded decision is refused even when a valid approval exists on the same gate,
because the grant names _which_ approval permitted it.

### 5. Unknown billing status counts against the budget

§19.3 requires "safe handling of unknown provider billing status". A cost record counts unless it
is `voided`; `unknown` counts, and an estimate counts when no actual charge is recorded yet.

Treating an unconfirmed charge as free is how a run whose provider never confirmed spends past its
ceiling with a ledger that looks clean. The conservative direction is the only safe one, and a
burst of in-flight estimated requests is exactly the case where the difference shows.

### 6. An approval authorizes only the operations its gate names

`grants` lists the operations a gate authorizes. An operation no gate grants is refused rather than
allowed — adding a gate is what enables an action, never omitting one.

This is how §13.4's separation is enforced rather than merely conventional. Upload and publication
are two gates granting two operations; approving the first leaves the second refused. The engine
does not know what either word means, which is the point: §4.2 keeps adopter process out of the
runtime, and §13's four gates are configuration an adopter writes.

### 7. Money is exact decimal arithmetic

Every operation scales both operands to a common exponent and works in `bigint`. Core models an
amount as a decimal string for this reason, and a `Number` anywhere in a budget check would undo
it. Amounts in different currencies are refused rather than converted: the rate is not something
this runtime holds, and a guessed rate misstates a ceiling an operator authorised.

## Consequences

- A stale approval cannot authorize spend, because there is no stored validity for it to survive
  in. That property holds without any background process running correctly.
- Evaluation requires the caller to supply current digests. A caller that supplies stale digests
  gets a stale answer — the engine cannot detect content it is not shown. This is inherent to
  deriving rather than storing, and the alternative was worse.
- Adding a dependency edge invalidates downstream approvals immediately. That is correct, and it
  means an adopter editing gate configuration should expect approvals to need re-taking.
- Attribution of _which_ subject drifted is best-effort. Detection is exact. If a future caller
  needs guaranteed attribution, the honest change is to bind `key + value` digests and accept
  losing artifact cross-referencing — a trade this ADR declines today.
- The engine holds no store dependency; it defines ports (§7) an adopter wires to
  `@aldus-runtime/file-store`. Whether these ports move to Core is left open, consistent with WP-02 and
  WP-03 deferring the same question until a second adapter exists.
- Nothing here runs a check. §12's evaluators, §12.1's calibration metrics (WP-10), the TTS ledger
  (WP-07), and release adapters (WP-12) sit outside. This package models decisions; it does not
  make them.

## Alternatives considered

- **Stored invalidation records.** Rejected: see decision 1. A half-applied cascade leaves an
  approval marked valid for content that has moved, which §13.2 forbids.
- **A `blocking: boolean` on each gate.** Rejected: §12.1 permits promotion to blocking "only after
  it is calibrated against human-labeled examples", and a boolean invites a one-word config edit.
  `level` plus `enforcement` plus required `promotionEvidence` makes promotion a decision someone
  has to justify — a blocking model-assisted gate without evidence is refused at registration.
- **Hardcoding §13's four gates.** Rejected: §4.2 and §4.3 leave show process to adopters. The four
  appear only in tests, which is where they demonstrate the model expresses §13 without the engine
  knowing their names.
- **Storing the spend ceiling in the decision's `comment`.** Rejected: unparseable, unbound, and it
  would make a free-text field load-bearing for a money check.
- **Treating unknown billing status as zero until confirmed.** Rejected: see decision 5.
- **Deriving the gate order from a linear pipeline.** Rejected: §13's gates are a graph, not a
  list — a thumbnail review sits off the content chain entirely — and inferring edges would make
  the cascade depend on the engine's guess rather than on stated configuration.
