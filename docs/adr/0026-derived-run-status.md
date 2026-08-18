# ADR-0026: A Run's status is derived; its completion is declared intent

- Status: Accepted
- Date: 2026-08-18
- Closes: issue #47
- Relates to: §6.2 Production Run, §11 Workflow, §19.1 Reliability, §19.2 Security, §20 Production
  trace, ADR-0004, ADR-0008, ADR-0009, ADR-0021

## Context

`RunManifest.status` was written once, at creation, and never again. Neither was `currentStage`,
and `updatedAt` never moved past `createdAt`. Running a stage to success, halting at a gate, and
failing all left the manifest exactly as `startRun` wrote it — so four of §6.2's six states were
unreachable through the public API, and the fifth was only ever the initial one.

The stage-level record was correct throughout: `stages.json` and `events.jsonl` both showed every
attempt, its outcome, and its artifacts. It was the Run-level _summary_ that was stale, and that
summary is the first thing `status` and `inspect` print.

Found by the first external adopter, whose workflows run 16 to 19 stages. Two concrete costs:

- **A finished Run was indistinguishable from an untouched one at a glance.** §5.1 makes long
  pauses ordinary, so an operator returning after a day could not tell from the manifest whether
  a Run was mid-production or done. `run.json` is also the natural thing to grep across a
  directory of Runs, which is where it hurt most.
- **There was no way to abandon a Run.** With nothing that could set `cancelled`, a Run started
  by mistake or superseded by a re-cut stayed indistinguishable from live work forever.

## Decision

### 1. Derive the status on read; never write it back

A Run's current state is computed from its stage executions and its cancellation record, by a
pure function (`deriveRunState`). The stored `status` and `currentStage` record how the Run was
_created_ and are never rewritten.

This is the pattern the runtime already uses wherever a summary could disagree with its source:
ADR-0009 derives gate state rather than storing invalidations, and ADR-0008 makes `stages.json` a
cache rather than truth. A stored Run status has exactly the same failure mode, and demonstrated
it.

Not writing it back is the load-bearing half. Persisting a derived value would recreate the drift
this fixes — and ADR-0004 requires a store to preserve unknown properties across a
read-modify-write, so a stale cached status would survive every future round trip and outlive the
fix that was supposed to remove it.

The stored fields remain because §6.2 states them verbatim, and because the moment of creation is
itself a fact worth recording.

### 2. Completion is intent declared at `startRun`, not an inference

`RunManifest.goalStages` names the stages a Run intends to reach. `completed` means every one of
them has succeeded and nothing is in flight.

The first draft derived completion as "every stage in the workflow graph succeeded." The adopter
showed that describes "done" for neither of their two shows:

- **A stage may be conditional on the edition.** One 19-stage graph serves monthly episodes and
  specials, and two stages are monthly-only by editorial ruling. Under graph-completion, no
  special would ever complete.
- **A run may deliberately stop short.** Their default mode reproduces a published episode and
  compares; the publishing stages are unreachable by construction because no release adapter is
  granted. Such a run finishes everything it was ever going to do and would read `running`
  forever.

For a special in shadow mode, 4 of 19 stages never run **by design** — the common case, not an
edge.

The rule that generalises past those two shows:

> **Optionality is not a property of the stage. It is a property of this episode's edition.**

That is why an `optional` flag on a stage node was rejected: it would make the graph lie about
every other Run that does require that stage, permanently and for everyone. Declaring intent per
Run puts the variable thing where the variation actually lives.

`goalStages` is **plural** because §11 calls a workflow a graph and a graph may end in several
places at once — the adopter has two genuine parallel terminals. Singular would have forced them
to pick one and pretend, or to chain unrelated stages to manufacture a single tail.

### 3. A goal the graph does not contain is refused at `startRun`

Validated only when a graph is supplied; without one there is nothing to check against, and
refusing a goal we cannot verify would block precisely the adopters who have not adopted graphs.

