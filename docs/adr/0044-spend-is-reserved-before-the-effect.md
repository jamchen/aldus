# ADR-0044: Spend is reserved before the effect, and settled from what the provider reports

- Status: Accepted
- Date: 2026-08-20
- Relates to: §13.2 Authorization, §19.1 Concurrency, §19.3 Cost governance, §20 Production trace
- Relates to ADRs: ADR-0009, ADR-0030, ADR-0043
- Issue: #155. Composes with #107, #136, #148, #149, #150, #152.

## Context

Aldus authorizes estimated spend before execution and records a `CostRecord` after it. Between
those two points there is nothing.

```text
check available budget  →  dispatch paid request  →  record observed cost
```

Three failures live in that gap, and they are not variations of one another:

- **Concurrency.** Two executions read the same remaining headroom and both dispatch before either
  cost record exists. Neither decision was wrong and the ceiling is exceeded.
- **Indeterminate billing.** A provider charges and does not say how much. #150 made that
  representable and fail-closed, but only _after_ the money moved.
- **Persistence failure after dispatch.** The provider was called, the write fails, and nothing
  durable says money may be committed. That is #152, and it has no state to recover into.

An adopter proposed an `agent.spend` decrement. The need is real and the shape is wrong twice over:
it places authority with the party doing the spending, and it covers agents only — not TTS, not
paid Workers, not media generation.

## Decision

**Aldus owns the spend-control protocol and state machine. Adopters own budget policy. Adapters own
provider billing facts and enforcement capabilities.**

An Agent, Worker or Adapter may _report_ or _request_ spend. It must not authorize itself, mutate a
counter, or supply Runtime attribution. This is the rule #107 already established for
`authorizationId` and ADR-0043 established for `delivery.adapterId`, applied to the thing those two
were protecting.

Availability is **derived, never maintained**:

```text
available = authorized maximum − settled charges − active reservations
```

A separately maintained balance is a second source of truth about money. This repository has spent
its week removing values that assert more than what established them.

### The ten open decisions

**1. `SpendReservation` is a Core schema with a service-owned lifecycle.** Same split as
`CostRecord`: Core defines and versions the record so one definition exists, is projected to JSON
Schema, and migrates under ADR-0003; `@aldus-runtime/services` owns creating and settling them. A
service-private type would put a durable money record outside the versioning discipline.

**2. Transitions are append-only; reservation state is derived.** ADR-0008 already establishes that
the log is sufficient and the cache is a rebuildable projection, and this is the domain where a
mutable row is least defensible. The atomic unit is _append a transition having derived
availability inside the same lease_, not _update a balance_.

**3. The lock scope is `grantId`.**

The first version of this said "the authorization", conflating two identities `SpendGrant` already
distinguishes: `decisionId` is the human decision that authorized the terms, `grantId` is the budget
pool whose headroom is consumed. **The contended resource is the pool.**

Partitioning by decision would make one `GateDecision` mean one budget pool — an implementation
shortcut hardened into a workflow restriction. Concretely: a gate authorizing agent spend that
shares a decision with `performance.freeze` would have an unresolved agent charge quietly reduce
what synthesis may spend, while a gate with its own decision would not, and **the two designs look
identical at the point someone chooses between them.**

An adopter wanting one episode-level ceiling above several grants states that as an explicit
aggregate policy. It must not be obtained accidentally by reusing a `decisionId`.

Locking the Run would permit the race the protocol exists to prevent; locking globally would
serialise unrelated work.

**Check-and-reserve commits through a linearizable compare-and-append operation scoped by
`grantId`.** The file-backed implementation may use `LockManager` to reduce contention, but **the
lease is not the correctness mechanism**: it detects lease loss _after_ the body has run and
supplies no fencing token, so a holder that lost its lease can still write. Correctness rests on a
storage primitive that permits exactly one writer to install the successor of an expected revision.

> **A revision comparison that is not atomic with installation of the successor revision is not
> compare-and-append.**

