# ADR-0035: A Worker performs an operation; the Stage owns everything else

- Status: Accepted
- Date: 2026-08-20
- Relates to: §3.2 Worker before Agent, §4.1 Core-owned interfaces, §11 Stages, §19.1 Reliability,
  §20 Production trace, ADR-0030

## Context

§4.1 assigns Core the "Agent Backend **and Worker** interfaces". Only the Agent half existed
(#111). §3.2 is design principle #2 — _"if a task can be made deterministic, repeatable, testable,
and inexpensive, it SHOULD be implemented as a Worker"_ — so the contract told adopters to prefer
the seam that was missing, while `AgentBackend` had an interface, a capability model, a check that
refuses before side effects, and a documented boundary.

§22 has no work package for it, §23 does not list it, and §5.1 neither includes nor excludes it.
Nothing deferred it; it was never picked up.

The first adopter reached the point where it decides their next month: nine vendored legacy tools
to convert, and §3.7's strangler pattern says wrap before rewriting. "Converted into Aldus's form"
had an obvious answer for their agent definitions and no answer at all for their deterministic
tools, because the form did not exist.

## Decision

**A Worker is an adopter- or provider-supplied implementation of a declared operation. A Stage
invokes Workers through a runtime-owned seam and keeps every other responsibility.**

The Stage continues to own, and a Worker never acquires:

- input and output validation;
- gates;
- retry policy;
- idempotency policy and keys;
- cost authorization;
- artifact registration and provenance;
- attempt lifecycle and durable state.

This is the load-bearing half of the decision. A Worker that grew any of these would become a
second workflow abstraction competing with Stage, and an adopter would have to learn which of two
models governs a given concern. Existing production scripts wrapped as coarse Workers called from
coarse Stages is the sanctioned starting point (§4.3), with decomposition later.

### Why there is no Worker-level `resume`

`AgentBackend` has `resume` because an agent session can be paused and continued. A Worker has no
equivalent, and **the reason is not that a Worker is cheap or safe to re-run.**

That distinction is worth stating because the tempting justification is wrong and would be load
bearing if written down. §3.2's examples include TTS API invocation and FFmpeg rendering: TTS can
be paid and nondeterministic, rendering is expensive, and an upload has an external effect that
happens once whatever the caller believes. A contract implying otherwise would license an adopter
to re-run a paid synthesis on the strength of the word "Worker".

Recovery belongs to the Stage's idempotency, artifact and ledger model, which already knows what
was produced, what was charged, and what key the effect was performed under. In the owner's words,
recorded verbatim because a paraphrase already went wrong once:

> Aldus must never infer that a Worker is automatically rerunnable merely because it is called a
> Worker.

The absence of `resume` therefore records that recovery is not the Worker's to offer, not that it
is unnecessary.

The concrete counter-example was in the first adopter's own artifact taxonomy while both of us
argued the opposite: their `tts/segment-wav` is classified `irreplaceable`, with the reason written
out — _"Paid, and the provider does not guarantee a seed reproduces the audio. These bytes are the
only copy."_ A TTS Worker is exactly a Worker that is neither cheap nor rerunnable. The error both
of us made was reading §3.2's _"deterministic, repeatable, testable, and inexpensive"_ as a
guarantee about things called Workers, when it is a heuristic for deciding what to **make** one.

### Cancellation flows through the signal

`StageContext.signal` is an `AbortSignal` and is propagated to the Worker. A separate cancellation
method is justified only where an adapter must cancel an external execution that cannot observe
the signal — a remote job with its own lifecycle — and is therefore optional and explicitly
narrow, not the primary mechanism.

### Versions are exact

A Worker declares `id` **and** `version`, and the registry resolves an exact pair. There is no
implicit latest-version selection, for the same reason `StageRegistry` resolves an exact stage
version: §20 requires a completed Run to stay explicable, and a Run that executed `v1` must remain
readable after `v2` is registered. Production trace records which id and version ran and which
capability declaration was checked.

### Capability checking fails closed

A stage declaring required capabilities with **no capability source wired, or no matching Worker
registered, is refused** — not permitted on the grounds that nothing objected. This is ADR-0030's
rule in the one place it is most expensive to get wrong: a capability check that passes because it
could not run is worse than absent, because a reader counts it as protection.

## Consequences

- Adopters get one seam rather than several private ones. §4.1 exists to prevent two adopters
  inventing incompatible contracts, and the first two were about to.
- A types-only export was considered and rejected by the owner: it makes a public API commitment
  while leaving every adopter to invent the wiring, which is the integration gap #27 already
  found once. The seam ships composed or not at all.
- A Worker cannot register an artifact with provenance it invented. It reaches artifact
  registration through the same recorder a stage uses, so `producerRunId` and `producerStageId`
  come from the attempt rather than from the Worker's claim about itself.
- Wrapping a legacy script as a coarse Worker is legitimate and expected to be temporary. Nothing
  in this decision rewards decomposition or penalises delay, because §3.7 makes wrapping the step
  that precedes rewriting rather than a compromise.

## Alternatives considered

- **Leave it to adopters.** Rejected by §4.1, and empirically: the first adopter said they would
  define a private one and would rather write against a stub than guess, precisely because a
  second adopter would define it differently.
- **Make Worker a kind of Stage.** Rejected: it collapses the distinction the contract draws, and
  a Stage carries durable attempt state that a checksum utility has no business owning.
- **Give Worker its own retry and idempotency.** Rejected as the specific failure this ADR exists
  to prevent — two models for one concern, and an adopter having to know which applies.
