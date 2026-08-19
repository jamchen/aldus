# ADR-0036: An invocation fingerprint and an external-effect key are different contracts

- Status: Accepted
- Date: 2026-08-20
- Relates to: §11 Stages, §15.1 Retry, §19.1 Idempotency, §20 Production trace, ADR-0033, ADR-0035

## Context

`StageAttempt.idempotencyKey` carried one value serving two purposes, and did neither correctly.

The default derivation was `digestJson({ stageId, stageVersion, input, configuration })`. Measured,
for a stage whose `inputSchema` is `z.object({}).strict()` with no configuration — which is the
**correct** design for a stage resolving its inputs from the Run rather than restating them:

```
first:     3af352cf9e8cf9114d4c0dbf5ea85a3fdde80bce98e0dd91e01a62acb86569c5
second:    3af352cf9e8cf9114d4c0dbf5ea85a3fdde80bce98e0dd91e01a62acb86569c5
identical: true
```

Two Runs, two workspaces, two episodes, one key. The first adopter has three such stages, so three
global constants. Nothing consumed the value, which is why no amount of running the system
surfaced it — it was found by reading the derivation.

Two narrower fixes were proposed and both rejected, which is what makes the decision worth
recording rather than the defect.

**`inputHashes` in the default** fixes it only for adopters who already declare input artifacts. A
stage that reads by convention declares none, and those were exactly the affected stages.

**`episodeId` in the default** removes the cross-episode collision and leaves the worse one: two
Runs over one episode with changed content still agree, so an external system deduplicates and the
new work is never performed. A cross-episode collision publishes the wrong thing loudly; this
publishes nothing and reports success. And the adopter's sharper objection:

> Adding `episodeId` and stopping makes the default _look_ subject-aware, which is worse than the
> constant: a constant is obviously wrong on inspection, and `stageId + episodeId` reads like it
> identifies the work.

That is #98's rule applied to a derived value rather than a message. A key whose apparent strength
exceeds its actual strength is more dangerous than one visibly useless, because the first consumer
trusts it.

## Decision

**A Stage invocation fingerprint and an external-effect idempotency key are different contracts and
are represented separately.**

### The invocation key is runtime-derived

`invocationKey` identifies the Stage's **declared work**, for production trace and retry
correlation. Its default material is:

- `episodeId`;
- stage id and version;
- the validated input;
- the recorded configuration;
- the sorted identities and SHA-256 digests of declared input artifacts.

**`runId` is deliberately absent.** Two Runs performing the same declared work produce the same
fingerprint, which is what makes it a fingerprint. Including `runId` would reintroduce ADR-0033's
defect one layer up: a reassembled identity producing a fresh key and re-performing settled work.

**It identifies only what Aldus can see.** A Stage that reads additional files by path or
convention without declaring them as input artifacts has content the invocation key does not
cover. This is stated in the field's own documentation rather than left to be discovered, because
the limitation is invisible from the value.

### The effect key is declared, never derived by fallback

**A key used by an external system to deduplicate a side effect never falls back to the invocation
key.** External effects are declared structurally, and the declaration distinguishes three states
that were previously two:

- **no external effect** — the ordinary case, and the invocation key is all there is;
- **an idempotent external effect** — requires an explicit effect-key derivation;
- **a non-idempotent external effect** — requires a reason, and is never auto-retried (§15.1).

**A Stage declaring an idempotent external effect without an effect-key derivation is refused
before execution.** A configuration error, not a warning — the same register as
`validateGateDefinition` refusing an undecidable gate, or ADR-0034 refusing an empty
`permittedDecisionActorKinds`.

The derivation receives a context, not a bare input. The previous `(input: unknown) => string` hook
could not reach the affected class at all: an adopter whose input is `{}` could not write a key
function that distinguished anything, however willing. A mechanism provided for overriding key
derivation that cannot reach the stages most needing it is not an escape hatch for them.

For content-bearing external effects the key must ultimately depend on **effect identity and
content digests**, following ADR-0033. `runId`, attempt id, path and bundle identity are not
substitutes for content identity — ADR-0033 established that by measurement when a reassembled
bundle re-published everything.

### Hidden inputs

A Stage may read content by filesystem convention for local, read-only processing. If that content
influences an **external effect**, it must first be represented by declared input artifacts or by
another explicit digest-bearing contract. Otherwise the effect key is computed over something that
does not describe what was sent.

## Consequences

- The three states are distinguishable where previously two words carried three meanings. The
  first adopter reported nine of thirteen stages declaring `not_idempotent`, several because the
  _output_ is not reproducible rather than because re-running has an external effect — different
  facts wearing one word, and §15.1's retry refusal is right for the second and merely
  conservative for the first.
- A stage that writes externally can no longer be written wrong by an author who is right about
  the semantics. The adopter's case for this is the strongest one available: they nearly wrote
  `archive.drive` — content-addressed, digest-verified, genuinely safe to repeat — and would have
  declared it `idempotent` correctly, received a constant key, and had no reason to look. _"The
  only thing standing between me and that mistake is having had this conversation, which is not a
  mechanism."_
- Existing `0.1.0` attempt records stay readable. The unsafe semantic meaning is not preserved:
  newly derived keys deliberately differ from old ones, because equality with a wrong answer is
  not a compatibility property worth having.
- Nothing consumed the key and no adopter has released through it, so this correction lands before
  the first consumer exists. That window is why it is being made now rather than scheduled.

## Alternatives considered

- **`episodeId` in the default, as the resolution.** Rejected above: it buys the appearance of
  correctness, which is worse than the constant it replaces.
- **One key with better material.** Rejected as the root error. The two uses have different
  requirements — a fingerprint should be stable across Runs doing identical work, an effect key
  must change when the content changes — and no single derivation satisfies both. Conflating them
  is what produced a value that was wrong for both.
- **Warn rather than refuse on a missing effect key.** Rejected: the failure is silent and the
  consumer is external. A warning is read by whoever is already looking, which is nobody, and the
  first consumer inherits the default anyway.