This corrects an earlier reading of this decision. "Under a lease" was taken to mean the lease
supplied the guarantee; it does not, and a design built on that reading would have let two writers
both pass a revision check and the slower one overwrite the faster one's committed transition. See
`docs/design/spend-reservation-store.md` for the file implementation's linearization point. A
process-local mutex remains no substitute for the contract §19.1 requires.

It goes behind `LockManager`, which §19.1 already requires to admit a distributed lease later. The
file lease is the current implementation and must not be the contract.

**4. With no estimate, refusal is the default and `maxPerRequest` is the reservation.**

Reserving nothing would let unestimated executions race freely — the defect wearing a fix. So an
execution with no estimate is **refused unless policy explicitly allows unestimated dispatch**, and
when allowed it reserves the grant's `maxPerRequest`, which is the most an operator authorized for
one request.

A grant with neither an estimate nor a per-request ceiling is refused outright: there is no amount
to reserve, and dispatching would be spending against a number nobody stated.

This over-reserves, and blocks concurrent work that would have fitted. That is the safe direction
and the cost is stated rather than hidden: an operator who wants the concurrency raises the ceiling
or supplies estimates.

**5. An unknown charge blocks the grant, unless _that execution_ was dispatched under an enforced
ceiling.**

#150's shipped behaviour is the default and stays: while an unresolved unknown charge stands, the
grant is indeterminate and automatic spend is refused.

A reservation adds something #150 did not have — an **upper bound**. But the bound is a fact about
_the execution that happened_, not about the backend in general, and the two are not
interchangeable. A backend that declares `enforcesSpendCeiling` today says nothing about a request
dispatched last week by an earlier version, or about a request the Runtime never actually handed a
ceiling to.

So the execution-time facts are persisted on the reservation and read from there:

```ts
ceilingEnforced: boolean;
appliedCeiling?: Money;
backendId: string;
backendVersion: string;
```

**Never re-read a backend's current capabilities to infer that an earlier request was bounded.**
That is the ADR-0030 defect in its purest form — claiming a protection from a declaration that was
not the one in force.

The narrower behaviour applies only when every one of these holds:

- a reservation existed **before** dispatch;
- the reservation amount was passed as the execution ceiling;
- **that exact backend version** declared `enforcesSpendCeiling`;
- the Runtime recorded that the ceiling was applied;
- the unresolved reservation is still active and still consuming its full reserved amount.

If any fact is absent, the whole grant stays blocked.

**6. A reservation supplies the _authorization_ currency, which is not the provider's billing
currency.**

The first draft of this ADR said a reservation "supplies the currency an unknown charge lacks".
That was wrong, and wrong in the direction this repository keeps having to correct: it would have
restated a fact about what Aldus authorized as a fact about what a provider charged.

```text
reservation currency  = the currency in which Aldus reserved authorization
billing currency      = the currency the provider reports for the charge
```

An amount-less unknown observation may have **no known billing currency**, and its billing currency
must not be populated or inferred from the reservation — unless the contract requires provider
billing to use the grant currency and validates that before dispatch, which it does not.

A report may truthfully say _"USD 2.00 remains reserved against this authorization because billing
is unresolved."_ It must never restate that as _"the provider made an unknown USD charge."_

Two fields, from two sources, kept apart:

```ts
reservedUnknownByCurrency: Record<string, string>; // derived from reservations
unquantifiedUnknownBillingRecordCount: number; // the provider-billing fact from #150
```

When a provider later reports an amount, a currency mismatch against the reservation is **rejected
or explicitly reconciled**, never implicitly converted.

**7. Reconciliation is linked by `providerRequestId`, captured before the write is attempted, and
lineage is navigable in both directions.**

`SpendReservation.costIds` and `CostRecord.reservationId` are both recorded — one link is
traversable in one direction, and reconciliation needs to start from either end. `reservationId` is
optional **only** for records predating this protocol, and like `authorizationId` it is
Runtime-supplied: a backend must never provide it. The reservation must carry the provider request
identity _from the dispatch_, not from a cost record that may never have been written — which is
#152's requirement, and the reason that issue is a required acceptance case rather than a
follow-up.

