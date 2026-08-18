# ADR-0028: A workflow graph declares stage ordering, separately from gating

- Status: Accepted
- Date: 2026-08-18
- Closes: issue #55
- Relates to: §11 Workflow and stage contracts, §24 V1 definition of done, ADR-0015, ADR-0021,
  ADR-0024, ADR-0026

## Context

`WorkflowStageNode` carried `stageId` and `requiredGates`. It could say which gates gate a stage
and nothing at all about what must happen before it.

The first adopter integration hit the consequence, with a production incident behind it: one stage
renders a video and regenerates its caption file, and a later stage retimes that file's alignment.
Run in the wrong order the retime's work is silently overwritten — no error, no failed stage, just
a wrong artifact that looks right. That had already happened once in their source pipeline. With
the graph unable to express it, `status` would offer the retime first and `aldus run` would perform
it.

They worked around it with their own precondition table, checked inside each stage. It works, and
it is precisely the shape of workaround ADR-0015 names as the test for what belongs here:

> If using it correctly requires an adopter to re-derive a sequence Aldus already knows, the wiring
> belongs here.

`decideActions` had every fact it needed — which stages have succeeded, which are in flight — and
could not use them, because nothing told it the order. Two adopters would write two subtly
different tables and get "what is safe to run next" wrong in two different ways. That is the class
of error this runtime exists to prevent, and §24 makes answering that question its job.

Their framing is the sharpest statement of the gap:

> _"Which stages are done"_ and _"which stages may run yet"_ are different questions, and only the
> first has an answer today.

## Decision

### 1. Ordering is a separate field, and is not a gate

`WorkflowStageNode.after?: readonly string[]` names stages that must have **succeeded** before this
one may run. `requiredGates` and `after` are orthogonal: a stage may declare either, both, or
neither, and each produces its own block reason.

Encoding ordering as a gate was rejected outright. There is no human decision between rendering and
retiming, so a gate there would put a pointless approval in front of an operator — and, worse, make
the gate mechanism's own meaning untrue. §13 gates exist because a human decided something; a gate
that exists to sequence two automated steps teaches everyone reading the workflow that a gate does
not mean what §13 says it means.

The adopter asked for this constraint explicitly, and it is the right one.

### 2. `runStage` refuses on an unmet predecessor, unconditionally

ADR-0024 requires that `status` and `runStage` never disagree, so an ordering block enforces just
as a declared gate block does.

**This does not reintroduce ADR-0024's deadlock, and the difference is worth stating precisely**,
because the two rules otherwise look contradictory — one refuses on a declared constraint, the
other deliberately does not refuse on an undeclared one.

ADR-0024's deadlock came from refusing on something the runtime had **guessed**. Every gate is
unsatisfied when a Run starts, so treating the conservative undeclared-gate fallback as enforcement
would have refused every stage in a workflow that declared nothing — and the subjects those gates
bind are produced by the very stages being refused. No sequence of operator actions clears it.

An unmet predecessor differs on both counts:

- it is **declared**, never inferred, so refusing is never the runtime overreaching;
- it **clears by running the predecessor**, which is always possible, because a graph with no
  runnable entry point is a cycle and is refused when the graph is resolved (decision 4).

There is no configuration in which every stage is refused with nothing an operator can do. That is
the property that makes enforcement safe here, and its absence is what made it unsafe there.

`force` does not bypass an edge. `force` exists to take over a stage a crashed runner claimed
(ADR-0008); overriding a declared data dependency is a different act, and one nothing in §11
permits.

### 3. Ordering is reported before gating

When a stage is held by both, the ordering blocker is the one reported. Running the predecessor is
the step that makes progress — and the gate may not even be decidable yet, because the subjects it
binds are produced by the predecessor. Naming the gate first would send an operator to approve
something they have no evidence for.

The judgement lives in the policy, beside the gate judgement, for the reason ADR-0024 gives:
computing blocked-ness a second way at a call site is exactly how `status` and `run` came to
disagree in the first place.

### 4. An unsatisfiable graph is refused where it is resolved

`AldusContext` validates the graph on construction and throws, naming what is wrong:

- a **cycle**, reported as the stages that form it — `"a" -> "b" -> "a"` is actionable, "your graph
  has a cycle" is not;
- an **edge to a stage the graph does not contain**, which could never succeed;
- a **stage declared to follow itself**;
- a **stage listed twice**, because resolving to the first would silently ignore the second and
  which was meant is not guessable.

Checked in `@aldus-runtime/services` rather than in the CLI's config validation, so every consumer
benefits and not only the binary. ADR-0015 puts policy on Aldus's side of an injection point, and a
graph arrives through one.

### 5. Terminal stages are derivable, so goals get a real default

A terminal is a stage no other stage lists in its `after`. `goalStages` now defaults to the graph's
terminals when it declares edges, and to every stage it names when it does not.

This removes the caveat ADR-0026 had to record. That default — every named stage — is the naive
reading of "finished" the adopter had already shown does not describe either of their workflows,
and it left an adopter who declared no goals with a Run that could never complete. It survives only
as the fallback for an edge-free graph, where every stage is trivially terminal and the narrower
answer would be the same list dressed up as a deduction.

A Run's own `goalStages` still wins. The default is a convenience; the declaration is the rule.

## Consequences

- An adopter can express a data dependency without inventing a gate, and the runtime enforces it
  rather than trusting each stage to check its own preconditions.
- The failure this prevents is the silent kind. A stage running early does not error — it produces
  a plausible artifact from stale inputs, which is the hardest class of defect to notice and the
  most expensive to discover downstream.
- **Purely additive.** `after` is optional, absent means no constraint, and a graph with no edges
  behaves exactly as it did before — pinned by tests, because every `0.1.0` graph is edge-free.
- The `goalStages` default changes **only** for a graph that declares edges, where it narrows from
  every stage to the terminals. A Run that declared its own goals is unaffected, and an edge-free
  graph keeps the old default. An adopter adding edges to an existing graph should expect
  completion to become reachable where it previously was not, which is the intended direction.
- Absence and `[]` mean the same thing for `after`, unlike `requiredGates`, where the distinction
  is load-bearing. An edge only ever _adds_ a precondition, so a missing declaration cannot
  silently unblock work the way a missing gate declaration could — there is nothing for a
  conservative reading to protect.
- Validation on construction means a malformed graph fails at startup rather than when a Run
  wedges. That is a new way for an adopter's configuration to be rejected, and the intended cost.

## Alternatives considered

- **Express ordering with gates.** Rejected: it forces a pointless approval into an automated
  sequence and corrupts what a gate means. The adopter named this as the thing not to do, and they
  were right.
- **Infer ordering from declared input and output artifact kinds.** Rejected as too clever. It
  would work until two stages produced the same kind, and the failure would be a silently wrong
  order — exactly what this ADR exists to prevent, arrived at by a cleverer route.
- **A single `dependsOn` covering both gates and stages.** Rejected: it makes "is this an
  authorization or a data dependency?" unanswerable from the declaration, and the two have
  different block reasons, different operator actions, and different enforcement rules.
- **Validate the graph only in the CLI's config loader.** Rejected: an adopter embedding the
  services directly would get no check at all, and ADR-0015 puts this kind of policy on Aldus's
  side of the boundary.
- **Execute the graph automatically once ordering is known.** Out of scope, and against §5.1's
  Interactive Editorial Profile: Aldus reports what is safe to run next and a human chooses.
