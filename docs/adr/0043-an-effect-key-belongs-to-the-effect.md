# ADR-0043: An effect key belongs to the effect, not to the attempt containing it

- Status: Accepted
- Date: 2026-08-20
- Relates to: §11 Stages, §19.1 Idempotency, §20 Production trace, ADR-0033, ADR-0035, ADR-0036
- Issues: #148, #149

## Context

ADR-0036 separated the invocation fingerprint from the external-effect key and refused an idempotent
external effect that supplied no derivation. It left two things wrong, and an adopter found the
first by reading a declaration against its own definition.

### The refusal only bit the honest

`idempotent_external_effect` without `effectKey` was refused at registration. `idempotent` —
_"re-running touches nothing outside the workspace"_ — was refused by nothing.

`EffectKeyContext` carried content identity through one channel, `inputArtifacts`, and ADR-0033
ruled out every substitute by measurement. So a stage with no declared input artifacts could not
derive a content-based key **at all**, and there is a real class that cannot have them: a stage
whose subject is _what the Run produced_. Nobody can enumerate those before the Run produces them.

The adopter's archive stage shipped declaring `idempotent` while uploading to a cloud drive. Their
account of how is the part worth keeping:

> Nobody chose that; the comment beside it argued only about the invocation key's precision and
> never re-read what the arm asserts.

An author who declared the true thing met a requirement they could not satisfy. One who declared the
convenient thing met nothing.

### The key was the wrong shape, and the fallback was forbidden

Following that into the runner found two defects:

```ts
// The effect key where the stage declared one, the fingerprint otherwise.
idempotencyKey: effectKey ?? invocationKey,
```

The comment cited ADR-0036 while doing what ADR-0036 forbids in as many words. And `effectKey` and
`invocationKey` were computed once per attempt, so **every Worker invocation in an attempt received
the same value**.

Both matter more together than apart. For a stage with an empty input schema and no declared
artifacts — five of the adopter's six — the invocation key is a **constant**, verified: their
`configurationHash` was `sha256("{}")`, their `inputHashes` empty, their key identical across every
episode and every run of that stage version. A platform deduplicating on it would treat every
episode's first request as a repeat of the first episode's, forever.

### The candidate that was refused, and why recording it matters

The obvious repair — widen `EffectKeyContext` with Run-scoped artifact digests — was proposed here
and refused by the adopter:

> For a **batch** stage the set-digest **is** an enclosure. Add one unrelated artifact to the Run
> and the key moves while every object being archived is byte-identical.

That is ADR-0033's failure, not a variation on it. It would have produced a key that is _derivable
and wrong_, satisfying the check while moving for reasons unrelated to what was sent — worse than
the honest refusal it replaced.

The real mismatch is cardinality: one attempt, N independently deduplicated effects. No amount of
material in a per-attempt context fixes a value of the wrong shape.

## Decision

**An effect key belongs to the independently deduplicated effect, not automatically to the Stage
attempt containing it.** Stage-level retry safety and per-effect identity are represented
separately.

### Stage declaration, renamed for what it claims

`StageIdempotency` becomes `StageRetrySafety`, and the field `idempotency` becomes `retrySafety`.
`idempotent` reads as a property of the computation and was taken as one; the arms make claims about
the world.

| arm                                                               | meaning                                                      |
| ----------------------------------------------------------------- | ------------------------------------------------------------ |
| `no_external_effects`                                             | re-running touches nothing outside the workspace             |
| `deduplicated_external_effects` + `keyScope: "stage"`             | exactly one such effect, keyed at the stage                  |
| `deduplicated_external_effects` + `keyScope: "worker_invocation"` | every effect crosses the Worker seam and carries its own key |
| `not_idempotent`                                                  | re-running duplicates an effect; never auto-retried          |

### Every Worker invocation declares its own effect

`StageWorkerRequest.effect` is required: `{ kind: "none" }` or `{ kind: "deduplicated",
idempotencyKey }`. `WorkerRequest.idempotencyKey` becomes **optional**, present only for the second.

**When no effect-specific key exists, the correct value is absent.** Not `invocationKey`, not
`runId`, not `attemptId`, not `configurationHash`, not an empty input-hash set. A field that is
sometimes a real key and sometimes a global constant, with no way for the receiving Worker to tell
which, is worse than no field: the author who checks whether it is populated gets `true` either way.

### Enforced before the Worker is reached

A refusal arriving after an external system has been written to is not a refusal. So: a pure stage
asking for a deduplicated effect is refused; an empty key is refused; a stage-scoped key is refused
the moment it would cover a second effect; and a request with no `effect` at all is refused with a
message naming what was omitted, rather than throwing a `TypeError` the runner reports as an
ordinary stage failure.

### No trust-only fourth arm

The adopter proposed one — "the adapter says this is safe" — and then argued it down themselves:

> I would rather have no fourth arm than a fourth arm that is read only by an audit nobody performs.

Their content-addressed objects, receipt short-circuit and update-free seam do make retries safe,
and `keyScope: "worker_invocation"` represents that: the content digest is the logical effect key,
the adapter enforces deduplication, the stage records why it is sound, and **the runner reads that
declaration at retry-decision time.** The runtime cannot prove a destination honours a key, just as
it cannot prove a stage has no hidden effects. What it enforces is that the claim is explicit,
correctly scoped, supplied at the seam where the effect happens, recorded, and read.

`retrySafety`, `effectKeyScope` and `retrySafetyReason` are therefore on the attempt, not filed for
an audit — the criterion the adopter sharpened into a checkable one.

### Hidden inputs stay visible

The context is **not** implicitly populated with every artifact the Run registered. A stage reading
files by path still has hidden inputs, and its invocation fingerprint identifies only its declared
work and must keep saying so. Content identity that matters for an external effect must reach the
derivation explicitly — through declared artifacts, or through the per-invocation effect key.

## Consequences

- Compile-time breaking, twice over: `retrySafety` replaces `idempotency`, and `effect` is required
  on every Worker request. Shipped together, and the compiler names every site.
- A stage that was silently mis-declared can no longer be. The adopter's archive stage has a
  correct arm available for the first time.
- Attempts recorded before this carry no `retrySafety`, which reads as _nothing recorded which arm_
  rather than as an arm.
- The old cache field `idempotencyKey` still parses and is still not migrated: it was measured as a
  constant, and carrying a wrong answer forward under a better name is what ADR-0036 existed to
  prevent.

## Alternatives considered

- **Run-scoped artifact digests in `EffectKeyContext`.** Refused above. Sound for a stage consuming
  declared artifacts; an enclosure digest for the batch class that motivated it.
- **Enforcing `idempotent`.** Impossible. The write is a socket the stage opened, and any
  enforcement would be a declaration about a declaration. Making the honest arm _satisfiable_ is the
  only lever.
- **Keeping the fallback for compatibility.** Rejected: the value it supplies is a constant for
  exactly the stages most likely to hand it onward, so compatibility here means preserving a defect
  whose failure mode is successful-looking silent data loss.
