# ADR-0040: A stage declares what it owes the registry, resolved before it runs

- Status: Accepted
- Date: 2026-08-20
- Relates to: §6.3 Attempts, §8.1 Artifacts, §11 Stages, §20 Production trace, ADR-0036
- Issue: #138

## Context

`StageDefinition` declared an input schema, an output schema, required capabilities, idempotency
and quality claims — and **nothing about which artifacts the stage owes the registry.**
`context.registerOutput` was purely imperative, `StageAttempt.outputArtifacts` began empty and
accumulated whatever the stage happened to register, and nothing compared the result to anything,
because there was nothing to compare it to.

So a stage that should have registered a rendered video and registered none settled `succeeded`
with `outputRefs: []`, a record indistinguishable from a stage that correctly produced no
artifacts. §11's _"produce declared outputs or a structured failure"_ was honoured for the return
value only: `outputSchema` covers what a stage returns, and the artifacts — the part §8.1 exists
for — were outside the clause in practice.

Found by checking Aldus for a tolerance the first adopter had just found in their own renderer.
Their `render.video` stage reported _succeeded, 4 artifacts recorded_ while a 34 MB video went
unregistered on every render: the declared filename and the renderer's hardcoded one differed, and
their registration loop treated an absent file as a render mode that legitimately produced fewer
outputs. **A typo and a skipped output were the same observation.** No digest, no lineage, invisible
to cleanup planning.

The failure mode is asymmetric, which is why it ran for months rather than being caught on the
first render. A missing artifact fails **open** — absence looks like a legitimate empty set, so
nobody investigates. A stage claiming an artifact it did not produce would fail closed and be fixed
the same day.

## Decision

**Every stage declares its artifact obligation. The declaration is required, resolved before
execution from validated inputs only, persisted on the attempt, and checked before the attempt
settles as succeeded.**

### The declaration is required, and "none" is written down

`StageDefinition.artifacts` is not optional. A stage that registers nothing declares
`{ produces: "none" }` explicitly.

**Absence must not mean "no artifacts."** An optional field left off by an author who forgot is
indistinguishable from one left off by an author who meant it, and the whole defect is that absence
was unreadable. Making the field required converts every existing stage into a decision someone had
to make, once, at a compiler error — which is the only moment the question is cheap.

### The obligation is resolved before execution, from the invocation, never from the result

The resolver receives the **validated input**, the **recorded configuration**, and the **declared
input artifacts**. It receives nothing else.

Specifically it does not receive the stage's return value or the artifacts the stage registered.
That is the load-bearing constraint: an obligation derived from what a stage produced is satisfied
by definition, and _the defect would define away its own postcondition_. A stage that registered
nothing would be found to have owed nothing.

It also has no filesystem or I/O access. If a render mode cannot be derived from validated input,
configuration or declared input artifacts, **that mode is a hidden input and must be made explicit
first.** Giving the resolver I/O would let a stage's obligation depend on state nothing recorded,
which is ADR-0036's defect — a key computed over something that does not describe the work — in a
new place.

### The resolved contract carries cardinality, and is persisted

An obligation is `{ kind, minCount, maxCount? }`. Kinds stay adopter-defined opaque strings (§4.2):
Aldus can check that _something claiming a kind_ was registered, never that `"video"` is a video.

The resolved list is written to `StageAttempt.expectedArtifacts`. §20 asks what the runner expected
**at that time** — and a resolver is a function whose answer can change with a later edit, so a
trace that stored only the outcome could not distinguish "the stage failed to produce it" from "the
rule changed afterwards".

### The check runs before settling succeeded, and only then

Before an attempt from a `completed` or `evaluated` outcome settles `succeeded`, registered
artifacts are compared with the resolved contract. Three ways to fail, all structured and
**non-retryable** — each is a defect in the stage or its declaration, and retrying runs it again
with the same result while spending whatever the stage spends:

- a required kind registered fewer than `minCount` times;
- a kind registered more than `maxCount` times;
- a kind registered that the contract does not declare at all.

The third matters as much as the first. An undeclared registration is a stage doing something its
declaration does not describe, and letting it through would make the declaration advisory.

**Cancelled, failed and waiting-for-gate attempts are not checked.** A stage that failed halfway
owes nothing; requiring a complete artifact set from an incomplete attempt would convert every
ordinary failure into two. Artifacts already registered are preserved in all cases, including when
the contract check itself fails — they are evidence of how far the stage got, and deleting them
would destroy the diagnosis the failure exists to enable.

## Consequences

- `SCHEMA_VERSION` 1.7 → 1.8. `expectedArtifacts` is an added optional field on `StageAttempt`, so
  MINOR (ADR-0003). Attempts recorded before this carry no expectation, which reads correctly as
  _nothing recorded what was expected_ rather than as _nothing was expected_.
- `StageDefinition.artifacts` being required is a **compile-time breaking change** for anyone with
  a stage definition. Deliberate, and cheap at exactly one moment. `0.2.0` has not been promoted to
  `latest`, so the population affected is one adopter who is in the loop on this issue.
- A stage can now fail for a reason that is not its own execution failing. The error names the
  contract and the counts, because "the stage failed" without the comparison is the unreadable
  record this ADR exists to remove.
- Conditional obligations are expressible, which is what makes the declaration honest for the
  adopter whose render modes produce different sets. A declaration that could not express them
  would be either wrong or ignored — and an ignored declaration is worse than none, because it
  reads as a check.

## Alternatives considered

- **`expectedArtifactKinds?: string[]`.** Rejected in the ruling and rightly. Optional reintroduces
  the unreadable absence; a flat kind list cannot express cardinality or conditionality; and the
  stages with modes are exactly the ones the field exists for, so a mechanism that cannot reach
  them is ADR-0036's failure repeated.
- **Warn rather than fail.** Rejected. The consequence lands later and elsewhere — an artifact with
  no digest and no lineage cannot be verified, cleaned up on policy, or traced to what made it —
  and a warning is read by whoever is already looking, which is nobody. That is the same reasoning
  that refused a missing effect-key derivation in ADR-0036.
- **Let the resolver see the registered artifacts, to handle "produced whatever it produced".**
  Rejected as the defect wearing the fix's clothes. A stage whose obligation is whatever it did has
  no obligation.
