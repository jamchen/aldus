# ADR-0057: A durably running attempt is a reconciliation, not a verdict

- Status: Accepted
- Date: 2026-09-01
- Relates to: §11 Stages, §12 Evaluation, §13 Gates, §19.1 Reliability, §19.3 Cost, ADR-0044,
  ADR-0049, ADR-0055, ADR-0056, #220, #244

## Context

The bounded rework controller (ADR-0055) decides over durable state. Three shapes of state were
named when it was designed: the evaluator ran and said something classifiable, the evaluator ran and
said something unclassifiable, and no evaluation is recorded at all. `ReworkVerdict` carries the
first two and `no_evaluation` carries the third.

The first adopter named a fourth after a dispatch was killed by a harness timeout:

> An attempt stuck in `running` is neither converged nor a finding nor an absent evaluation. It is a
> round that started and cannot be said to have happened or not happened.

The record they had showed `status: "running"`, attempt 10, and **no cost record**. Their own
observation is what makes the state a category rather than an instance: _a different kill, one
second later, would show a charge and an artifact with the same status._ Both are legal timings of
one durable state, and neither the presence nor the absence of a charge or an artifact settles
whether the evaluation happened.

`no_evaluation` is the nearest existing arm and is not this one. That arm says _nothing ran_; here
something may have run to completion and died before writing anything down. Reading a running
attempt as `no_evaluation` would state a fact about the world the record does not hold — the same
defect, one arm along, that splitting `not_evaluated` out of the empty evaluated state fixed in
`0.2.0-next.43`.

## Decision

**A durably running attempt is its own state, and its remedy is reconciliation rather than a
decision.**

Four boundaries, and each names something this state is not.

**1. It is not a `ReworkStopReason`.** Every stop reason in ADR-0055 terminates in a named
`gate_required`, and every one of them is answered by a person _deciding_. This one is answered by
someone _establishing whether a process is dead_, which is a fact-finding act and not a judgement
about the artifact. Filing it as a stop reason would hand a gate approver a question their approval
cannot answer — and `approvedContinuationDigests` would then appear to clear it, which is the
"appears to release the loop and does not" failure ADR-0055 already records once.

**2. It is not a `GateDecision`, and no human policy decision is available for it.** §13's gates
bind a decision to its subjects. Nobody can decide, from the record alone, whether attempt 10 is
alive; a gate offering that choice would be asking for a guess and recording it as authority.

**3. It is not a convergence, an ordinary round, an ambiguous verdict, or an absent evaluation.**
Convergence releases the next stage; a round spends an authorised bound and a paid repair; ambiguity
says the evaluator spoke unreadably; absence says it never spoke. A running attempt supports none of
those statements.

**4. The controller must not decide liveness and must not execute the recovery.** #244 already
settled the recovery contract: a stage recorded `running` refuses `run` and `retry` without
`--force`, the refusal names what the runner cannot see, and the reservation store's
`StageDispatchEvidence` says whether a provider call may already have been billed (ADR-0044).
That path is **named** by the new decision and **never invoked** by it. A controller that probed,
killed or forced would be deciding §19.1's question — two runners on one side-effecting stage — with
no more evidence than the operator has and none of the authority.

So the controller gains one verdict shape and one decision arm:

- a verdict bound to the **exact attempt identity** (`stageId`, `attemptId`) and the candidate
  subject (`artifactDigest`), carrying whatever cost records and artifacts the record already
  attributes to that attempt;
- a decision arm that carries the same identity forward and explains that the running attempt must
  be reconciled — established dead, or allowed to finish — before rework can continue, naming
  `--force` as the bounded remedy without invoking it.

**Evidence is reported, never read as an outcome.** Recorded costs and artifacts are attached
because the operator needs them, and the docstrings on both fields say what they do not establish:
an empty list is not evidence that nothing happened, and a non-empty one is not evidence that the
evaluation finished. This is ADR-0049's rule applied one level in — an unestablished state is its own
answer — and the same asymmetry the takeover refusal already words as a claim about the store rather
than about the world.

**Identity is validated, and validation fails closed.** A verdict claiming a running attempt without
a usable `stageId`, `attemptId` or `artifactDigest` names no attempt, so the remedy it points at
cannot be carried out. That is refused as a validation error rather than answered with a
reconciliation notice about an attempt nobody can find. The error carries the failing path and issue
code only (§19.2).

**A running attempt takes precedence over an older completed evaluation of the same stage.** The
newest completed attempt may hold a perfectly readable verdict; acting on it while an unreconciled
attempt of the same stage stands would release a stage, or spend a round, across a window whose
paid effects are unknown. Precedence is the fail-closed direction and is the reason this state is
checked before every other arm.

## Consequences

### `ReworkVerdict` and `ReworkDecision` each gain a member

Both are exported union aliases, so a caller that _produces_ a verdict or _reads_ a decision
non-exhaustively is unaffected, and a caller with an exhaustive `switch` over either gains a case to
handle. That is a compile-time break for exhaustive consumers and is noted as one in the CHANGELOG.
The built-`.d.ts` comparison in `check-breaking-notes.mjs` does not detect union widening — stated
here rather than left for a reader to infer from a green check.

### The reported preview stops saying "nothing to decide about"

`reworkStatus` previously skipped every non-succeeded attempt, so a Run holding a killed evaluation
reported _no completed attempt has judged a candidate, so there is nothing to decide about_. That
sentence is true about completed attempts and wrong about the Run: there is something to reconcile.
It now reports the reconciliation, the round it interrupts, and the remedy.

### A healthy in-flight evaluation reports the same state

The runtime cannot tell a live dispatch from an abandoned one — the same limit `costs` already
records for a `reserved` reservation holding an execution. So an evaluation that is simply still
running reports as reconciliation-required too, and the wording must therefore never claim the
attempt is dead or that a takeover is safe. It says what is unestablished and who can establish it.
Over-reporting an in-flight attempt is the survivable direction; under-reporting a dead one spends
money twice.

### What this ADR does not decide

Whether anything reconciles automatically, and what a reconciled outcome records. Nothing here
probes a process, kills one, or writes a reconciliation result. It settles the representation and
the refusal, so that an executing half can be judged against something.

## Alternatives rejected

**A new `ReworkStopReason` (`attempt_running`) escalating to the policy's gate.** Smallest diff, and
wrong in the way that matters: it routes a fact-finding task to a decision-making mechanism, and
`approvedContinuationDigests` would let an approval appear to clear it.

**Folding it into `no_evaluation`.** One arm, no new surface, and a false statement: `no_evaluation`
asserts nothing ran, while this state's whole content is that whether anything ran is unknown.

**Inferring the outcome from recorded evidence** — a charge or an artifact means it finished, their
absence means it did not. Both directions are unsound on the adopter's own timing evidence, and the
absence half is the exact claim the `#244` takeover refusal already refuses to make: artifacts reach
the record when a stage settles, so an empty attempt is not evidence that nothing happened.

**Having the controller probe or force.** It would decide §19.1's two-runners question from the same
record the operator has, without the authority and without the ability to look at the machine.
