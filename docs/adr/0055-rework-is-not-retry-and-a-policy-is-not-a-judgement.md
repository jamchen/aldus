# ADR-0055: Rework is not retry, and a declared policy is not a judgement

- Status: Accepted
- Date: 2026-08-27
- Relates to: §11 Stages, §12 Evaluation, §13 Gates, §19.1 Reliability, ADR-0021, ADR-0028, ADR-0037, #219, #220

## Context

The first adopter's established script process was:

```text
candidate script → oracle → blocking findings? revise and evaluate again → clean? human freeze
```

The human owned the final editorial freeze. **The human did not decide every ordinary oracle
round.** On Aldus that loop has nowhere to live, so it becomes either a `gate_required` per failed
pass — which regresses an agent-driven process into repeated manual routing — or an operator's shell
loop, which is outside the record entirely.

This ADR fixes the boundaries before the primitive is designed, because the four things in play
look alike from a distance and the wrong pairing produces a mechanism that is correct and useless.

## The four, and what distinguishes them

**Retry** repeats an execution after an _operational_ failure. The input is unchanged; the intent is
that the same work now succeeds. `retrySafety` governs it because the question is whether repeating
an external effect is safe.

**Rework** consumes a finding, performs a declared repair, and produces a **new artifact**. The
input to the next evaluation is _deliberately different_. It is not a retry of anything: nothing
failed operationally, and repeating the previous execution unchanged would be wrong.

**Producer judgement** is a person deciding whether another round is warranted — evidence is ready
and the call is theirs. That belongs in a named, subject-bound gate (#219), not in an operator's
unrecorded shell loop.

**Declared automatic policy** is a reviewed statement that named blocking findings require repair
and re-evaluation within explicit bounds. **Executing that policy is not a judgement anyone is
making**, and gating it per finding removes automation the pre-migration process already had.

The correction that produced this ADR: an earlier ruling made loop continuation producer judgement
_universally_. That was right about the instance in front of it and wrong as a rule. `gate_required`
is one release mechanism, not the universal quality-loop controller.

## Decision

**The boundary is who decided, not how many rounds happened.**

- Operational failure → retry, bounded by `retryPolicy`, governed by `retrySafety`.
- Blocking finding + a declared policy that covers it → **rework round**, bounded by the policy.
- Blocking finding + no policy, or a policy that does not cover this finding class → `gate_required`.
- Bound exhausted, verdict ambiguous, finding class unknown, repair unsafe, or **oscillation** →
  `gate_required`.

**A policy is a declared, durable, reviewable object, and its bound is an authorised value.** The
five-round cap and `#219`'s bound-as-authorised-value are one object and must be built once. A
policy an operator can raise mid-run by editing config is not a bound.

**No graph cycle.** The DAG's static ordering guarantees stay (ADR-0028). Iteration lives above the
graph as a controller, not inside it as a back-edge.

**Core names no finding classes, repair stages, or thresholds** (§4.2). The policy is
adopter-supplied; what Core owns is that it is declared, bounded, durable, and that its exits are
decidable.

**A stage still cannot promote its own findings.** ADR-0037's declared-channel enforcement is
unchanged: rework consumes findings the enforcement already classified as blocking. A controller
that could reclassify them would be a stage promoting itself with extra steps.

## Consequences

### Oscillation cannot be detected from one round

Criterion 7 lists **oscillation**, and it is the only trigger on that list invisible to a controller
that sees the latest verdict alone. Detecting it requires comparing artifact digests **across**
rounds — A → B → A is two clean-looking rounds and one loop that will never converge.

Criterion 6's provenance already records what is needed: each round's input digest, output digest
and verdict. So the controller's durable state must be the **round history**, not the latest result,
and that is a design constraint rather than an implementation detail. Stated here because a
controller built on the latest verdict satisfies every other criterion and cannot implement this one.

### Every automatic exit lands on a gate, so the gate must be decidable

Criteria 5 and 7 both terminate in a named `gate_required`. Before `0.2.0-next.35` an unregistered or
misspelled gate id recorded a permanent, silent `waiting_for_gate` that no approval could clear — so
every escalation path in the automatic case ended at a mechanism that could accept an unresolvable
name. **An escalation that cannot be decided is worse than no escalation, because it looks like the
loop stopped safely.** That precondition is closed; this ADR records why it was a precondition.

### Durable resumption crosses a paid boundary

"Restarting between rounds does not repeat a completed paid effect" is not a controller property
alone. A process killed mid-round leaves a reservation holding authorization with its dispatch
begun, and resumption must determine whether that round's paid effect completed. The state that
answers it must be visible to the operator as well as to the controller — `0.2.0-next.35` made held
reservations visible in `costs` for that reason.

### What this ADR does not decide

The **shape** of the primitive: a controller above the graph, a composite execution contract, or a
new declared object. This settles which cases it must separate and what it may not do, so that a
shape can be judged against something. It does not choose one.

## Alternatives rejected

**`gate_required` per failed evaluation.** Correct where convergence is a judgement, and it is the
current behaviour. As a default it converts a declared policy into repeated manual routing and
removes automation the adopter already had before migrating.

**`retryStage` for rework.** Retry repeats an execution after operational failure; rework
intentionally changes the evaluator's input. Reusing it would make `retrySafety` — a statement about
repeating an external effect — govern a round that is not a repeat, and would record a new artifact
as another attempt at an old one.

**A back-edge in `WorkflowGraph`.** Would give the loop a natural home and cost the DAG's static
ordering guarantees, which every other part of the runtime reads (ADR-0028).
