# ADR-0058: A decided gate is not asked for twice

- Status: Accepted
- Date: 2026-09-03
- Relates to: §11 Stages, §13 Gates, §19.1 Reliability, ADR-0021, ADR-0024, ADR-0055, #219, #220,
  #241, #275

## Context

Two paths lead a stage to a gate, and until now only one of them consulted gate state.

**Runner-declared.** A stage's `requiredGates`, or the workflow graph that overrides it (ADR-0021),
names gates that must be satisfied _before_ the stage runs. The services refuse the stage while a
declared gate is unsatisfied (ADR-0024), and a decided gate releases a stage parked on it (#241,
`gateHasDecision`). The gate is a precondition, and the runtime owns the check.

**Stage-thrown.** A stage discovers mid-run that a human must decide — a bounded rework loop that
did not converge (ADR-0055, criteria 5 and 7), an ambiguous verdict, a finding class nobody declared
— and throws `GateRequiredSignal(gateId, { subjectHashes })` or returns `{ kind: "gate_required" }`.
The runner records `waiting_for_gate`. #219 made the runner check that the gate is _known_
(`gateIsKnown`), because an escalation to a gate nobody can decide reads as having stopped safely.
Nothing checked the gate's _state_.

The first adopter reproduced the consequence on a real Run (#275). Their refinement stage throws the
signal unconditionally whenever its journal is not `converged`. The operator approved the gate;
`inspect` showed it `satisfied`; the stage ran again — #241 released it — threw the same signal for
the same gate over the same hashes, and was parked again. The approval had no consumer. The stage
had no port to ask whether the decision it was about to request already existed, and the runner
accepted the request as if it were new.

The contract is silent on both halves. §13 says a decision binds subject hashes and is voided when
they move; §11 says a stage stops at required gates. Neither says what a stage or the runtime does
when a stage asks for a decision that has already been given.

## Decision

### 1. The runner refuses a `GateRequiredSignal` for a gate already satisfied over the same subjects

When a stage throws or returns a gate requirement and the gate is currently `satisfied` — approved
and still bound to the current inputs, the gate engine's judgement — over a decision whose
`subjectHashes` equal the signal's, compared as sorted lists, the runner does **not** record
`waiting_for_gate`. It fails the attempt with `ALDUS_GATE_ALREADY_DECIDED` (category `conflict`,
not retryable), naming the gate and the stage and saying that the decision exists and the stage must
consume it.

The refusal is deliberately narrow. A satisfied gate over **different** subjects is a new question
— the operator approved something else — and parks as before. A gate that is pending, rejected,
stale, waived, or blocked upstream parks as before; `satisfied` is the engine's word and the runner
does not recompute it from the hashes. A stage that supplies no hashes matches only a decision that
binds none. An unwired port, or a gate the port cannot answer for, parks as before.

### 2. The runner does not complete the stage on its behalf

The alternative the adopter's issue names — the runtime completing the stage with its candidate as
output when the gate is satisfied — is not taken. The stage's output is the stage's: the runtime
cannot know what "consume the decision" means for a given stage, and a completion it fabricated
would be an output nothing produced (§20). What the runtime can do is stop the livelock where it can
see it and say what has to happen instead.

### 3. A read-only port on `StageContext`, served by the same wiring the runner refuses on

`StageContext.gateStatus?(gateId): Promise<StageGateStatus | undefined>` lets a stage ask before it
throws. `StageGateStatus` carries `satisfied`, the engine's `state` as an opaque string, and the
decision's sorted `subjectHashes` when one exists. `undefined` means the runtime cannot answer —
no gate engine wired, or the gate not registered — never that the gate is undecided.

One runner option, `gateStatus`, feeds both the runner's arm and the context member, so the answer a
stage branches on and the answer the runner refuses on cannot disagree. It sits beside
`gateIsKnown` and `gateHasDecision` rather than replacing either: `gateHasDecision` is deliberately
blind to a decision's content because its job is to release a parked stage whatever the operator
said, and this arm needs the opposite — the state, and what it binds.

The member is optional on the interface so a test double written against an earlier version still
compiles; the runner always supplies it. Additive: `check-breaking-notes` reports no surface change.

### 4. `conflict`, not a new error category

The issue asked for `invalid_request`. `ERROR_CATEGORIES` has no such member, and adding one is a
MAJOR schema change under ADR-0003 for a single refusal. `conflict` — "concurrent or contradictory
state" — is the honest existing fit: the request contradicts a recorded decision.

## Consequences

- A stage that throws unconditionally, as the adopter's does today, gets a legible failure on the
  attempt after approval instead of a silent second park. It still has to change: the failure tells
  it to read `context.gateStatus` and consume the decision, which is the migration.
- A rejection is not refused by the runner. The stage parks again, and `context.gateStatus` is how
  it learns the answer was "no" and surfaces that as its own outcome. Whether a rejected gate should
  ever stop a Run outright is a stage's or a workflow's decision, not the runner's.
- The comparison is exact. A stage whose hashes are computed differently from the adopter's
  `SubjectsProvider` never matches and parks as before — the pre-existing behaviour, made visible by
  the port returning the hashes the decision actually binds.
- `SCHEMA_VERSION` does not move. No Zod schema gained a field.

## Alternatives rejected

**Extend `gateHasDecision` to return the decision.** Changes a public option's return type from
`Promise<boolean>` — a breaking change to `StageRunnerOptions` for every composition that wired it
— and conflates two questions that must stay separate: "has anyone answered" releases a parked
stage on a rejection, "is it satisfied over these subjects" must not.

**Refuse on any decision, not only `satisfied`.** Turns the operator's "no" into a refusal that
reads like a "yes was already given". Caught by a mutant case that wires `satisfied` to
decision-exists and asserts the rejection still parks.

**Complete the stage with the runner.** Rejected above; the runtime would be inventing an output.
