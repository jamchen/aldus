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

**3. The lock scope is the authorization, not the Run.** The grant is the contended resource: two
Runs drawing on one grant contend, two Runs on different grants do not. Locking the Run would
permit exactly the race the protocol exists to prevent, and locking globally would serialise
unrelated work.

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

**5. An unknown charge blocks the grant, unless the backend enforces a ceiling.**

#150's shipped behaviour is the default and stays: while an unresolved unknown charge stands, the
grant is indeterminate and automatic spend is refused.

A reservation adds something #150 did not have — an **upper bound**. Where the backend declares it
`enforcesSpendCeiling`, the exposure of an unknown charge is bounded by what was reserved, and the
grant may continue with that reservation retained. Where the backend does not, the bound is a hope
and the whole grant stays indeterminate.

That distinction rests on the capability declarations #107 established, and it is exactly ADR-0030's
rule: a protection is claimed only where something enforces it.

**6. The reservation supplies the currency an unknown charge lacks.** #150 had to add
`unquantifiedUnknownBillingRecordCount` because an amount-less charge has no `Money` to derive a
currency from. A reservation is denominated in the grant's currency, so once one exists the currency
is known even when the amount is not. Reports keep the counter — pre-reservation records still
exist — and gain a currency for reserved-but-unsettled spend.

**7. Reconciliation is linked by `providerRequestId`, captured before the write is attempted.**
`SpendReservation.costIds` links settled records. The reservation must carry the provider request
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
