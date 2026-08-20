# ADR-0047: A Stage dispatches an agent execution explicitly, and only single-shot

- Status: Accepted
- Date: 2026-08-21
- Relates to: §10 Agent backends, §13.2 Authorization, §19.1 Idempotency and cancellation,
  §19.3 Spend, §20 Trace, ADR-0030, ADR-0044, ADR-0046, #107

## Context

`AldusConfig.agentBackend` was accepted, carried into `StageRunner`, and used for exactly one
thing: `assertCapabilities`. `StageRunner` never called `execute`. The only caller of
`AgentBackend.execute()` in the tree was `AgentExecutionService`, and no composition constructed
one. `StageContext` offered `recordOutput`, `registerOutput`, `runWorker`, `note` — nothing that
reached a backend.

So an adopter who configured a backend could not dispatch it, deliberately or otherwise. #107's fix
was merged, exported, reachable from the package entry point, and unwired — the same composition
gap the fix was written to close, one layer up. Being importable is not being wired, and
`public-surface.test.ts` asks only the first question.

The obvious repair is the wrong one. Having `StageRunner` dispatch because a backend is configured
turns a **capability source** into an **execution instruction**: the field says what the runtime
_can_ do, and reading it as what the runtime _will_ do makes configuration into behaviour.

## Decision

**A Stage dispatches an agent execution by asking. `StageContext.runAgent` is explicit, and a
configured backend never dispatches on its own.**

### The Stage owns instructions; the Runtime owns everything else

`StageOwnedAgentRequest` is `Omit<AgentRequest, "executionId" | "signal" | "maxSpend">`. All three
are Runtime authority:

- `executionId` — the runner mints it, so a Stage cannot correlate its execution with another
  attempt's;
- `signal` — the attempt's, so cancellation reaches the backend (§19.1);
- `maxSpend` — the reserved ceiling, applied only when that exact backend version enforces one,
  and taken from the **grant**. A Stage that could set its own limit is a spender choosing its own
  limit.

`requiredCapabilities` stays inside the request rather than gaining a sibling field. Two places to
state one thing is two places for them to disagree.

The omission is enforced by more than the type. A request assembled from configuration, or written
in JavaScript, can carry those keys anyway — so the Runtime's values are applied **after** the
Stage's, and a test smuggles all three in to prove which wins.

### It delegates rather than reimplements

`StageAgentDispatcher` is a port in `stage-runner`, implemented in services by an adapter over
`AgentExecutionService`. That service already owns backend execution, reservation, `CostRecord`
attribution, the unauthorized-free divergence, unknown billing and settlement ordering. A second
implementation behind `runAgent` would give one billing boundary two answers, and the two would
diverge on the first fix applied to only one.

The grant is resolved through the same `dispatchSpendGrants(runId, operation)` provider a paid
Worker uses, never supplied by the Stage — a caller that names its own authorization can name one
that did not authorize it.

Billing-effect cardinality follows ADR-0046 exactly: one declared effect, one reservation, and a
result carrying several **independent** charges is refused with the charges recorded and the
reservation retained unresolved. `AgentResult.costs` is plural for good reason — one execution may
incur several model, provider or tool charges — and `free`/`voided` observations are not charges.

### Single-shot, and a pause is an outcome

There is no resume operation and no session input in V1.

A paused backend session spans attempts, and a reservation outliving the attempt that created it is
a lifecycle state ADR-0044 does not have. Inventing one before a caller needs it would be inventing
a state to hold a case nobody has.

A pause is therefore an explicit `StageAgentOutcome` arm — `paused_unsupported`, carrying the
explanation and the result — rather than a nullable `session` on a result whose `ok` a Stage would
otherwise read as completion. The discriminated union is what stops that reading; a caller must
narrow before it can claim anything happened.

**A pause is not evidence of no charge.** Whatever was billed before it is recorded and settled, or
retained as unresolved where the backend said nothing.

### Unresolved billing survives the adapter

`AgentExecutionService` computes `billingUnconfirmed` from the durable records, and its own
documentation says a caller **must not** silently retry when it is true. The first version of the
adapter returned only `outcome.result`, and `runAgent` discriminated on `result.session` alone — so
an execution whose reservation was still `billing_unknown` and non-retryable arrived at the Stage
as `completed`. The adapter erased the lifecycle fact the service exists to publish.

