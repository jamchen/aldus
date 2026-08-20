# ADR-0039: Delivery is a third fact, and paidness comes from charge evidence

- Status: Accepted
- Date: 2026-08-20
- Relates to: §13.2 Authorization, §15 TTS ledger, §19.3 Cost, §20 Production trace, ADR-0030, ADR-0038
- Issue: #136, ruling on #133

## Context

ADR-0038 gave a take two facts: what was **requested**, and what **produced** the bytes. The ruling
models three, and the third is not a refinement of the second:

> The third distinction matters because a replay adapter can deliver audio originally produced by a
> hosted provider; the replay adapter is not the audio producer.

A replay adapter's produced facts are honestly the original provider's — the bytes really were made
that way. Its _delivery_ is a local file read that called nobody and cost nothing. A two-fact model
must pick one truth to record, and either choice makes a class of question unanswerable.

Separately, the ruling asked for an audit that turned up the same defect a third time:

> Authorization means spending was permitted, not that spending occurred.

```ts
export function isPaid(take: TakeRecord): boolean {
  return take.authorization !== undefined || take.costRecordId !== undefined;
}
```

The adopter's seven takes were authorized by an approved synthesis gate and rendered locally for
nothing. `isPaid` called all seven paid. Same shape as `parameters.provider` and
`text.finalProviderText`: a value asserting something stronger than what was established, invisible
because every record is well-formed.

A fourth thing turned up while wiring it. `SynthesisOutcome.charged` — documented as _"what it
cost, where the adapter knows before a cost record exists"_ — was never read. The composed stack's
own fake adapter has been reporting a per-request amount since it was written, and the gateway
dropped it. Charge evidence was being volunteered and discarded, which is part of why paidness was
being inferred from the authorization instead.

## Decision

### Delivery is recorded, and the gateway names the adapter

`TakeRecord.delivery` carries `adapterId`, an open-string `mechanism`, `incurredCharge`, and
provenance (`sourceTakeId`, `sourceArtifactId`).

**`adapterId` comes from the gateway, never from the outcome.** The gateway holds the true value
already, and a component that can state its own identity can state a false one — the same rule as
`authorizationId` on a cost record (#107) and every runtime-supplied field on a `WorkerRequest`
(ADR-0035).

`mechanism` is an open string. The ruling names synthesis, replay and import; §15.1 independently
names human-recorded replacement as a repair. A closed set defined by Core would have been wrong on
arrival, and §4.2 forbids it regardless.

### Paidness is three-valued and derived from charge evidence

`takePaidness` returns `paid`, `free`, or `unknown`. Charge evidence is a cost record, an
unauthorized charge, or the adapter saying it was charged. An authorization is never evidence.

**`unknown` is not `free`.** Absence of a cost record does not establish that nothing was charged —
the record may not be written yet. `free` requires someone to have said so. `isPaid` is retained,
narrowed to `paid` only, and documents that callers deciding anything that costs money if wrong
should branch on the three-valued function instead.

### Paid divergence is refused; free divergence is recorded

> If a paid synthesis execution differs from its authorized text or parameters, it must be rejected
> before the provider call or require a newly authorized plan. A free local preview or replay may
> diverge under an explicit substitution/replay policy.

This corrects ADR-0038, which said divergence is never refused. That was too broad: right for the
adopter's tag stripping, which is free and local, and wrong for a paid call. The distinction is
paidness.

**"Before the provider call" is only reachable through a declaration**, and this is the substantive
design point. A divergence is visible after the call, when a paid provider has already been billed;
a refusal there is a post-mortem. So `SynthesisAdapter.capabilities()` may declare `maySubstitute`,
and an adapter that declares it is refused **before being called** when the segment is expected to
be paid. A free render by the same adapter is untouched.

An adapter that does **not** declare and then diverges on a paid call is caught after the fact, and
the take is recorded through the existing unauthorized-charge path. Refusing to record would only
make the charge invisible, and §20 requires the trace to answer "what it cost". What the record must
not do is claim the approval covered it — which is exactly what `unauthorizedCharge` already means.

## Consequences

- Two layers of defence with different strengths, and the difference is stated rather than blurred:
  a declaring adapter is stopped before spending, a silent one is caught after. Neither is complete
  alone and the second is not a substitute for the first.
- `charged` is finally consumed, as a boolean. The amount is deliberately not copied onto the take —
  the existing `costRecordId` docstring gives the reason, and duplicating it would create a second
  number to keep reconciled with the one budgets are computed from.
- Legacy records decode as `unknown` on every new axis. Never as agreement, never as free.
- Two mutants survived the first pass and both were real test gaps: a refusal that ignored paidness
  (which would have broken the adopter's own legitimate case) and an `adapterId` sourced from the
  adapter's own report. Both are now covered by tests written because the mutation survived, not
  because the case was foreseen.

## Alternatives considered

- **Fold delivery into produced facts.** Rejected — this is the replay case, and it is the reason
  the ruling separates them.
- **A closed `mechanism` enumeration.** Rejected: §15.1 already names a fourth mechanism the
  ruling's three do not cover, and §4.2 forbids Core naming an adopter's vocabulary.
- **Make `isPaid` a two-valued function over `paid` and everything else.** Rejected as the defect
  restated. Collapsing `unknown` into `free` is how seven authorized local renders came to be
  counted as paid in the first place, and collapsing it into `paid` would over-report every take
  whose cost record has not yet landed.
- **Refuse to record a paid divergence at all.** Rejected: the money is already gone, and a charge
  that appears nowhere is a larger harm than an ugly record (the reasoning `recordUnauthorizedCharge`
  was built on).
