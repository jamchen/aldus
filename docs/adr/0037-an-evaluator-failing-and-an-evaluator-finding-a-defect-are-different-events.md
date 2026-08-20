# ADR-0037: An evaluator failing and an evaluator finding a defect are different events

- Status: Accepted
- Date: 2026-08-20
- Relates to: §11 Stages, §12 Quality model, §12.1 Promotion, §20 Production trace, ADR-0030
- Issue: #115

## Context

#115 gave a Stage the ability to declare §12 quality claims: four levels, per-finding-class
enforcement, and calibration evidence where §12.1 requires it. What it did not give a Stage was a
way to **report a finding**. A `StageOutcome` was `completed` or `gate_required`, so an evaluator
that found a problem had exactly one way to say so: throw.

That makes two different events arrive identically. In the trace, an evaluator whose parser threw
and an evaluator that ran cleanly and found an unsupported claim are both `status: "failed"` with a
`STAGE_EXECUTION_FAILED` error, and nothing distinguishes them.

The owner's ruling states the requirement:

> Keep these separate: An evaluator that could not execute, parse its inputs or produce a valid
> report causes an operational Stage failure. An evaluator that executed successfully and found a
> content problem produces an evaluation result. Whether that result blocks is governed by the
> declared evaluation enforcement and calibration contract. Do not encode an ordinary finding as an
> indistinguishable thrown internal error.

The failure this prevents is not hypothetical for the first adopter. They reported a checker that
crashed on every run for the length of a migration, and the crash was counted as a soft finding —
because the two arrived through the same channel, and the channel was configured advisory.

Nor is it symmetric. A crash indistinguishable from a finding fails **open**: the evaluator is
believed to have run. A finding indistinguishable from a crash fails **closed**, loudly, and gets
fixed. Only one of these persists for a month.

## Decision

**`StageOutcome` gains an `evaluated` arm, and the runner applies the enforcement the Stage
declared.**

```ts
| { kind: "evaluated"; output: O; findings: readonly EvaluationFinding[] }
```

Three properties make it worth having rather than a convention:

### A finding is not a failure, and the trace says which it is

A blocking finding settles the attempt as `failed` with `ALDUS_STAGE_EVALUATION_BLOCKED`, category
`policy`. A thrown evaluator settles as `failed` with `ALDUS_STAGE_EXECUTION_FAILED`, category
`internal`. Both stop work; a reader can tell which happened. That is the whole ask.

### The Stage does not decide whether its own findings block

Enforcement comes from the declared `StageEvaluationChannel` for that finding's class, not from
anything in the outcome. A Stage that declares a class advisory cannot stop a Run by reporting it,
which is what makes declaring a channel worth anything: the declaration is reviewable, and §12.1's
promotion rule attaches to the declaration rather than to per-run behaviour. It also closes the
route around calibration — a model-assisted channel that could not be declared blocking without
evidence must not become blocking by throwing instead.

### An undeclared finding class is refused, not defaulted

A finding whose class no channel declares fails the stage with
`ALDUS_STAGE_EVALUATION_INVALID`. Defaulting it either way was considered and rejected in both
directions: defaulting to advisory silently discards a finding the adopter believed was blocking,
and defaulting to blocking stops Runs on a class nobody reviewed. The safe default and the useful
default point in opposite directions, which is the signal that there should not be one.

### Advisory findings are recorded

They land in attempt metadata whether or not they block. This required a real fix, not just a
write: attempt notes were captured into a value _before_ execution settled, so anything appended
during outcome handling was dropped. An advisory finding lost that way leaves a green record — and
§12 is explicit that a green record never means semantic correctness. The capture is now late-bound
and the loss is mutation-tested.

## Consequences

- An evaluator Stage reports rather than throws, and the report is structured: class, message, and
  optional category and locator. Category and locator are adopter-defined open strings — Core names
  no severity scale or document model (§4.2).
- `throw` retains its meaning for evaluators: the evaluator itself is broken. That is the narrower
  and more useful meaning it should have had.
- No migration. `completed` is unchanged, and an existing Stage that throws on a finding keeps
  working exactly as before — worse, but not differently.
- This is ADR-0030's class again — _the runtime knows a fact and does not say it_. The runner knew
  whether a stage had reported or crashed and flattened both into one status. It is the fifth
  instance, and the fourth found by an adopter rather than by review.

## Alternatives considered

- **A `findings` field on the `completed` arm.** Rejected: it makes reporting a defect the same
  outcome as producing a clean result, differing only by whether an array is empty. The distinction
  should be legible in the shape, not in a length check every consumer must remember.
- **A dedicated `EvaluationOutcome` type separate from `StageOutcome`.** Rejected as more surface
  for the same information. An evaluator Stage is a Stage; it produces declared outputs like any
  other, and its findings are additional, not a replacement.
- **Let the Stage mark a finding blocking.** Rejected — it is the defect wearing new clothes. A
  Stage that can promote its own findings makes the declared channels decorative, and §12.1's
  calibration requirement becomes advice.
