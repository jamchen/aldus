# ADR-0059: A settled gate is not a wait, and the stage parked on it is runnable

- Status: Accepted
- Date: 2026-09-03
- Closes: issue #278
- Relates to: §6.2 Production Run, §11 Workflow, §13 Gates, §24 Operator surface, ADR-0009,
  ADR-0021, ADR-0024, ADR-0026, ADR-0058

## Context

Reproduced by the first adopter on a real Run. A repair loop's stage threw a gate-required signal
and parked; the operator decided the gate; a **different** stage consumed the decision and
succeeded; the path finished. The loop that would have driven the parked stage had recorded its
stop and does not re-enter, so nothing will run it again on its own.

The records were right:

```
stage-a  waiting_for_gate  attempts: 1
stage-b  succeeded
gate-g   satisfied
```

The report of them was not:

```
Run run_… (waiting) at stage-a
Waiting  gate-g
```

Two defects, and they are different questions.

**The display.** `gate-g` is satisfied. Nothing awaits a decision on it, and a reader was told to
go and decide something that had been decided. Same family as #204 — where a satisfied blocking
gate printed `(advisory)` — one field over: there a gate's _class_ was rendered from what was true
of it now, here what is true of it now was rendered from a stage's _record_ of where it stopped.

**The derived status.** ADR-0026 derives `waiting` from any stage whose latest attempt is
`waiting_for_gate`. Nothing transitions a stage out of that status, and §6.3 makes attempts
append-only, so the Run reported `waiting` for as long as the record existed — permanently, with
no action anywhere that would clear it.

And the plan said **nothing at all** about the parked stage. Its halted-gate arm found the gate
not decidable and moved on; its runnable-stage arm skipped a status that was neither `never_run`
nor `queued`. So the one act that moves the Run — running the stage again — was the only one
missing, while the gate that needed nothing was named as the wait.

## Decision

### 1. A stage parked on a **settled** gate is released, not waiting

`deriveRunState` classifies each parked attempt against the gate states: a gate that is
`satisfied` or `waived` releases the stage parked on it, which then counts as neither in flight
nor halted. It falls through to the ordinary rules — `completed` when the declared goals are met,
`running` when work is outstanding.

This is #241 read one level up. #241 established that a decided gate releases the stage parked on
it _at the runner_: the stage may be claimed and run again. If that is true of the stage, the Run
containing it is not waiting for a gate — it is waiting for someone to run a stage, which
ADR-0026 already has a word for.

The adopter's Run therefore reports `completed`: its declared goal succeeded, and a stage nobody
will re-run no more blocks completion than a stage that never ran. ADR-0026 decision 2 settled
that shape already — optionality belongs to the Run, and the Run declared what finishing meant.

### 2. Settled means `satisfied` or `waived` — not merely decided

#241's runner predicate asks whether **any** decision exists, deliberately: a rejection entitles
the operator to act on the answer they got, so it unparks the stage too.

This rule is narrower, because it answers a different question. The runner asks _may this stage be
claimed_; the status and the plan ask _is anything outstanding_. After a rejection or a
changes-requested, something is: a fresh decision, which the gate is still blocking on and which
`status` must go on naming. Widening this to every recorded decision would report a Run as
`running` while an operator's next act is an approval — trading a false wait for a false calm,
which is the worse direction (ADR-0026 rejected "nothing runnable and nothing blocked" for the
same reason).

One consequence of admitting `waived`, stated because the status now asserts something the runner
will not act on: ADR-0058 deliberately keeps refusing to convert a stage's `GateRequiredSignal`
into a conflict on a waiver, since a waiver is §13's statement that a check was bypassed _without_
being passed. So for a waived gate the plan's "run the stage again" invites an unconditional-throw
stage to park a second time. That is the correct status — nobody owes a decision — and it is not a
remedy in that one class; the remedy is the stage reading `context.gateStatus` and deciding what a
waiver means for itself, which is where ADR-0058 put it.