A typo would otherwise produce a Run that silently never completes, with nothing to point at —
the same failure shape as a config key that loads and is dropped, where the symptom appears
nowhere near the cause.

### 4. Cancellation is recorded, never derived

`RunManifest.cancellation` holds when the Run was abandoned, by whom (§19.2), and optionally why.
Its presence is what makes a Run `cancelled`; nothing else can.

No amount of reading an append-only log distinguishes a Run someone gave up on from one they are
still thinking about. §5.1 makes long pauses ordinary, so silence means nothing. Abandonment is a
decision, so it is recorded as one.

Cancelling twice is refused rather than silently repeated: the record of who abandoned a Run and
when is what §20's production trace depends on, and overwriting it would lose the only copy.

`cancelRun` is distinct from `RunStageOptions.signal`, which aborts an in-flight attempt. That
stops the work; this retires the Run.

### 5. A lingering failure does not suppress completion

`completed` is checked before `failed`, and does not require that no stage ever failed.

> The Run status answers **where this Run is**, not **whether the work was good**.

Quality already has an adjudicator, and it is load-bearing: a failure that mattered blocks a gate,
the gate blocks the stages downstream, and the goal stages never succeed. So `completed` cannot
be reached past a failure that counts. Making it _also_ suppressed by any historical failure would
have the field adjudicate quality badly on top of gates adjudicating it well.

The concrete cost of the stricter rule: §6.3 makes attempts append-only, so a stage that failed,
was diagnosed as environmental, and re-ran green keeps that failed attempt forever — correctly.
One bad afternoon would make the Run permanently uncompletable, and the only remedy would be
starting a new Run, **abandoning the accepted paid takes attached to the old one** (§15.1). An
expensive answer to a cosmetic question.

### 6. Rejected: "nothing runnable and nothing blocked"

It needs no new input, which is its whole appeal. It also makes a Run stuck for a boring reason
indistinguishable from one that finished — exactly the failure `status` exists to prevent.

## Consequences

- **This is a breaking change.** Anything reading `RunManifest.status` and expecting `"created"`
  now sees a derived value through `RunSummary.status` and `RunReport.state`. An adopter runbook
  telling operators to ignore the field becomes wrong rather than merely unhelpful.
- The stored manifest still reads `created` on disk. Reports are the place the derived answer is
  surfaced; `run.json` remains the record of what was written, not a cache of what is true.
- `status` costs one stage-state read per Run when listing. That is what makes a directory of Runs
  answer "which of these is finished" at all.
- **The workflow graph carries no edges**, so a true terminal stage cannot be derived from it. The
  default is therefore _every_ stage the graph names — the naive reading of "finished", right for
  a workflow whose stages all always run and overridable per Run for one whose do not. The
  default is a convenience; the declaration is the rule.
- A Run with neither a graph nor declared goals can never be `completed`. That is honest: nothing
  has said what finishing would mean. `deriveRunState` guards the vacuous case explicitly, because
  `[].every(...)` is true and an unguarded rule would call a brand-new Run complete.
- `SCHEMA_VERSION` moves 1.2 → 1.3. Both new fields are optional, so every 1.2 record stays
  readable and reads as `forward` (ADR-0003) — this is the first exercise of that rule against
  real stored adopter data, and a test reads a 1.2-shaped manifest to prove it.

## Alternatives considered

- **Maintain the status in the runner**, alongside the stage lifecycle events it already emits.
  Rejected: it keeps two sources of truth and the manifest can still disagree with the log after
  a crash between the two writes — the failure ADR-0009 already rejected once for gates.
- **An `optional` flag on a workflow stage node.** Rejected: see decision 2. Optionality belongs
  to the Run, not the stage.
- **A `completeRun` verb symmetric with `cancelRun`.** Rejected: finishing becomes a manual act an
  operator can forget, and then `status` lies in the friendlier direction — which is worse than
  lying in the unfriendly one, because nobody investigates it.
- **Deriving `completed` from an empty action plan.** Rejected: see decision 6.
