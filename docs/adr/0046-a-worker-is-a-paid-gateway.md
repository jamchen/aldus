# ADR-0046: A Worker is a paid gateway and reserves like one

- Status: Accepted
- Date: 2026-08-21
- Relates to: §3.2 Workers, §13.2 Authorization, §19.1 Idempotency, §19.3 Spend, ADR-0035,
  ADR-0036, ADR-0043, ADR-0044, #107

## Context

`WorkerResult.costs` documented itself as _"the same observation contract an `AgentBackend`
reports, deliberately — §3.2's Workers include TTS invocation and rendering, which are paid, and a
Worker that knows what it spent must be able to say so through the same channel rather than a
parallel one."_

The channel dead-ended one line after the call. `runner.ts` returned the Worker's result unchanged
and nothing read `costs`. Measured through `AldusServices.init → startRun → runStage`, with a
Worker reporting `actual: 2.00 USD, billingStatus: "charged"`:

```
STAGE OUTCOME: ok
COST REPORT: { "records": [], "summary": { "recordCount": 0, ... } }
```

Two facts, not one. The runtime **knew** what was spent and did not record it, and the money was
spent against **no grant at all** — `runWorker` reached `Worker.execute()` with no expectation, no
authorization and no reservation.

The second is the worse one, and it also falsified a property already merged.
`no-spend-bypass.test.ts` stated its criterion as _"a paid effect cannot happen without a
reservation having been committed first"_ and enumerated two surfaces. `runWorker` was a third and
was not on the list. The list went stale the moment the Worker cost channel landed, which is what
lists do — and it is why the completion criterion is now behavioural.

ADR-0035 left cost authorization with the Stage. That was wrong in the same way asking a backend to
supply its own `authorizationId` is wrong: a Stage that forgets produces a charge nothing can hold
against a budget, and a Stage that names its own grant can name one that did not authorize it.

## Decision

**A Worker invocation is a paid gateway and adopts the common reservation protocol. The Runtime
owns reservation, attribution, settlement and retry safety; the Worker reports provider billing
facts only.**

### The declaration is required, closed, and checked before dispatch

`StageWorkerRequest.spend` is required. Its two arms make the invalid states unrepresentable:

- `{ expectation: { kind: "free" } }` — dispatches without a reservation;
- `{ expectation: estimated | unestimated, operation, billingEffectKey }` — reserves first.

A single closed `CostExpectation` beside two optional companions was rejected: it makes
`unestimated` with no operation representable, and that is a paid dispatch with nothing to check it
against.

**Absence is refused, never read as free.** Reading an absent declaration as free is precisely how a
paid Worker came to be dispatched against no grant.

**Post-dispatch detection was rejected as the immediate fix.** Throwing when `result.costs` arrives
is too late: the unauthorized effect has happened and the billing fact is still not durable. Every
refusal below happens before `Worker.execute()`.

### The refusals

A Worker invocation is refused, without dispatching, when it declares no expectation; when it
declares a paid one and no spend controller is wired; when no grant covers the operation; when the
grant's scope excludes it; when the estimate exceeds the grant's per-request or remaining total;
or when the grant's policy refuses an unestimated request.

Fail-closed on the missing controller is the load-bearing one. Dispatching because no enforcer is
present to object makes the protection depend on the configuration meant to enforce it.

### `CostExpectation` moves to Core

More than one dispatch path makes the declaration, and `stage-runner` must not depend on
`services` to name the shape of a promise it takes from its own callers (§4.3).

### Identity is per billed charge

`billingEffectKey` is neither the destination idempotency key nor the invocation key. ADR-0036
established that those answer different questions, and one Worker call may contain several
independently billed effects; a key with the wrong cardinality makes a retry resolve to a
reservation belonging to a different charge. The Runtime qualifies it with the Worker id and
version, so two Workers billed for one logical step do not collapse into one reservation.

### Capabilities mirror billing, and never carry an amount

`reportsActualCost`, `reportsEstimatedCost`, `enforcesSpendCeiling`, `supportsCostReconciliation`.
A ceiling is passed only when that exact Worker version declares it enforces one — passing a limit
to a Worker that ignores it records a protection that does not exist (ADR-0030). **The number is
always the Runtime's**, from what the grant authorized for this request. A capability saying "I
enforce a ceiling" must never be read as "and here is the ceiling": a spender does not choose its
own limit.

### Outcomes

- Billing facts returned → `CostRecord`s written **before** settlement, with Runtime attribution.
- Dispatched under a paid expectation and returned no billing facts, or threw after dispatch →
  the reservation is retained and the effect is non-retryable. A failure after dispatch is not
  proof of no charge (ADR-0044), and re-running would spend again on the assumption it was free.
- Declared free and charged anyway → durably recorded with **no** `authorizationId`, then a
  non-retryable failure. §20 must be able to answer what the Run cost; attaching a grant after the
  fact would invent an approval nobody gave.

## Consequences

- **A pre-existing defect surfaced and is fixed here.** `SpendService.reserve` — ADR-0044's
  "single authoritative pre-dispatch decision" — never checked `grant.maxPerRequest`. Scope and
  remaining total were carried over from `checkSpend` and the per-request limit was left behind, so
  a grant capping a single request at 2.0000 would authorize a 5.0000 one whenever the total had
  room. This affected **every** paid path, not only Workers. Found by a composed Worker test
  asserting that an over-ceiling estimate reaches no provider.
- Every existing Worker invocation must now declare `spend`. In-tree that is a one-line
  `{ expectation: { kind: "free" } }` on each, and it is the right friction: the author states what
  they believe, and a paid Worker declared free fails loudly the first time it charges.
- `AldusConfig` gains `workerSpendGrants`, keyed by `(runId, operation)`. Keyed by operation rather
  than by Worker deliberately — a grant authorizes what may be done and for how much, and keying on
  the implementation would let swapping a Worker change what is authorized.
- Absent grant provider means no operation may spend, rather than every operation being
  authorized.
- The surface-name list in `no-spend-bypass.test.ts` is replaced by composed behavioural tests. A
  list of paid paths cannot go stale if nothing consults it.

## Alternatives considered

- **Refuse post-dispatch when `result.costs` arrives (option A as originally proposed).** Rejected
  by the owner and correctly: the money is already spent, and the billing fact is still discarded.
  It converts a silent bypass into a loud one without closing it.
- **Record without reserving.** Rejected: it produces a system reporting accurate numbers about
  money nobody authorized, which reads as protection.
- **A second reservation protocol for Workers.** Rejected: a parallel protocol is a parallel place
  for the budget to be wrong.
- **Let the Stage supply `grantId`.** Rejected as #107's own defect class restated — a caller that
  names its own authorization can name one that did not authorize it.