**8. Every gateway that can cause a charge adopts it, and completeness is testable.** Agent
execution, synthesis, paid Worker invocations, and any paid release operation. The completion
criterion is not a list — lists go stale — but the property that **no path to a paid effect
bypasses the service**, asserted the way `public-surface.test.ts` asserts reachability.

**9. Cost records predating reservations stay valid.** An absent reservation reads as _recorded
before reservations existed_, never as _unreserved and therefore unauthorized_. Availability counts
them as settled charges, which they are. Same rule as `expectedArtifacts` and `retrySafety`.

**10. Reservation state is surfaced where the retry decision is made.** ADR-0043 put `retrySafety`
and its reason on the attempt because the ruling on #148 required the retry decision to _read_ them
rather than file them. Reservations extend the same requirement: a `billing_unknown` reservation
must appear in the refusal an operator sees and in `aldus budget status`, not only in the trace.

### A grant states what it may be spent on

`SpendGrant.scope.operations` — adopter-defined open strings, `"agent.execute"`,
`"tts.synthesize"` — checked before reserving. Without it a grant is a pool of money with no
statement about its purpose, and the only thing separating agent spend from a synthesis ledger is
which decision each happened to name.

Scope is bound into the authorization digest, so `grantLimitsDigest` becomes `grantTermsDigest`:
widening a grant from agent-only to TTS-capable changes what an approval permits exactly as raising
its ceiling does, and an approval that survives that change did not bind what it appeared to bind
(§13.2).

### Settlement ordering fails closed

A `CostRecord` and a reservation transition may not share one physical transaction, so the order is
part of the contract rather than an implementation detail:

1. append the `CostRecord`;
2. append the reservation settlement transition;
3. derive the reservation as inactive **only after both facts exist**.

If step 1 succeeds and step 2 fails, the reservation stays active and authorization is
conservatively double-counted until reconciliation. That is recoverable.

**The reverse order is not.** Marking a reservation settled before the cost record is durable
releases authorization while the charge is absent — money spent, budget restored, nothing recorded.

If the `CostRecord` append fails, the reservation stays `reserved` or `billing_unknown`, the caller
receives a non-retryable reconciliation outcome, and #152's path is what handles it.

### What a reservation does not prove

A reservation limits what **Aldus** authorizes. It does not prove the provider cannot charge more.
Where a backend cannot enforce a ceiling, the trace must say the Runtime could only enforce
_between_ executions — the distinction #107 already requires and this must not blur.

## Consequences

- `CostRecordStore` is `list`/`append` with no transaction, so reservations need a store whose
  check-and-append is atomic under a lease. That is new infrastructure, and naming it early is
  better than discovering it during implementation.
- Refusing unestimated dispatch by default will refuse work that used to proceed. Deliberate, and
  the loudest part of this change for adopters.
- The protocol must be adopted by every paid gateway before it means anything: one gateway wired
  and another not is a budget that holds unless you use the other one.

## Sequencing

Not one change. In order, each shippable:

1. `SpendReservation` schema and the derived-availability calculation.
2. The reservation store and its lease boundary.
3. `AgentExecutionService` adoption — #107's path is live and its adopter is in the loop.
4. Synthesis and paid Worker adoption, with the no-bypass assertion.
5. Reconciliation surfaces, which are where #152 lands.

Steps 1 and 2 answer nothing on their own: a reservation nothing reserves against is a record. The
first point at which this issue's defect is actually closed is step 3.

## Alternatives considered

- **An agent-owned `spend(amount)` decrement.** Rejected as proposed in the issue: authority at the
  wrong boundary, and agent-only coverage for a problem every paid adapter has.
- **A maintained balance.** Rejected: a second source of truth about money, reconciled by hand
  against the records it summarises.
- **Reserving zero when no estimate exists.** Rejected: it makes unestimated executions invisible to
  concurrency control, which is the case most likely to be dispatched in a loop.
- **Blocking only the reservation's own scope on unknown billing, unconditionally.** Rejected as a
  default: bounding exposure by the reservation assumes the provider honours a ceiling, and for a
  backend that does not declare enforcement that assumption is the thing being tested.