The predicate reads the gate's **state**, never `currentlyBlocking`. An advisory gate is never
`currentlyBlocking` whatever its state, so reading that field would release a stage parked on an
_undecided_ advisory gate — #204's confusion, reintroduced in the dangerous direction.

### 3. A released park is reported, and its action is `run`, not `approve`

`RunState.releasedStages` names each released park with its gate, `status` prints it as
`Released <stage> — gate "<gate>" has been decided; run the stage again`, and the plan offers the
`run` command.

Reporting it is what keeps this from trading a wrong answer for no answer. The stage is still
parked, and — this is the operator-facing fact the runtime knows and the adopter had to work out —
**nothing in the runtime re-runs a parked stage.** A Run that quietly stopped mentioning it would
be accurate about its status and silent about the only outstanding act.

The offered action takes the ordinary runnable-stage path, so ordering, the other gates the stage
requires, and unresolved spend are all still consulted (ADR-0021, ADR-0024, #215). Only the
sentence differs, because what the reader needs to know is different: this stage ran, stopped, and
the stop has been answered.

### 4. `deriveRunState` takes the gate states, and takes them as a required argument

The derivation cannot answer the question without them. The argument is required rather than
optional-with-a-default because the default _is_ the defect: a caller who forgot it would silently
get the pre-#278 answer, and a flag that must be remembered is what this repository's own working
agreement exists to replace. A caller with no gate states passes `[]` and says so.

A gate absent from the supplied states is evaluated conservatively as still awaiting a decision.
An unknown gate is not evidence that a decision exists — the same rule ADR-0021 applies to an
unknown stage.

The cost is one gate evaluation per Run in the `status` listing, alongside the stage-state read
ADR-0026 already accepted there. That is what makes a directory of Runs answer "which of these
needs me" rather than "which of these has ever parked".

## Consequences

- **Breaking, twice, and only one half is visible to a compiler.** `deriveRunState` gains a fourth
  required parameter, and `RunState` gains a required `releasedStages` member — both caught by
  `check-breaking-notes.mjs`. The half it cannot see is `RunState.waitingOn`, whose _meaning_
  narrowed: a settled gate no longer appears in it. An adopter rendering that field gets a
  different list from the same code, which is exactly the shape the working agreement names as
  invisible to the built-`.d.ts` comparison. It is called out in the CHANGELOG for that reason.
- A Run in the adopter's shape now reports `completed` and lists the released park. A Run whose
  released park _is_ an outstanding goal reports `running` with the stage named — never `waiting`,
  because no gate is waiting for anyone.
- The stage record is untouched. The status is derived on read and never written back (ADR-0026),
  so nothing here rewrites the `waiting_for_gate` attempt §6.3 keeps.
- Re-running a released stage is accepted by the runtime, which is #241 working. What the stage
  then does is the stage's business: one that asks for the same gate again meets ADR-0058's
  conflict, which names the remedy rather than parking a second time.

## Alternatives considered

- **Transition the stage out of `waiting_for_gate` when its gate is decided.** Rejected: it makes
  the report agree by rewriting the record, which is what ADR-0026 exists to avoid and what §6.3
  forbids. The record was never wrong.
- **Report `waiting` and add a way to declare the park abandoned.** The issue's second option. It
  is a new verb, a new stored fact, and a new thing an operator can forget — for a situation the
  runtime can already derive. Rejected as the larger, less reversible option; if a later adopter
  needs to say "this park is not coming back" for a gate that is _not_ settled, that is a
  different decision and this one does not foreclose it.
- **Treat any recorded decision as releasing the wait**, matching #241's predicate exactly.
  Rejected: see decision 2.
- **Filter the settled gate out in the renderer.** Rejected: §18 requires the JSON and the human
  summary to come from one service call, so a renderer-side filter would make the two disagree
  about the same moment — and every other adapter would keep the defect.