`StageAgentDispatchResult` carries it, and `StageAgentOutcome` gains a `billing_unresolved` arm.
A Stage is not asked to re-derive it from `AgentResult.costs`: settlement belongs to the services
layer, and whether the reservation resolved is a fact about the reservation rather than about the
provider's report.

**Unresolved billing is checked before the pause, and carries the pause with it.** Where both are
true, one outcome retains both facts — `billing_unresolved` with `paused: true`. Separate arms
would let a caller reading for one miss the other, and unresolved billing is the fact that governs
what may be done next.

### Silence is answered once, in the shared boundary

A dispatch that comes back reporting nothing has not said it cost nothing — it has said nothing.
`SpendService.settle` treated an empty observation array as evidence of no charge and appended
`reservation.released`, restoring authorization on the strength of a provider that was silent.

The same question already had a different answer one method away. `StageRunner`'s Worker path
guarded before calling `settle` and refused non-retryably; the agent path reached the same `settle`
and released. That is precisely the divergence this ADR's own port exists to prevent, and it had
already happened.

**The rule now lives in `settle`**, so every caller gets it rather than whichever caller thought of
it — the agent path, the Worker path, and `SynthesisGateway`, which reaches the same call. An empty
observation array retains the reservation as `billing_unknown` with a stated reason; observations
that are only `free`/`voided` still release, because those are a provider stating nothing is owed.

The Worker path keeps its own earlier guard, message and non-retryable classification. It answers
the same fact sooner and more specifically, which is not a competing answer.

`AgentExecutionResult.billingUnconfirmed` now also reads the reservation's state. Derived from
records alone it answered correctly when a record existed and could not answer at all when none
did — which is exactly the silent case.

### A ceiling never travels from the caller

`maxSpend` is stripped from the caller's request **unconditionally** and re-added only where the
Runtime has a reserved ceiling and the backend declares it enforces one. The override previously
lived only in the enforcing branch, so the other passed the caller's object through untouched: a
Stage-authored ceiling reached a provider that no grant authorized, while `prepareDispatch`
recorded `ceilingEnforced: false` and the trace therefore said no ceiling was applied.

Omitting the key from `StageOwnedAgentRequest` does not close this on its own, for the reason that
type's own documentation gives — a request assembled from configuration, or written in JavaScript,
carries it regardless.

### Cancellation

The attempt's `AbortSignal` is passed to the backend, and the Runtime invokes
`StageAgentDispatcher.cancel(executionId)` — which reaches `AgentBackend.cancel` — for backends
that cannot observe it. Until now `cancel` had no caller anywhere, because nothing dispatched a
backend at all.

**Cancelling never releases the reservation.** A cancelled request may already have been billed,
and treating cancellation as proof of no charge is the assumption §19.3 exists to prevent.

## Consequences

- `AgentExecutionService` remains the standalone surface for callers outside a Stage, and stops
  being the _only_ path. Both go through one implementation.
- A composition without a backend refuses `runAgent` rather than doing nothing, and a composition
  _with_ one dispatches only when a Stage asks. Both halves are asserted through the composed
  stack.
- ADR-0046's cardinality and free/voided rules are applied to the agent path, so the two paid
  dispatch paths cannot drift.
- A Stage needing a resumable session has no supported path. That is the honest state: the
  alternative was a lifecycle invented for no caller, or a Stage owning attempt-spanning state the
  Runtime owns everywhere else.

## Alternatives considered

- **Dispatch because a backend is configured.** Rejected by the owner and correctly: it makes a
  capability declaration into an instruction, and an adopter who wires a backend to satisfy a
  capability check would find it executing.
- **A composition-root accessor instead of a `StageContext` member.** Rejected: the caller would
  then supply attempt identity, which is exactly what the Runtime owns. Attribution assembled by
  the caller is #107's defect class.
- **Resumption via `AgentExecutionService` only (option 3).** Rejected by the owner: it makes
  resumable Stages bypass the composed attempt and attribution boundary — the supported path
  becomes the unattributed one.
- **A paused-reservation lifecycle now (option 2).** Rejected as premature. A later ADR may add it
  when a caller requires it.
- **Accept a full `AgentRequest` and strip the Runtime fields.** Rejected: a type that accepts a
  field and ignores it teaches the opposite of what it enforces. Omitting them says which fields
  are not the Stage's, and the runtime ordering makes it true for callers the type cannot reach.
