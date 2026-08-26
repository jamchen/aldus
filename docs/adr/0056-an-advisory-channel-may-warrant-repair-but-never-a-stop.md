# ADR-0056: An advisory channel may warrant repair, but never a stop

- Status: Accepted
- Date: 2026-08-27
- Amends: ADR-0055
- Relates to: §12, §12.1, §13, ADR-0037, #219, #220

## Context

ADR-0055 tied a rework round to a **blocking** finding: _"rework consumes findings the enforcement
already classified as blocking. A controller that could reclassify them would be a stage promoting
itself with extra steps."_

The first adopter compiled against `0.2.0-next.40` and reported what that means in practice. Their
`script.oracle` emits eight finding classes and **all eight channels are declared `advisory`**,
because §12.1 permits an evaluator to become blocking only after calibration and none of the eight
has promotion evidence. So the record reads:

```
evaluationEvidence: { enumeratedFindings: 4, reports: 0, defectCountMeasurable: true }
blockingFindingClasses: []
```

Four findings, correctly classified, and **nothing blocking**. A controller deriving its verdict
from declared enforcement sees zero blocking classes and concludes there is nothing to repair.

**For an adopter who cannot promote a model-assisted channel, the derived verdict is always
`pass`** — so ADR-0055 as written gives a rework loop only to evaluators that already have
promotion evidence, which is the population least in need of one. Their repair loop treats five of
the eight classes as blocking; the runtime sees none. Two systems using the same word for different
things, with no way for either to know.

The adopter did not ask for this to change. They asked for the answer to be written down, so nobody
wires an empty loop and wonders. Writing it down produced a better answer.

## What ADR-0055 got right, and what it conflated

The worry it encoded is real: **a stage must not promote its own findings.** A controller that read
observations and decided for itself which ones stop work would defeat the declaration entirely.

What it conflated is **stopping work** with **warranting repair**. They are not the same act, and
§12.1 constrains only the first — it says an evaluator "MAY become blocking only after it is
calibrated". A bounded repair round does not stop a production: it produces a new artifact, spends
an authorised round, and — when the bound is exhausted or anything is ambiguous — hands the decision
to a named human gate. The human still decides. That is the opposite of an uncalibrated model
gaining the power to halt.

§12.1's own list is the reason this needs care rather than dismissal. Among what promotion SHOULD
consider is _"asymmetric harm caused by unnecessary automatic correction"_ — so the contract already
names automatic correction as a harm an uncalibrated evaluator can cause. **That consideration does
not disappear because the loop is bounded.** It moves to whoever authorises the policy.

## Decision

**A declared rework policy may cover an advisory finding class.** What licenses the round is not the
channel's enforcement but the policy's own authorisation, and the two license different things:

|                    | licensed by                  | may                                    |
| ------------------ | ---------------------------- | -------------------------------------- |
| **Stopping work**  | promotion evidence (§12.1)   | fail the stage                         |
| **Bounded repair** | an authorised `ReworkPolicy` | spend a round, then escalate to a gate |

Neither substitutes for the other. Concretely, and these are invariants rather than guidance:

- **Rework never releases what enforcement blocked.** A blocking class the policy does not cover
  still escalates to a human.
- **Rework never blocks what enforcement allowed.** Its only powers are to spend a bounded round
  and to escalate.
- **Every exit still terminates at a named gate** (ADR-0055 unchanged).

**A stage still cannot promote its own findings**, and this does not weaken that: the stage declares
channels, and a _separate_ authorised object — written by an adopter, not by the evaluator — names
which classes warrant repair. A stage cannot write its own policy any more than it can write its own
gate decision.

**The policy states the harm it weighed.** `ReworkPolicy.automaticCorrectionHarm` is required and
non-empty: §12.1's consideration has to land somewhere, and the party authorising automatic
correction by an uncalibrated evaluator is the one who must have weighed it.

This is the weak kind of mechanism, and it is labelled as one. It catches an author who never
considered the question; it cannot catch a bad answer. `verified at:` in `evidence.mjs` is the same
shape and is kept for the same reason — **the move for an invisible omission is a required field**,
and a field that only makes the omission visible is still worth more than a convention nobody can
see was skipped.

## Consequences

### The controller reads two lists, not one

`decideRework` takes the classes **observed** and the classes **enforcement classified as
blocking**. Repair triggers on policy-covered classes among the observed; escalation still triggers
on a blocking class the policy does not cover. Convergence now means _neither anything blocking nor
anything the policy covers_ — a clean-to-the-runtime artifact with four advisory findings the policy
covers is not converged, and under ADR-0055 it was.

### An adopter no longer needs two vocabularies

The adopter's loop held its own `FINDING_CLASSES` map and applied it to whatever it found —
including attempts recorded weeks earlier under a different declaration. They identified that as a
defect in their own code on reading `blockingFindingClasses`. The policy is now the one place that
mapping lives, and `blockingFindingClasses` is recorded per attempt precisely so a later reader
cannot reclassify an earlier attempt against today's rules.

### What this does not license

It does not let an uncalibrated evaluator stop a production, and it does not lower §12.1's bar for
anything. An adopter who wants an evaluator's findings to **fail a stage** still needs promotion
evidence, and nothing here is a route around that.
