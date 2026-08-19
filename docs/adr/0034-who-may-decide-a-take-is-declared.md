# ADR-0034: Who may decide a take is declared, not assumed

- Status: Accepted
- Date: 2026-08-19
- Relates to: §12 Gate levels, §13.3 Performance approval, §15 Takes, ADR-0030

## Context

§13.3, verbatim:

> Automated checks MAY filter and prioritize candidates, but final performance approval remains
> human-owned **until a scoped evaluator is demonstrably reliable**.

The conditional is the operative part, and #100 dropped it. Takes had no actor check at all — an
agent could accept one and the record read like a human's — so the fix refused any actor whose
kind was not `human`. That closed a real hole: for an adopter reviewing per segment, accepting a
take _is_ the human-ear judgement, and the gate binding those takes was protecting a value an
agent was free to determine.

But it enforced the clause as an absolute. There was no way to state that an evaluator had been
demonstrated, so the "until" became unreachable — not merely unmet, but unsatisfiable by anyone.

Gates already had the right shape one package over. `GateDefinition.permittedActorKinds` defaults
to human-only for a `human_oracle` gate and is overridable where an adopter declares it, with
§13.3 cited in the refusal. The same contract clause was configurable in the gate engine and
absolute in the ledger, and nothing recorded why they differed — because nothing had decided they
should.

The case that surfaced it is a production one, not a thought experiment: an adopter runs a show
that publishes fully automatically today, with no person auditioning the audio. Refusing to record
its take decisions does not make that show supervised. It makes the ledger unable to describe what
happened, which is the failure ADR-0030 is about — a runtime that holds a fact and cannot say it.

## Decision

**`TtsLedger` accepts `permittedDecisionActorKinds`, defaulting to `["human"]`.** A take decision
is refused unless the deciding actor's kind is in that list.

**The default is human-only, and opting out must be an act.** The failure modes are asymmetric: a
supervised show that accidentally permits agents loses its human-ear guarantee _silently_ and
finds out when something ships wrong, while an automated show that accidentally forbids them fails
_loudly_ on its first take. Defaults belong on the side whose mistakes announce themselves.

**An empty list is refused at construction.** It is not a strict policy but a workflow that stalls
at its first acceptance with no way out — the same refusal `validateGateDefinition` already makes
for a gate nobody can decide.

## Consequences

- An adopter with a supervised show now _declares_ human-only rather than relying on it, which is
  strictly better than the state before #100 and no weaker than the state after it.
- A take decided by an agent records `{ kind: "agent", … }` truthfully, and the permission appears
  in configuration rather than as an absence. This is what makes #64's typed `decidedBy` worth
  having: where an agent may decide, the kind is the whole content of the field.
- Aldus takes no view on whether any given evaluator is reliable. §13.3 says "demonstrably", and
  the demonstration is the adopter's to make and to stand behind — Core's job is to make the
  claim expressible and recorded, not to assess it.
- The two enforcement points now agree in shape. If they diverge again it will be visible, because
  a reader comparing them finds the same structure rather than two different answers to one clause.

## Alternatives considered

- **Keep the absolute refusal.** Rejected: it makes a contract-sanctioned state unreachable, and
  the clause's "until" is not decoration. An adopter's only recourse was to stop recording
  decisions at all, which loses the evidence rather than enforcing the rule.
- **Default to permissive, refuse only where declared.** Rejected on the asymmetry above. It also
  reverses the burden the contract sets: §13.3 makes human ownership the resting state and
  automation the thing that must be established.
- **Per-take rather than per-ledger.** Rejected as premature. A ledger is constructed per adopter
  composition and a show's supervision model is a property of the show, not of individual takes.
  If a workflow ever needs both within one ledger, the narrower option is additive from here.
- **Reuse `GateDefinition.permittedActorKinds` by requiring a gate.** Rejected: it would force an
  adopter to invent a gate to express a property of their pipeline, which is the same conflation
  ADR-0028 refused for ordering.
