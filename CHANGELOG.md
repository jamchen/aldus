# Changelog

Every published version, and what changes for someone already using the previous one.

Aldus versions in lockstep: all `@aldus-runtime/*` packages share a version (ADR-0020). Entries
below apply to the whole set unless a package is named.

**Behaviour changes are listed before features.** An adopter should learn that something they
rely on now behaves differently by reading this file, not by watching a test go red.

## 0.2.0-next.54 — 2026-09-01

### Changed

**BREAKING: `ReworkVerdict` and `ReworkDecision` each gain a member, so an exhaustive `switch` over
either needs a new case.**

<!-- breaking: aldus-services:ReworkVerdict -->
<!-- breaking: aldus-services:ReworkDecision -->

A fourth controller state, named by the first adopter after a harness timeout killed a dispatch: _an
attempt stuck in `running` is neither converged nor a finding nor an absent evaluation — it is a
round that started and cannot be said to have happened or not happened._ `no_evaluation` is the
nearest existing arm and asserts something different: _nothing ran_. Here something may have run to
completion and died before writing anything down.

`ReworkVerdict` gains `RunningAttemptVerdict` (`kind: "attempt_running"`) and `ReworkDecision` gains
`kind: "reconciliation_required"`. **Neither is a `ReworkStopReason` and neither escalates to a
gate** — the remedy is for someone to establish whether the process is dead, which is fact-finding
rather than a judgement, so routing it to a gate would hand an approver a question their approval
cannot answer. `REWORK_STOP_REASONS` is unchanged. ADR-0057 records the boundary.

**Migration.** A caller that only _produces_ a verdict, or reads a decision non-exhaustively, needs
no change. A caller with an exhaustive `switch` over `ReworkVerdict["kind"]` or
`ReworkDecision["kind"]` — including one relying on a `never` exhaustiveness check — gains one case
each. `reconciliation_required` carries `stageId`, `attemptId`, `artifactDigest`, `explanation`, and
the optional `recordedCostIds` / `recordedArtifactDigests`; render the `explanation` as given.

Stated as a break rather than left to a green check: `check-breaking-notes.mjs` compares built
`.d.ts` for removed exports and newly required members, and **does not detect union widening**.

**What does not change.** Every existing input decides exactly as it did — not-evaluated, ambiguous,
clean, blocking, oscillation, regression, bounds-exhausted, no-policy. Nothing here probes a process,
kills one, forces a takeover, or spends anything: the decision **names** the `--force` recovery path
from `next.46` and never invokes it.

**`aldus rework status` no longer says "nothing to decide about" for a Run holding a killed
evaluation.**

`reworkStatus` skipped every non-succeeded attempt, so a Run whose evaluator was killed reported _no
completed attempt of "<stage>" has judged a "<kind>" artifact, so there is nothing to decide about_ —
true about completed attempts and wrong about the Run, because there is something to reconcile. Worse
in one shape: a Run holding a stuck attempt **beside** an older clean evaluation previewed
`converged`, which is the arm that releases the next stage, across a window whose paid effects are
unknown.

An attempt recorded `running` now takes precedence over every completed one and previews
`reconciliation_required`, carrying the exact attempt identity, the candidate it is judging, and the
cost records and artifacts the record already attributes to that attempt.

**Evidence is reported, never read as an outcome.** Both legal timings — killed with nothing written
down, and killed a second later with a charge and an artifact already recorded — produce the same
class and the same explanation. A count of either establishes nothing about whether the evaluation
finished, and the rendered line says so.

**The wording is part of the contract here.** A healthy in-flight evaluation reaches the same arm,
because the runtime cannot tell a live dispatch from an abandoned one — the same limit `costs`
already records for a `reserved` reservation holding an execution. So the explanation states what is
unestablished and never that the attempt is dead or that a takeover is safe.

### Added

- `runningEvaluation(attempts, kind)` in `@aldus-runtime/services` — the counterpart to `judgedBy`:
  the newest attempt of an evaluating stage recorded `running`, with the candidate it is judging.
  The digest is absent when the attempt does not consume exactly one artifact of that kind, and the
  caller must not turn that absence into a decision — `reworkStatus` reports no preview and says a
  running attempt still stands.
- Validation on the new verdict: a `attempt_running` verdict without a usable `stageId`, `attemptId`
  or `artifactDigest`, or with a mistyped evidence list, is refused with `ALDUS_INVALID_REQUEST`
  rather than answered with a reconciliation notice about an attempt nobody can find. The error
  carries the failing path and issue code only, never the received value (§19.2).
- ADR-0057, and a cross-reference from ADR-0055's stop-reason list so a reader looking for the
  missing case is not invited to add it there.

## 0.2.0-next.53 — 2026-09-01

### Changed

**The takeover refusal now says what the reservation store establishes about the stuck attempt.**

A stage whose runner died refuses `run` and `retry` without `--force`, and the refusal said the
same thing whether the provider had never been called or a paid call may already have gone out.
Those carry entirely different risk under contract §19.1, and the reservation store has recorded
the difference durably all along: `reservation.dispatch_prepared` is appended **before** the
provider call precisely so that window is visible rather than inferred (ADR-0044,
`docs/design/spend-reservation-store.md` §5). Nothing was reading it.

The refusal now appends one sentence naming which of two rows applies — every active reservation
for the stage is `reserved` with no dispatch recorded, or at least one records a dispatch that may
already have been billed.

**What does not change, and this is the substance of it.** `--force` is still required in every
row. The error code, category and `retryable` are unchanged. No verdict permits a takeover, and no
verdict is a claim that a takeover is safe: the safe row is worded as a fact about **this
workspace's reservation store**, not about the world, because absence of a second reservation is
not evidence there was no second effect — the same limit `an empty attempt is not evidence that
nothing happened` states one sentence earlier, which is kept.

**What changes for an adopter:** a longer message in two of three cases, and the verdict is also
on `details.dispatchEvidence`. An embedder composing its own `StageRunner` sees **no change at
all** until it wires the new port: absent, the message is byte-identical to `next.52`, because a
runner with no way to ask must not assume the safe row. `AldusContext.runnerFor` wires it.

**A reservation stream that cannot be read no longer reads as a stream holding nothing.**

`FileSpendReservationStore` refused to convert a failure to read the **root** into an empty answer
as of `next.36`, and did exactly that one level down: every error from reading a grant's commits
directory was caught and answered `[]`. A grant holding a live reservation therefore read as a
grant holding none — to `aldus costs`, to `costs settle`, and to anything asking what
authorization is committed. Only `ENOENT` is an empty answer now; everything else propagates.

**What changes for an adopter:** a read that used to under-report now throws. That is the intended
direction — an empty answer must come from an empty store, never from a failure to read one — and
it is what makes the evidence above trustworthy: at the composition seam, a failed read becomes
`indeterminate`, which is today's message, never the row saying nothing was spent.

### Added

- `stageDispatchEvidence(transitions, { runId, stageId })` and the `StageDispatchEvidence` type in
  `@aldus-runtime/core` — the rule, shared so no two callers can answer it differently. Scoped by
  `(runId, stageId)` and never by attempt: `reserve` resolves idempotency on `effectKey`, so a
  reservation keeps the `attemptId` of the attempt that _first_ reserved the effect, and an
  attempt-keyed read returns nothing while a dispatched reservation stands.
- `SpendService.stageDispatchEvidence(runId, stageId)` — aggregates every grant stream the Run
  touches and applies the rule. Throws on an unreadable or corrupt stream rather than answering it.
- `StageRunnerOptions.stageSpendEvidence` — the optional port, the third of the same shape as
  `gateIsKnown` and `gateHasDecision`.

## 0.2.0-next.52 — 2026-08-29

### Changed

**A stage failure too long to store no longer leaves the attempt `running`.**

A stage that threw with a message longer than `StructuredError.message` allows produced a
`stage.attempt.failed` event that failed schema validation. The append was refused, the CLI exited
with `ALDUS_SCHEMA_VALIDATION_FAILED`, and `stages.json` kept the attempt at `status: "running"` —
a stage that had stopped, recorded as one still working, with its cost already written down. On a
paid attempt that meant a charge recorded as `charged` beside no outcome at all.

An oversized message is now **truncated at construction** with a marker naming the original
length, the way a cause chain has always been trimmed rather than rejected. An error too long to
store is still an error that happened.

**What changes for an adopter:** a `message` over 4000 characters now ends with
`… [truncated: message was N characters]` instead of failing the write. Nothing that fit before is
altered. If your stage relies on the full text, keep it in the stage's own notes — the durable
record is bounded by contract §19.1 and always was.

**A terminal attempt survives an event the schema refuses for any other reason.**

Truncation covers the case that was reported; it cannot cover every field a stage populates. Where
the full event still will not validate, the runner now writes a reduced one — the same terminal
status, and a minimal error under `ALDUS_STAGE_TERMINAL_RECORD_DEGRADED` carrying
`details.withheldPathCount`, `details.originalCode` and what the attempt said. Only for a terminal
attempt, and only for a validation refusal: a lock timeout or a full disk is not repaired by
writing less, and both still propagate unchanged. A degraded record beats a wrong one.

**No durable record names a rejected path it cannot prove is a schema field.**

`AldusEvent failed schema validation (1 issue).` says how many and not which, so identifying the
field cost a reproduction. Naming the paths was tried and withdrawn before release, in both places
it was tried, and for the same reason.

In Core's validation summary: Core validates against a schema its **caller** supplied, so it
cannot tell a schema field from a `z.record` key lifted out of the value being validated, and a
key shaped exactly like a field name — `AKIAABCDEFGHIJKLMNOP` — defeats any test of shape.
`KnowledgePackRef.scope` is a live instance of such a record.

In the degraded stage record: an interim version named the paths there on the argument that the
runner knows it is writing an `AldusEvent` and can read that schema. It cannot. The runner appends
through the `EventStore` **port**, which any caller may implement, and the port promises nothing
about where a refusal's `details.issues[].path` comes from — so a conforming store may reject with
a path taken from a caller-supplied key, and the shape test and the schema-topology argument
behind it both fail on it. `ALDUS_STAGE_TERMINAL_RECORD_DEGRADED` therefore persists and quotes
**no** rejected path, and reports only `details.withheldPathCount`, which is what tells a reader
the list is absent because it was withheld rather than because the refusal was empty.

`ValidationIssue.path` in `details.issues` is unchanged, which is where a path always was.

**What changes for an adopter:** nothing that shipped. `StructuredError.message` for a validation
failure keeps the wording it has had — do not parse it for field names; read `details.issues`.

### Added

**`truncateErrorMessage`, `truncateErrorMessages`, `MAX_ERROR_MESSAGE_LENGTH`,
`MAX_ERROR_CODE_LENGTH`** on `@aldus-runtime/core` — the bounds `structuredErrorSchema` enforces
and the construction-time trim that keeps a record inside them. A `code` is deliberately **not**
truncated: consumers branch on it, and a shortened code is a different code that no branch
matches.

Reported by the first adopter (#254), from a paid agent stage whose answer became unrecoverable.

## 0.2.0-next.36 — 2026-08-27

### BREAKING

**A reservation store that cannot read its root now throws instead of reporting no reservations.**

`FileSpendReservationStore` caught every error from reading its root directory and returned an
empty list. So a root it could not read was indistinguishable from a root with nothing in it:
`aldus costs` printed an empty ledger for a workspace holding real money, and `costs settle`
answered `Run "…" holds no reservation "…"`. Both stated a fact about the world; neither
instrument had reached the world.

Now only `ENOENT` means empty — a workspace that has reserved nothing has no root yet, which is an
ordinary empty answer. Every other error (a permission failure, a file where the directory belongs,
a root pointed at another composition's idea of the layout) propagates.

<!-- No machine marker: check-breaking-notes reports no surface finding, because the signature is
     unchanged — `listByRun` still returns the same type. The break is semantic: a call that used
     to resolve to `[]` now rejects. That is the same blind spot the next.35 gate entry names, and
     this note is written by hand for the same reason. -->

**What changes for an adopter:** a composition whose spend store is rooted at a path that is not a
readable directory now fails loudly at the first `costs` or `settle` instead of silently reporting
nothing. That is the intended break. Found by the first adopter, whose composition rooted the store
one directory up and one path segment short; twelve dollars sat held and invisible for a day, and
every layer reported success.

### Added

**`FileSpendReservationStore.root`** — the path the store searches, so a refusal can name where it
looked. Two compositions disagreeing about a root is diagnosable in one command when the tool says
which one it used, and took a day of exchanged hypotheses when it did not.

## 0.2.0-next.37 — 2026-08-27

### Added

**`aldus costs abandon <reservation-id> --reason <why>`** — the verb a stranded reservation had no
way to reach.

A process killed between `reserve` and any billing outcome leaves its reservation `reserved`:
nothing survived to classify it, so it never became `billing_unknown`, and `costs settle` accepts
only `billing_unknown`. So `aldus costs` listed a reservation holding $12.00, named `costs settle`
as its resolution, and `settle` refused it — **the one place that tells an operator what to do
named the one command that would refuse them.**

`abandon` records that a person decided the dispatch is not coming back. It records **unknown, not
zero**: an execution killed after minutes of work may well have been charged, so the reservation
keeps consuming its full authorization until a reconciliation resolves it. What it cost is then the
ordinary `costs settle` question. `--decided-by` / `--verbatim` record a transcribed decision,
exactly as on `approve` and `costs settle` (ADR-0054).

It refuses every state but the stuck one: `billing_unknown` goes to `settle`, and a terminal
reservation never resumes (ADR-0044).

`AldusServices.abandonDispatch` is the service behind it. `SpendService.markUnknown` gains optional
`decidedBy` and `transcription`, so a person's judgement that an execution is gone is
distinguishable in the record from the runtime's own classification of a dispatch that returned
without an amount.

### Fixed

**The `costs` listing named a verb the state could not accept.** The held-authorization section
pointed at `costs settle`, which refuses every reservation that section lists. It now points at
`costs abandon`, and the unresolved-charge section still points at `settle`.

**A refusal called a non-terminal reservation terminal.** Reconciling a `reserved` reservation
answered _"A terminal reservation never resumes"_ — false about the reservation it was printed on.
`reserved` is neither resolved nor terminal; it is stuck, which is a third thing the state machine
does not name. It now says so, and names the verb that accepts it.

<!-- No machine marker: check-breaking-notes reports no surface finding. `markUnknown`'s new
     options are optional and `abandonDispatch` is additive, so nothing existing changes shape.
     The listing and refusal changes are text an operator reads, invisible to a `.d.ts` diff. -->

## 0.2.0-next.38 — 2026-08-27

Schema version **1.14 → 1.15** (additive: two new types, no existing type changed).

### Added

**`ReworkPolicy` and `ReworkRound`** (`@aldus-runtime/core`) and **`decideRework`**
(`@aldus-runtime/services`) — the durable half of the bounded rework contract (#220, ADR-0055).

The first adopter's script process ran `candidate → oracle → blocking findings? revise and evaluate
again → clean? human freeze`. The human owned the final editorial freeze and **did not decide every
ordinary oracle round**. On Aldus that loop had nowhere to live: either a `gate_required` per failed
pass, which regresses an agent-driven process into repeated manual routing, or an operator's shell
loop, which is outside the record entirely.

`decideRework` is a pure decision over durable state — the policy, the round history, and the latest
verdict, all of which are on disk. Deliberately: a loop must resume correctly in a process with no
memory of the previous rounds, and a controller holding state in a session cannot be resumed by the
next one.

Its exits: converge, run the declared repair, or escalate to a named gate with one of
`bounds_exhausted`, `oscillation`, `unknown_finding_class`, `ambiguous_verdict`, `no_policy`.

Core names no finding classes, repair stages or thresholds (§4.2) — every such value is an opaque
string the adopter supplies. The policy's bound carries `authorizationId`, because a cap an operator
can raise mid-run by editing config is not a bound.

**No graph cycle.** ADR-0028's DAG keeps its static ordering guarantees; iteration is a controller's
decision about which stage runs next.

**Not yet wired.** This release carries the schema and the decision, not the execution: nothing in
the runner or `status` consults a policy yet, and there is no end-to-end rework test. Declaring a
policy has no effect on a Run in `next.38`.

<!-- No machine marker: check-breaking-notes reports no surface finding. Both types and the
     function are new; nothing existing changed shape. -->

## 0.2.0-next.39 — 2026-08-27

### Fixed

**`aldus costs` printed a remedy the invoking actor may not run.**

Reported by the first adopter from the first real use. The listing said
`aldus costs abandon <reservation-id> --reason <why>`; they ran exactly that as
`ALDUS_ACTOR=agent:coordinator` and got `SPEND_NOT_AUTHORIZED: reconciliation is a human decision`.

The refusal is correct — an agent that could reconcile could release authorization it had itself
consumed (§13.3, §19.3). What was wrong is that the one place telling an operator what to do named
a command that operator cannot run, and that listing is where an agent coordinator looks. It cost
one round trip and would have cost every adopter the same one.

Both remedy lines now depend on the invoking actor. An agent is told to transcribe a human's
decision — `--decided-by <actor> --verbatim <text>` — so the guidance **is** the rule rather than a
sentence about it. A human, or an unknown actor, gets the plain form: printing the clause to
everyone would make it noise a human learns to skip, which is how a hint stops working on the day
it matters.

<!-- No machine marker: check-breaking-notes reports no surface finding. `renderCosts` gains an
     optional second parameter; nothing existing changed shape. -->

## 0.2.0-next.40 — 2026-08-27

### Fixed

**An evaluator's observations survived only as prose.**

An `evaluated` outcome's observations were formatted into `notes` as
`finding/<class>: <message>` and nothing else was written. `locator` and `category` were dropped,
and — the part that matters — so was the `finding` / `report` **discriminant**, the field added in
#140 so a report is never counted as a defect. With it gone, `countEvaluationEvidence` could not be
recomputed from the record at all: `defectCountMeasurable` was _unrecoverable_ rather than false.

**Prose in a record is worse than nothing there.** A consumer that finds nothing writes the
persistence; a consumer that finds `finding/<class>: <message>` writes a regex, it works on the
corpus in front of it, and the day a separator changes the count silently drops. `AggregateReport`'s
own docstring rejects exactly that move for another program's output, and the note format was on the
wrong side of its own argument.

`AttemptMetadata` now carries three optional fields, all recorded through the event log rather than
only into the `stages.json` cache:

- `observations` — the emitted observations, discriminant included;
- `evaluationEvidence` — `enumeratedFindings`, `reports`, `defectCountMeasurable`, counted at the
  time rather than derived on read;
- `blockingFindingClasses` — the classes the stage's declared channels classified as blocking
  **at that attempt**. Recorded rather than re-derived, because enforcement is a property of the
  declaration in force when the stage ran; recomputing it from a later registry would claim a
  classification from a declaration that was not the one applied.

Notes are unchanged and stay. They are now a rendering of the record rather than the record.

All three are optional, so a cache written before this parses, and absence reads as _"this attempt
predates the field"_ rather than as _"the evaluator emitted nothing"_. A stage that is not an
evaluator writes none of them.

Reported by the first adopter, whose oracle has been emitting structured observations for a while
and whose run directory contained zero occurrences of them.

<!-- No machine marker: check-breaking-notes reports no surface finding. Three optional fields on
     `AttemptMetadata`; nothing existing changed shape. -->

## 0.2.0-next.41 — 2026-08-27

### BREAKING

**`ReworkPolicy` requires `automaticCorrectionHarm`, and `ReworkVerdict` requires
`observedFindingClasses`** (ADR-0056, amending ADR-0055).

ADR-0055 tied a rework round to a **blocking** finding. The first adopter compiled against
`next.40` and reported what that means: their oracle emits eight finding classes and **all eight
channels are declared `advisory`**, because §12.1 permits a blocking channel only after calibration
and none of the eight has promotion evidence. So `blockingFindingClasses` is correctly `[]` on every
attempt, and a controller deriving its verdict from declared enforcement concluded there was nothing
to repair.

**For an adopter who cannot promote a model-assisted channel, the derived verdict was always
`pass`** — the loop was unreachable for exactly the population that needs one.

The fix separates two licences that ADR-0055 conflated. Stopping work is licensed by promotion
evidence (§12.1). A **bounded repair** is licensed by the policy's own authorisation, and is not the
same act: it produces a new artifact, spends an authorised round, and escalates to a named human
gate. Neither substitutes for the other, and three invariants hold:

- rework never releases what enforcement blocked — an uncovered blocking class still escalates;
- rework never blocks what enforcement allowed;
- every exit still terminates at a named gate.

`automaticCorrectionHarm` is required because §12.1 lists _"asymmetric harm caused by unnecessary
automatic correction"_ among what promotion must consider, and a bounded loop does not make that
consideration go away — it moves it to whoever authorises the policy. It is a weak mechanism and
ADR-0056 labels it as one: it catches an author who never considered the question, never a bad
answer.

**What changes for an adopter:** a `ReworkPolicy` literal gains one required field, and a caller of
`decideRework` supplies the classes observed alongside the classes enforcement blocked — both read
straight from `AttemptMetadata` as of `next.40`. An artifact with advisory findings a policy covers
now reworks where it previously converged.

<!-- breaking: aldus-services:ReworkVerdict.observedFindingClasses -->

<!-- No marker for `ReworkPolicy.automaticCorrectionHarm`, and the asymmetry is the tool working as
     documented rather than a gap in this entry. `ReworkVerdict` is a plain interface, so a newly
     required member is visible as the absence of a `?` and check-breaking-notes found it.
     `ReworkPolicy` is Zod-inferred, so optionality lives in `z.ZodOptional<…>` and a newly required
     member reads identically to an existing one — the false-negative direction of the blind spot
     the tool's own source records. Both breaks are described above; only one could be detected. -->

## 0.2.0-next.42 — 2026-08-27

### Added

**A rework loop that is measurably getting worse now stops** — the `regression` stop reason
(#220, ADR-0055).

Reported by the first adopter, from a real run, while writing the `automaticCorrectionHarm` that
`next.41` made required:

> A's first repair round took the script from 4 blocking findings to 7 **by adding explanation.**
> Narration grew 2,246 → 2,551 → 2,904 characters across three rounds. A comprehension oracle reads
> a longer script with more connective tissue as an improvement — so the loop can make a commentary
> script worse while every number it watches says better.

**Oscillation cannot see this**: every round produced a different artifact, so every digest is new.
The loop spends its whole bound and every paid repair going downhill, and each round looks like
progress.

`decideRework` now escalates when the finding count **increased** over the previous round. Increase
is the unambiguous signal; equal is not progress and deliberately not a stop, because a repair that
resolves a deep problem and exposes a shallower one nets zero and the bound already covers that.
Checked before oscillation and before the bound, so a person is told _"the repair made it worse"_ —
which is the fact that makes raising the bound the wrong move — rather than _"the bound is spent"_,
which invites raising it.

`ReworkVerdict.findingCount` and `ReworkRound.inputFindingCount` are both **optional**, and when
either is absent the arm does not fire. That is a hole and is named as one: a count over
report-shaped evidence is not a smaller number, it is not a number (#140), and inferring one is the
move `defectCountMeasurable` exists to prevent. Take them from
`AttemptMetadata.evaluationEvidence.enumeratedFindings`.

<!-- No machine marker: check-breaking-notes reports no surface finding — both new fields are
     optional and `ReworkStopReason` gained a member, which widens what a consumer may receive
     rather than what it must supply. -->

## 0.2.0-next.43 — 2026-08-27

### BREAKING

**`ReworkVerdict` is now a discriminated union**, and an artifact with no evaluation can no longer
be mistaken for a clean one (#220).

The previous shape was one type whose empty state — no blocking classes, no observed classes — meant
_"the evaluator ran and found nothing"_. **An attempt with no evaluation recorded produces exactly
the same empty state**, so a caller reading `enumeratedFindings: 0` off a record and passing it
through got `converged`: a non-answer read as a pass, in the arm that releases the next stage.

The first adopter has a real instance, and its precise shape is worth stating because it is not the
one anybody guesses. Their oracle skipped its output contract on one dispatch in twelve: **the stage
did the work, registered an artifact, was charged for it, and omitted the fenced block.** The report
is real prose a human can read; only the structure a controller needs is missing. Not a malformed
finding, and not an empty result.

```ts
type ReworkVerdict = EvaluatedVerdict | NoEvaluationVerdict;
```

`{ kind: "not_evaluated", artifactDigest, reason }` escalates with the new `no_evaluation` stop
reason, carrying the caller's own words. Distinct from `ambiguous_verdict`, where an evaluator ran
and its result could not be classified: an ambiguous verdict needs a person to read it, a missing one
needs the evaluation to happen.

**What changes for an adopter:** every `ReworkVerdict` literal gains `kind: "evaluated"`. That is the
point of the change rather than a cost of it — a caller can no longer assert an empty evaluation
without saying an evaluation happened.

<!-- No machine marker, and check-breaking-notes made no finding here — a third blind spot, filed
     separately. `ReworkVerdict` went from an exported interface to an exported type alias over a
     union. The export name still exists, so "removed export" does not fire; members are tracked
     only for interfaces, so the ones it used to have simply stop being tracked rather than being
     reported as gone. The check detects a *newly required member*, and this is the same break
     arriving as a change of kind. Written by hand because nothing prompted it. -->

## 0.2.0-next.44 — 2026-08-27

### Fixed

**A stage parked on a gate could never continue after the gate was decided.** There was no path.

Reported by the first adopter, blocking a real episode. Their owner approved
`script.comprehension`, the decision recorded cleanly, and both `run` and `retry` still answered:

```
ALDUS_STAGE_STATE_INVALID: Stage "script.revise" is waiting for a gate decision and cannot be
run again until that decision is recorded
```

The decision **was** recorded. `#assertClaimable` refused on `execution.status ===
"waiting_for_gate"` alone and never consulted the gate engine, and nothing anywhere in the runtime
transitioned a stage out of that status. The refusal's own sentence named a condition nothing
tested — a description that drifted from its mechanism, in the message an operator reads while
holding the approval it says they need.

`next.35` closed _"`waiting_for_gate` on a gate nobody can decide is a permanent silent stop"_. This
is its sibling one step along: **a gate that IS decided, on a stage nothing can restart, is the same
permanent stop with an approval sitting next to it** — and from the outside it reads worse, because
the record shows a human said yes.

`StageRunner` takes `gateHasDecision(gateId, runId)`, wired from the services context to the Run's
decision store. The predicate asks only whether a decision **exists**, never what it says: what a
decision means is the gate engine's and `requiredGates`' business, and a second copy of that
judgement in the runner would be a second, divergent §13. A rejection unparks the stage too — the
operator is entitled to act on the answer they got, and whatever the stage requires is still
enforced where it is enforced.

**Load-bearing for ADR-0056.** A bounded repair loop whose exits all terminate at a gate could never
resume after a human ruled on one, which made `escalate` a termination rather than an escalation —
not what a declared policy says, and not what an owner approving one would think they were
authorising.

<!-- No machine marker: check-breaking-notes reports no surface finding. `gateHasDecision` is an
     optional runner option, and absent means the previous behaviour. -->

## 0.2.0-next.45 — 2026-08-27

### Added

**An escalation carries every artifact the loop produced** — `ReworkDecision.candidates` (#220).

The first adopter's owner bought an extra repair round and the round made the script worse:
`7 → 7 → 2 → 5` findings, narration 2,887 → 3,063 characters. **A rework loop always carries the
newest candidate forward**, so what reaches the gate is the worst artifact of the four, and the
useful one — the round that measured 2 — is reachable only by whoever goes looking. Without this,
every adopter reimplements finding it.

**Reported, never ranked.** Core does not pick, and the reason is the adopter's own evidence rather
than §4.2 alone: a repair that _cuts_ a load-bearing clause produces **fewer** findings and a worse
script, so ordering by count would recommend exactly the artifact their `automaticCorrectionHarm`
warns about. Fewer findings is not better; it is fewer findings. The person at the gate is who §13
says decides, and this hands them what they need to.

Oldest first, latest last, and unsorted — a sorted list is a ranking whatever the docstring says.
`findingCount` is omitted wherever it was never measured, because a `0` would make an unmeasured
artifact look like the best one in the list.

`artifactDigest` is unchanged and still names the artifact the loop stopped on — the latest, which
is not the same as the best. Both facts are now on the decision.

<!-- No machine marker: check-breaking-notes reports no surface finding. `candidates` is a new
     member on a union arm consumers read rather than construct. -->

## 0.2.0-next.46 — 2026-08-27

### Fixed

**The refusal for a stage stuck in `running` now names the flag an operator types.**

It said _"pass `force` to take over"_. `force` is the runner's parameter; `--force` is what the
person reading the message has to type. The first adopter, whose dispatch was killed by a harness
timeout and whose stage stayed `running`, read that as naming a capability the CLI does not expose
and filed it as unreachable.

**It is reachable** — `--force` has been on `aldus run` and `aldus retry` for many releases, and the
CLI rejects unknown flags, so it was never silently ignored. What was true is that **a remedy
someone cannot act on from the text they are handed is the same defect as a missing one, one step
earlier** — the third time this week a message has pointed at something its reader could not use.

The message now reads `--force`, gives the whole command, and names `force: true` for a program.
Three tests pin the flag's existence on both `run` and `retry`, with a control asserting an unknown
flag is rejected — without it, _"`--force` was not rejected"_ would be equally true of a parser that
ignores everything.

<!-- No machine marker: check-breaking-notes reports no surface finding. Message text only. -->

## 0.2.0-next.47 — 2026-08-27

### Fixed

**The refusal for a stage stuck in `running` now says what it cannot see, instead of leaving the
operator to guess whether §19.1's concern applies to them.**

The first adopter proposed that the runtime already knows, at the moment it refuses, whether the
stuck attempt registered an artifact — so a takeover with nothing registered duplicates nothing.

**It does not, and the first version of this change is what showed it.** Artifacts reach the attempt
record when a stage **settles**, and a stuck attempt by definition has not. A test whose stage
recorded two artifacts read zero. Reporting _"nothing to duplicate"_ from that would claim safety
from evidence that cannot exist at that moment — in the message that decides whether someone re-runs
a paid stage.

So the message states the limit rather than a conclusion: this runner cannot tell what the stuck
attempt did, artifacts reach the record at settle and this one has not, it holds no cost store, and
**an empty attempt is not evidence that nothing happened**. `aldus costs --run <id>` shows what the
Run holds — a pointer that would have been false before `next.35`, when `costs` could not show a
held reservation.

§19.1's concern is undiminished. What changes is that an operator is told which parts of it this
runtime can answer.

<!-- No machine marker: check-breaking-notes reports no surface finding. Message text only. -->

## 0.2.0-next.48 — 2026-08-27

### BREAKING

**`ReworkPolicy` requires `candidateArtifactKind`.**

The artifact kind the loop repairs — the _candidate_, not the evaluator's report. Declared because
the join cannot be inferred: a repair stage may consume and produce several artifacts, an
evaluator's own output is normally its report, and the contract gives artifact array order no
meaning. Reading a round out of array position is not lineage.

<!-- No machine marker: `ReworkPolicy` is Zod-inferred, so a newly required member reads identically
     to an existing one — the blind spot #236 made visible and #238 tracks. check-breaking-notes
     names the type as unclassifiable; this entry is by hand. -->

### Added

**`deriveReworkRounds`** — the round-history and provenance foundation for #220 criterion 6
(ADR-0055). **Criterion 6 stays open**: `costIds` is always empty, because attributing a charge to
a round needs the reservation seam #244 is circling, and cost is one of the fields criterion 6 asks
for.

Criterion 6 asks each round to carry the digests it read, the findings consumed, the repair
execution and its output. **All of it is already durable**: a repair is an ordinary stage attempt
with input and output artifacts, and the evaluation that opened the round carries
`blockingFindingClasses` and `evaluationEvidence` as of `next.40`.

So a round is a **reading** of two existing records, not a third one. That is the choice this
codebase makes elsewhere for the same reason — `#pendingObservations` derives rather than stores
_"so the two cannot drift"_ — and a second record of the same facts is a second place for them to
disagree, surfacing when someone is already stuck.

It also avoids making `ReworkRound` a stored Core domain type on the strength of a work package
rather than the contract.

Round ordinals come from position in the record, so a process with no memory of the previous rounds
derives the same ones. That is criterion 4 as a property of the derivation rather than a claim about
it.

**Every join is explicit, and a repair it cannot join is refused rather than inferred.**

The candidate is the single artifact of `candidateArtifactKind` on each side — zero or several
refuses, because picking one would be array position with extra steps. The evaluation that opened a
round is the completed one whose **inputs** include that same digest, because an evaluator judges
its input and emits a report as its output. Not the most recent one: a repair run between two
evaluations, or an evaluation of a different candidate, would otherwise have its findings attributed
to a round that never read them.

`consumedFindingClasses` comes from the evaluation's recorded **observations** intersected with what
the policy covers — not from `blockingFindingClasses`. ADR-0056 permits a reviewed policy to cover
an _advisory_ class, and the first adopter's oracle declares eight advisory channels and no blocking
ones, so deriving from blocking classes recorded `[]` for a repair that consumed four findings.
**That is not conservative absence; it is a false statement**, and it was in the code by the author
of the ADR it contradicts.

Refusals are **surfaced, not dropped**: `deriveReworkRounds` returns `{ rounds, refused }`, and a
repair silently absent from the round list reads as a repair that never ran — understating what was
spent, to a reader comparing it against a bound.

Nothing unestablishable is written as an empty or zero value that reads as a fact: an unrecorded
consumed set refuses the round, an unmeasurable count stays absent, and a running or failed
evaluation is never read as having judged anything.

<!-- No machine marker: check-breaking-notes reports no surface finding. New exports only. -->

## 0.2.0-next.49 — 2026-08-27

### Added

**`aldus rework status`** and `AldusServices.reworkStatus` — the record and the policy preview,
kept apart (#220; **criterion 7 stays open**).

Criterion 7 asks that output explain the current round, why another is allowed, and why the loop
stopped. The first adopter reconstructed exactly that by hand from eight stage executions, a bash
loop and a grep, **and the reconstruction is what went wrong**.

**Nothing executes a declared policy yet, and every line says so.** `recordedRounds` are completed
repairs the policy's joins establish — observed fact, and _not_ proof that a controller ran them
under this policy. `wouldDecide` is a preview of what `decideRework` would answer. Presenting the
second as the first would report a counterfactual as operational status, and an operator reading an
unlabelled _"stopped"_ would take it as something the runtime did. **Criterion 7 is not complete
until the executing path can establish that these executions were rounds under this policy.**

Read-only: nothing runs a repair, spends anything, or writes a record. `rework status` is the only
rework verb — a verb that could _start_ a round is the half that spends money.

`AldusContextOptions.reworkPolicies` supplies declared policies from the composition root, like
`gates` and `stages` and for the same reason — a policy names an adopter's finding classes, repair
stage and bound, none of which Core may invent (§4.2). **Declaring one still has no effect on
execution.**

Five things the output is careful about, each pinned by a test:

- the judged subject is the evaluation's **input** candidate, resolved by declared artifact kind —
  an evaluator's output is its report, so `outputArtifacts.at(-1)` names the wrong thing;
- a running or failed evaluation is **never** read as the latest verdict, and a policy with no
  completed evaluation of its candidate gets **no preview and a stated reason**, never `converged`
  — the two produce the same empty round list and only one of them is a pass;
- repairs the record cannot join are **surfaced**, because one missing from the list reads as one
  that never ran and understates what was spent;
- an escalation prints the decision's **sentence**, not only its enumerated name. _"bounds_exhausted"_
  says what state it is in; _"the last repair increased findings from 4 to 7"_ is the fact that makes
  raising the bound the wrong move;
- candidates are listed in record order and labelled unranked, because the loop carries the newest
  forward and the newest is not the best after a regression; an unmeasured one reads
  _"not measured"_ rather than `0`.

<!-- No machine marker: check-breaking-notes reports no surface finding. New exports and one
     optional context option. -->

## 0.2.0-next.50 — 2026-08-27

### Fixed

**`aldus rework status` was unreachable in `0.2.0-next.49`.**

The dispatch passed `argv.slice(1)` where every other command passes `argv`, so the first real
argument was eaten: `aldus rework status --run <id>` parsed `--run` as the subcommand and refused
with _"rework --run is not a command"_. **The command shipped and never worked.**

Nothing caught it. The tests written for it exercised `renderRework` with hand-built reports, so
they could not see the command failing to reach the renderer at all — an assertion that is also true
when the mechanism is absent, in a new command, hours after the same defect was found by mutation in
`costs` and a test written to prevent it.

Found by installing `next` from the registry and running the command, which is the release check the
owner ruling on #247 requires. It would not have been found by any other step in that list.

Also: a flag is no longer read as a subcommand. `aldus rework --run <id>` now behaves like
`aldus costs --run <id>` and reports status, instead of refusing with a message about the parser
rather than about anything the operator did. A genuine unknown subcommand still refuses **and names
what was typed**.

Three tests invoke the CLI end to end, including a control asserting an unknown subcommand is still
rejected — without it, _"does not say `is not a command`"_ would also hold for a dispatch that
accepts everything.

<!-- No machine marker: check-breaking-notes reports no surface finding. CLI dispatch only. -->

## 0.2.0-next.51 — 2026-08-27

### Added

**An approval at the escalation gate clears the stop it answers** —
`ReworkInput.approvedContinuationDigests` (#220, ADR-0055).

Named by the first adopter: _"a gate that lets a person overrule a stop cannot overrule one of five
causes and not the rest."_ They raised their bound after an escalation and the loop **still**
stopped — on a fact about the history, while the person was answering a question about the next
round. A gate that appears to release the loop and does not is worse than one that never offered.

An approval now clears whichever _continuable_ stop fired: `bounds_exhausted`, `regression`,
`oscillation`. The person at that gate was shown the reason and the candidates, and deciding anyway
is what the gate is for.

It does **not** clear `no_evaluation`, `unknown_finding_class` or `no_policy`. The line is
**meaningful versus impossible, not mild versus severe**: an approval can authorise more work, and
cannot supply an evaluation that was never recorded, a repair instruction for a class nobody
covered, or a policy that does not exist. Clearing those would hand the loop an authorisation it
cannot act on.

**Digests rather than a count, and that is the load-bearing part.** A count cannot say _which_ stop
was approved — one approval would suppress a regression three rounds later that nobody had seen.
§13 already binds a decision to its subjects, so an approval of the artifact the loop stopped on
authorises continuing **from that artifact**, and stops applying the moment the loop produces a
different one. No arithmetic to get wrong.

Convergence is still checked first: an approval buys a repair, never a repair of something that
passed.

<!-- No machine marker: check-breaking-notes reports no surface finding. One optional field on
     `ReworkInput`, which consumers construct rather than receive. -->

## Unreleased

Nothing yet.

## 0.2.0-next.35 — 2026-08-27

Two preconditions for the bounded rework contract (#220). Neither is that contract; both are things
it would otherwise be built on top of.

### BREAKING

**A stage halting at a gate no registry knows now fails instead of waiting.**

`thrown.gateId` was taken as given: nothing checked it against a registered gate, so a typo or a
stale name recorded a permanent, silent `waiting_for_gate` that no `approve` could ever clear —
`approve` answers `GATE_NOT_FOUND` for an id the registry does not hold.

<!-- No machine marker: `gateIsKnown` is optional, so check-breaking-notes reports no surface
     finding. This is a semantic break — a halt that used to wait now fails — which is the blind
     spot that gate names in its own output. Written by hand because nothing prompted it. -->

**An escalation that cannot be decided is worse than no escalation, because it looks like the loop
stopped safely.** That matters here more than a typo usually would: every automatic escalation path
in #220 — bound exhaustion, oscillation, an unknown finding class, an ambiguous verdict — terminates
at this signal, so a controller escalating into an undecidable wait has not escalated.

The refusal is `ALDUS_GATE_REQUIRED_UNKNOWN_GATE`, and it covers **both** the thrown signal and the
returned `kind: "gate_required"` outcome. Fixing only the thrown path would have left the commoner
shape unchecked.

Validation is a port, `StageRunnerOptions.gateIsKnown`, because the registry lives above the
runner. Where none is supplied the id is accepted — a real limit of that layer rather than a pass.

**Migration:** register the gates your stages halt at. If a stage halts at a gate you have not
registered, it was already unresolvable; this reports it at the halt instead of at the Run that
never moves.

### Behaviour changes

**`aldus costs` shows reservations that hold authorization, not only those needing reconciliation.**

`requiresReconciliation` is `status === "billing_unknown"`, so a reservation whose dispatch began
and never settled — a process killed mid-round, holding its full reserved amount — was filtered out
of the report built to make blocked money visible. Measured in the first adopter: **$12 held,
invisible**, while `costs` printed a total as if the Run were idle.

The two kinds are reported separately and not conflated. An unresolved charge **blocks** every
later dispatch and needs a decision. A reservation still holding authorization **may simply be in
flight** — the runtime cannot tell a live dispatch from a process that died mid-round, so it is
shown rather than flagged, and the output says which it cannot tell.

`aldus status` still blocks only on the reconciliation-required kind.

## 0.2.0-next.34 — 2026-08-26

### BREAKING

**`CostReport.unresolved` is a required member.** Anyone constructing a `CostReport` — a test
double, an alternative renderer — must supply it. Reading one is unaffected.

<!-- breaking: aldus-services:CostReport.unresolved -->

Required rather than optional deliberately. An optional field lets a report legitimately omit the
state this release exists to make visible, and a reader cannot tell "no unresolved charges" from
"this producer does not report them" — which is the same conflation the release is fixing one layer
up. Pass `unresolved: []` where there are none.

Caught by `check-breaking-notes`, which is the first time that gate has fired on a change of mine
that I had not already noticed.

### Behaviour changes

**`aldus costs` shows unresolved charges, and shows them first.**

An unresolved charge lives in the reservation store and refuses every later dispatch on its grant.
`costs` read cost _records_ only, so it printed the settled ones and a total **as if nothing were
pending** while the Run could not proceed — invisible in the one command whose whole job is the
money (#215).

```
Run run-abc

1 unresolved charge(s) — every later dispatch on the grant is refused
  res-abc  billing_unknown  reserved 2.0000 USD  (agent.execute)
  resolve with: aldus costs settle <reservation-id> --evidence <what it rests on>
```

The reservation id printed is the one `costs settle` takes, so the report names its own remedy.

**`aldus status` blocks a stage an unresolved charge would refuse**, instead of offering it as
runnable. The action plan was a function of stages and gates and never the money, so an operator
was sent at a command the runtime would reject — for a reason the same report already had in hand.
The block names the reservation and the verb.

### Fixed

**`aldus cancel` pointed at a command that fails.** It closed with _"Start a new Run to continue
this Episode."_ and the obvious next command then failed on a missing `--workflow`. It now prints
the command with its required flags. An instruction that names a step without naming what it needs
is one an operator discovers is wrong by following it.

## 0.2.0-next.33 — 2026-08-26

### Features

**`aldus costs settle <reservation-id>`** — resolve an unresolved charge a human has adjudicated.

```
aldus costs settle res-abc --uncharged --evidence "the dispatch error said nothing was spawned"
aldus costs settle res-abc --amount 0.42 --evidence "provider statement line 3"
aldus costs settle res-abc --evidence "support ticket 88, no answer"   # resolves nothing
```

`SpendService.reconcile` has been able to do this since the reservation protocol landed and
**nothing could reach it**. So a reservation left `billing_unknown` made a Run **terminal**: the
only exit was `cancel`, which discards approvals and artifacts because both are Run-scoped. An
adopter lost two `human_oracle` decisions and $12.57 of settled work to a bookkeeping state whose
true amount was zero and whose own error said `Nothing was spawned`.

Three resolutions, and choosing is the operator's judgement rather than a default. `--amount`
records what evidence established. `--uncharged` asserts that nothing was charged. Passing neither
records that the investigation ended and **resolves nothing** — _"I could not find a charge"_ is
not evidence that no charge occurred, and recording it as one is how a budget is quietly exceeded.

`--decided-by` and `--verbatim` work here exactly as on `approve` (ADR-0054): the named person is
the decider, the acting actor is the transcriber, and the transcriber is derived rather than
accepted.

**On the trust model, because this reverses a deliberate removal.** `AldusContext.operatorConsole`
existed, was wired to the self-declared CLI actor, and was removed because that made the mint
_look_ trustworthy. What settles it is that the same trust was already accepted where it does more
damage: `aldus approve performance.freeze` establishes a spend grant and authorises paid synthesis
on nothing but `ALDUS_ACTOR`. Guarding reconciliation more strictly protected one path while the
path that actually releases money stayed open.

Nothing here authenticates anyone, and it does not claim to. What changed is that the record can
say who decided and who typed, so a transcription is distinguishable from a claim.

Reconciliation still refuses a non-human decider and an assembled authority. Both remain asserted.

## 0.2.0-next.32 — 2026-08-26

### Features

**A decision can record who wrote it down** (ADR-0054).

```
aldus approve <gate> --decided-by human:jamchen --verbatim "同意，可以 freeze"
```

`decidedBy` answered _who decided_ and nothing answered _who wrote the record_, so one field
carried two events — _the person typed it_, and _the person decided it and something else typed
it_. Both read as "a human decided", and the second has one more link that can fail.

**The honest shape was unreachable while the misleading one was not.** Nothing authenticates an
actor string, so an agent transcribing a decision could always set the human as the actor. Refusing
the field never prevented transcription — it prevented _truthful_ transcription.

The case that forced it was operational: an owner working from a mobile app, where `!` is a
terminal feature that is not intercepted, sent an approval command twice and it arrived as text
both times. Everything in the pipeline worked and the channel did not exist. **The shape reachable
from a phone was the dishonest one.**

`transcription` is one object — `{ recordedBy, verbatim }` — because a transcriber with no record
of what they were told cannot be checked, and words with no transcriber name nobody.

**`recordedBy` is derived from the acting actor and there is no flag for it.** A transcriber that
could name itself could name someone else. The engine refuses a decision naming the decider as its
own transcriber (`ALDUS_GATE_TRANSCRIPTION_INVALID`): that is the ordinary case wearing an extra
field, and allowing it would make the field unreadable wherever it is real.

`--decided-by` and `--verbatim` are required together and refused apart.

**This grants no authority.** `permittedActorKinds` still applies to `decidedBy`, so an agent
transcribing cannot record a decision an agent could not make — tested in both directions.

`SCHEMA_VERSION` **1.13 → 1.14** (MINOR, additive, ADR-0003).

## 0.2.0-next.31 — 2026-08-26

### Behaviour changes

**A refusal named a remedy no adopter could perform.**
`ALDUS_TTS_TAKE_ACTOR_NOT_PERMITTED` told an adopter to _"declare `permittedDecisionActorKinds`"_ —
an option that exists on `TtsLedger`, is documented there, and that `ledgerFor` never passed. The
CLI's config rejected the key as unknown, so **following the message was refused for having
followed it.**

`takeDecisionActorKinds` is now a config key, threaded to the ledger, and the refusal names it.

The option exists so §13.3's _"until a scoped evaluator is demonstrably reliable"_ is reachable —
`#100` had enforced the clause as an absolute, which protected the supervised case and left the
condition satisfiable by nobody. The same clause has been configurable on gates the whole time; the
take layer was the one place it was not. Default is unchanged and still human-only.

**Declaring it hands away the human ear.** Accepting a take _is_ the §13.3 judgement, and
`ALDUS_ACTOR` is a string the caller chooses with nothing authenticating it. The refusal says so
now rather than presenting the key as a fix.

### Fixed

**The test that exists to prevent this could not detect it.** `config-reach.test.ts` was written
after three instances of the same shape — a seam that exists, tests that pass, and no config field
to reach it. Its per-capability case built `{ [field]: undefined }` and asserted the object had
`field`: trivially true for any string, touching neither `KNOWN_CONFIG_KEYS` nor `loadConfig`,
while its comment claimed _"a config carrying it must survive `loadConfig`'s unknown-key refusal"_.

Removing a known key left every case green. The guard against this class had never worked, which is
why the class recurred a fourth time.

It now writes a real config module and loads it, with a control asserting an unknown key is still
refused. The mutation that used to survive — deleting a key from the known list — now fails.

## 0.2.0-next.30 — 2026-08-26

### Behaviour changes

**`aldus waive` no longer validates `--reason` ahead of the engine**, so an actor who may not
decide a gate is told _that_ rather than told to write a better reason.

`next.29` put the waiver rules in the engine so every caller inherits them, and then kept a copy of
the reason check in the CLI "so the operator finds out sooner". A check in front of the engine's is
not a friendlier copy of it — **it is a second rule, and it fires first.**

Measured by an adopter through the CLI, which is the only door anyone uses:

```
$ ALDUS_ACTOR=agent:… aldus waive <gate> --reason "" --run <run>
ALDUS_INVALID_REQUEST: "waive" needs --reason.        ← before
ALDUS_GATE_ACTOR_NOT_PERMITTED                        ← after
```

An `agent:` actor waiving a `human_oracle` gate learned it needed a better reason, when the truth
is that it may not decide that gate at all. The engine's ordering was correct and unreachable; the
argument for putting the rules there is the same argument against keeping a copy outside.

The rule itself is unchanged — a waiver still needs a reason, and a blank one is still refused with
`ALDUS_GATE_WAIVER_INVALID`. Only the place that refuses it has moved to the one that knows both
rules and the order they belong in.

## 0.2.0-next.29 — 2026-08-25

### Features

**`aldus waive <gate> --reason <why>`** — record that a check was **bypassed**, not passed.

`waived` has been a first-class decision since §13 was written: attributable, dated,
subject-binding, and voided when its subjects drift. It had no door. An operator who could not
honestly approve a gate had two shapes available — widen the gate's `permittedActorKinds`, or
approve something they did not judge — and both record a decision that misdescribes what happened.
The first adopter chose to be blocked rather than use either.

A separate verb rather than a flag on `approve`, because the approvals log is read by people
deciding whether to trust what came before.

**Two rules make it safe, and both are enforced in the engine rather than the CLI**, so every
caller inherits them:

**A waiver always expires when its subjects change, and a caller asking otherwise is refused.**
`expiresOnChange` is a legitimate per-decision override for an _approval_ whose subject cannot
drift. On a waiver it says the check stays bypassed whatever the content becomes — a disabled gate
reached through the decision API instead of the config file.

This is also what makes the rest safe. **Every gate is waivable, `release.public` included**, and
that is defensible _only_ because a waiver cannot outlive the content it was granted against. Leave
the override open and every gate needs a non-waivable declaration; close it and none does.

**A waiver needs a reason**, and a blank one is refused as the same absence wearing a string. The
one thing a reader of the log needs from a waiver is the part that would otherwise be missing.

Both refusals raise `ALDUS_GATE_WAIVER_INVALID`. `permittedActorKinds` is unchanged and still
checked on recording, so an agent still cannot waive a `human_oracle` gate.

## 0.2.0-next.28 — 2026-08-25

### Behaviour changes

**`aldus status` now says why a gate is stuck.**

The engine already composed the sentence. A gate binding a subject nothing has produced reports
`pending` — correctly, it _is_ pending — and the engine writes the line that distinguishes it from
"nobody has got to it yet":

> …has not been supplied: nothing has produced what the approval would bind.

That explanation, along with `missingSubjects` and `blockedBy`, never left the report: the gate row
printed only its id, state and class. An adopter hit an unproduced bound subject **three times in
one run** and read all three as a step not yet reached.

```
  caption.sync    pending  (blocking) — stops work
      Gate "caption.sync" has no recorded decision, and "subtitle/sync-report" has not been
      supplied: nothing has produced what the approval would bind.
      not supplied: subtitle/sync-report
  release.upload  blocked_upstream  (blocking) — stops work
      blocked by: caption.sync
```

Shown only for a gate that is neither satisfied nor waived. A satisfied gate explaining itself is
noise, and noise is how the line that matters stops being read.

The engine is unchanged, as it was for `next.27`. Both releases are the same defect one field
apart: the report carried what the operator needed and the renderer did not print it.

## 0.2.0-next.27 — 2026-08-25

### Behaviour changes

**`aldus status` no longer calls a satisfied blocking gate "advisory".**

A gate's **class** — `blocking` or `advisory` — and whether it is stopping work **right now** are
different facts, and the renderer derived both from the second one. So a blocking gate that was
satisfied printed `(advisory)`, which is false about its class and the opposite of what the gate
exists for. Measured by an adopter driving a real run: every passing gate in their repository was
reported advisory, and **not one of their twelve gates is advisory**.

The gates it misdescribed were exactly the ones that had already done their job, because being
satisfied is what makes the state fact false. The reward for a gate working was being described as
though it could not have worked.

`status` now prints the class from `enforcement`, and says separately when a gate is stopping work:

```
  script.freeze   satisfied  (blocking)
  outline.freeze  pending    (blocking) — stops work
  lint.report     pending    (advisory)
```

The engine is unchanged. `GateStatus.blocking` already meant "whether this state stops work", its
docstring already said so, and the row already carried `enforcement` — the renderer simply used one
field to answer both questions.

## 0.2.0-next.26 — 2026-08-25

### BREAKING — an exported schema now refuses a foreign major

**What starts throwing:** parsing a record whose `schemaVersion` has a **different major** than this
build implements, through an **exported schema object** — `artifactRefSchema.safeParse`,
`costRecordSchema.parse`, and the nine others. It previously returned success and handed you a value
this build cannot interpret.

`validateRecord` and `assertValidRecord` already refused such a record, so **which guarantee you got
depended on which door you came through** (ADR-0053). The exported object is the obvious door and it
carried no rule.

<!-- A semantic break: no export removed, no member newly required, so check-breaking-notes.mjs
     reports nothing to mark and this entry exists because a person wrote it. -->

**Migration.** If you relied on an exported schema accepting a foreign-major record, you relied on a
bypass — the value it returned could not be interpreted by this build. Where you genuinely need to
validate against a _different_ supported version, use `validateRecord(name, data, supported)`, which
takes it as a parameter, or the unguarded `*SchemaBase` exports the registry itself uses.

A newer **minor** still parses, deliberately. Refusing one would make every additive schema change
breaking for older readers, and `assertValidRecord` reports such a record as
`compatibility: "forward"`.

**Composition is unaffected.** `.shape`, `.extend`, `.pick` and `.safeExtend` all still work.

### A CHANGELOG defect, fixed here and disclosed rather than quietly repaired

**`0.2.0-next.22` and `0.2.0-next.23` published with no release notes at all, and `next.24`'s notes
sat under `Unreleased` after it shipped.** All three are restored in this release; `next.22`'s are
reconstructed from ADR-0051 and say so at the top of that section.

The mechanism was mine and it is worth naming, because it is the third instance of one failure.
`next.21` shipped eight undocumented breaking changes and an adopter found them by compiling. The
remedy then was to write the notes. What actually kept happening is that **each branch edited the
`## Unreleased` heading by text replacement, and branches that did not share history overwrote one
another's entries** — so the notes were written each time and silently lost on the way in. Writing
them more carefully would not have helped; only looking at the merged file does.

Nothing in CI catches it: `check-breaking-notes.mjs` only asks whether the _current_ version's
section documents the _current_ diff, so a previous release having no section at all passes.

### Features

**`@aldus-runtime/regression` record schemas now use Core's `schemaVersionString`** instead of a
private copy of the same regex — two definitions of one format that could drift, and the reason a
Core-side change would not have reached regression at all.

## 0.2.0-next.25 — 2026-08-25

**A free synthesis adapter could produce exactly one take per grant.** Measured by the first
adopter on a real rehearsal, and it made the free rehearsal path — the point of which is to
exercise production without spending — unusable past its first segment.

### Behaviour changes

**A synthesis adapter can declare that it incurs no charge.**
`SynthesisAdapterCapabilities.incursCharge: false` makes the expectation `{ kind: "free" }`, which
requires no grant and creates no reservation.

The synthesis path had only two arms — an estimate, or `unestimated` when none was present — so **a
genuinely free adapter was indistinguishable from a paid one nobody estimated**, and a grant
without `unestimatedExecution` refused it. That is the exact ambiguity `CostExpectation`'s closed
shape was introduced to remove, surviving in the one path where the free case is real.

Declared rather than inferred from a zero estimate: a zero estimate **predicts** that nothing will
be charged; this **states** that nothing can be. An adopter reduced to writing `estimatedCost: 0`
for a local engine noted the difference themselves, and this package already draws that line for
the unknown case — _"Zero is a numerical assertion; this is an uncertainty state."_

**A result reporting `incurredCharge: false` now settles as a free charge instead of going
unknown.** An adapter reporting no charge has _said what happened_; it simply has no cost record to
hand over. Reading that as "reported nothing about billing" left one unresolved charge of unknown
size standing against the grant, so remaining authorization became **indeterminate** and every
later segment was refused:

```
Remaining authorization on grant "…" is indeterminate: 1 unresolved charge(s)
of unknown size stand against it.
```

Settlement writes a `billingStatus: "free"` record with a zero amount — not an invented figure, the
adapter stated it — and `free` consumes no budget, so the reservation releases. This closes the
round trip: expressing `free` at plan time alone would have left the blockage in place for an
adapter that can only report after the fact.

**Silence is unchanged.** An adapter that says nothing at all about billing still leaves the
reservation unresolved and the grant indeterminate. That is uncertainty, not zero, and the arm
above exists to stop a _declaration_ arriving as silence.

This is the third instance of one rule reaching one entry point and not another: the spend service
already records that _"truthfully reported `billingStatus: \"free\"` was recorded as an
unauthorized charge"_, fixed there and not inherited here.

## 0.2.0-next.24 — 2026-08-25

### Features

**`ArtifactRef` gains an optional `producers` list** — what produced the bytes, alongside the
inputs provenance already pinned (ADR-0052). Each entry is `{ id, version, versionEvidence }`, all
opaque to Core.

Provenance recorded every input a stage read and nothing about what produced them beyond
`producerStageId`. So the same inputs through a later model, renderer or Worker binary yield
different bytes and no field distinguishes the two records — which for a `source` artifact is
unrecoverable, because those bytes cannot be regenerated and compared.

**It is a list because one execution can have several producers.** Measured by an adopter: an agent
CLI reports usage as a map keyed by model, and a delegating execution reports more than one. A
single producer would force a caller to pick, invisibly.

**`versionEvidence` distinguishes `"reported"` from `"requested"`**, because those are different
strings: `--model haiku` in, `claude-haiku-4-5-20251001` out. Recording the request as though it
were the executed version would be the same failure the field exists to fix, one level down.

**`producerProvenanceGap(artifact)`** reports the absence and separates a `source` artifact, where
the gap cannot be recovered, from a `reproducible` one, where it can be closed by regenerating. An
optional field nobody fills is decoration; this makes the hole queryable.

Optional and non-empty when present, so no stored record becomes invalid and an empty list cannot
assert that nothing produced the bytes. `SCHEMA_VERSION` **1.12 → 1.13** (MINOR, ADR-0003).

Not on `CostRecord`: a free execution writes no cost record, so an artifact produced by a free run
would have no producer identity — and a `source` artifact is exactly as irreproducible whether or
not anyone was billed.

## 0.2.0-next.23 — 2026-08-25

### Documentation on the money path

No behaviour changes. Three semantics that were already true of the shipped runtime and that
nothing said out loud, all from the first adopter migration through `#155` and ADR-0044.

What makes them worth a release note is the shape of getting them wrong. **The natural misuse of
each one compiles cleanly and then refuses or overspends at runtime** — a wrong `effectKey` grain
type-checks and is refused only after the first effect has been paid for; an unset `maxPerRequest`
type-checks and refuses every unestimated dispatch; a `maxTotal` sized as a lifetime pool
type-checks and simply provisions the wrong amount. Nothing before runtime says so, which is worse
than a change that fails to compile.

**`effectKey`: one attempt is not necessarily one effect.** A stage dispatching twice within a
single attempt — a writer and then a reviewer, a segment loop — has two independently billed
effects, and keying both on the attempt gives them one key. The second reserve is refused at
runtime, correctly, _after the first has been paid for_: a stage dying mid-attempt having spent
money. Derive the key from what makes an effect the same effect if repeated, and distinguish
effects within an attempt — `${attemptId}:${purpose}`, not `attemptId`. The dispatcher's identity
and version are prepended by the runtime; adding them yourself double-versions the key and defeats
the idempotency it exists for.

**`maxPerRequest` changed meaning without changing type.** It was a statement about what a
_backend_ enforces, so leaving it unset where the backend enforced nothing was the honest choice.
Under ADR-0044 it is what the _runtime reserves_. Still optional, still compiles, and under
`unestimatedExecution: "reserve_max_per_request"` an unset ceiling makes every unestimated dispatch
refuse.

**`maxTotal` is consumed by two different things**, and reading it as one mis-sizes a grant in
either direction. Settled charges consume it permanently at their actual amount; active and
unresolved reservations consume it at their _reserved_ amount until they settle, at which point
unused headroom returns. So `maxTotal ÷ maxPerRequest` bounds how many unestimated dispatches can
be **outstanding at once**, not how many a run may make — nine dispatches settling cheaply against
a $25 / $3 grant leave $23.20 available. Read as a lifetime pool it ignores that eight worst-case
reservations can be outstanding before any settles; read as a concurrency bound alone it
over-provisions a run whose charges are small.

`packages/aldus-gate-engine/test/settlement-headroom.test.ts` holds that behaviour to the protocol,
so the prose fails when it drifts again.

## 0.2.0-next.22 — 2026-08-25

> **These notes were reconstructed from ADR-0051 after the release.** The originals were lost in
> the CHANGELOG defect described under `0.2.0-next.25`; the ADR is authoritative and this is a
> faithful summary of it, not a recovered copy.

### Features

**`@aldus-runtime/regression` record schemas gain an optional `metadata: Record<string, unknown>`**
on both `DefectCorpus` and `EvaluatorRun` (ADR-0051). Core never interprets it.

`0.2.0-next.21` made both schemas strict, which was right for the case it was aimed at — a record
from a later runtime parsing while its added fields are silently discarded — and wrong for the case
it also caught: **adopter-owned data**, which the first adopter to bump was carrying deliberately
and documenting as stripped.

Strictness stays. The two cases are separated: an **undeclared** key is still refused, because it
may be a later runtime's field; a **declared** extension point is preserved through the parse. That
is better than what it replaces — a sibling key survived only because readers went around the
parser to the raw JSON, and `metadata` is readable through it.

Migrating from a sibling key: move it under `metadata`, then read it through the parser instead of
the raw file. Additive and optional, so `SCHEMA_VERSION` moved **1.11 → 1.12** (MINOR, ADR-0003).

## 0.2.0-next.21 — 2026-08-25

Published from `main` (ADR-0050). **These notes were written after the fact**: the release shipped
describing only the `@aldus-runtime/regression` change below, and an adopter pinned exactly found
the rest by compiling. That is precisely the failure this file's own preamble names, so the whole
surface is recorded here rather than the part that was remembered.

`SCHEMA_VERSION` moved **1.8 → 1.11** across the versions this release collapses — three MINOR
bumps, additive only (ADR-0003). No record shape you already hold becomes invalid.

### BREAKING — signatures on the paid-spend and agent-execution path

This release lands `#155`'s reservation and settlement protocol, ADR-0044's `CostExpectation`, and
ADR-0045 through ADR-0047. Six required fields appeared, all on the money path. Every one exists so
that an omission cannot read as a permission.

| what changed                                                           | where                         | migration                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AgentBackend` requires `version`                                      | `@aldus-runtime/stage-runner` | Name the backend's version. A reservation records **which version was dispatched under an enforced ceiling**, and that evidence cannot be reconstructed by re-reading today's capabilities.                               |
| `grantLimitsDigest` removed                                            | `@aldus-runtime/gate-engine`  | Use `grantTermsDigest`. Renamed because scope is now a term: widening a grant from agent-only to TTS-capable changes what an approval permits exactly as raising a ceiling does.                                          |
| `SpendGrant` requires `scope: { operations }`                          | `@aldus-runtime/gate-engine`  | List the operations the grant authorizes. **Adopter-defined open strings** — Core names none. Digest-bound and sorted, so adding one invalidates the approval.                                                            |
| `AgentExecutionOptions` requires `spend`                               | `@aldus-runtime/services`     | Supply the `SpendService`. Without it an execution cannot reserve, and previously it dispatched anyway.                                                                                                                   |
| `AgentExecutionInput` requires `operation`, `expectation`, `effectKey` | `@aldus-runtime/services`     | See the three notes below.                                                                                                                                                                                                |
| `StageWorkerRequest` requires `spend: DispatchSpendDeclaration`        | `@aldus-runtime/stage-runner` | The stage states what it is asking for — and **not** `grantId`, `authorizationId`, or attribution, which the composed Runtime resolves. A caller that names its own authorization can name one that did not authorize it. |

<!-- Machine-readable coverage for check-breaking-notes.mjs. Comments, so they do not render. -->
<!-- breaking: aldus-stage-runner:AgentBackend.version -->
<!-- breaking: aldus-gate-engine:grantLimitsDigest -->
<!-- breaking: aldus-gate-engine:SpendGrant.scope -->
<!-- breaking: aldus-services:AgentExecutionOptions.spend -->
<!-- breaking: aldus-services:AgentExecutionInput.operation -->
<!-- breaking: aldus-services:AgentExecutionInput.expectation -->
<!-- breaking: aldus-services:AgentExecutionInput.effectKey -->
<!-- breaking: aldus-stage-runner:StageWorkerRequest.spend -->

**`expectation` replaced `estimated?: Money`.** Absence used to mean both _"nobody stated one"_ and
_"nothing will be charged"_, so an unestimated effect was dispatched **with no spend check at all**
and the two readings were indistinguishable from outside. Three arms: `{ kind: "free" }` (no grant,
no reservation), `{ kind: "estimated", amount }` (grant required, estimate reserved), and
`{ kind: "unestimated" }` (grant required, **and its policy must permit it**). Declaring `free` is
now a statement someone makes rather than a field they omitted.

**`unestimatedExecution` on the grant is what permits the third arm**, and **absent reads as
`"refuse"`**. An existing grant refuses every unestimated dispatch until someone sets
`"reserve_max_per_request"` and a meaningful `maxPerRequest`. It lives on the grant, not on an
execution input, because a caller that could assert its own permission is the shape `#107` exists
to prevent — and it is digest-bound, so changing it invalidates the approval.

**`effectKey` identifies the independently billed effect (`#154`, ADR-0043).** Retrying the same
effect resolves to the **same** reservation rather than reserving twice, which is what makes
`reserve` idempotent. You supply `billingEffectKey`; the runtime namespaces it by dispatcher
identity and version. Derive it from what makes an effect _the same effect if repeated_ — never
from a timestamp or a fresh id, which reserves twice for one charge. The same key under different
terms is refused rather than silently re-reserved.

### Behaviour changes

**`@aldus-runtime/regression` refuses a corpus or evaluator run declaring a schema version newer
than the runtime implements.** `parseDefectCorpus` and `parseEvaluatorRun` previously validated
`schemaVersion` for _shape_ only — any `MAJOR.MINOR` string was accepted, a future release's
included. A shape check with no value check is worse than none: the field looks validated and
guarantees nothing. The refusal is `ALDUS_SCHEMA_VERSION_UNSUPPORTED`.

**Both record schemas are strict: an unknown key is refused rather than stripped.** Previously a
record from a later runtime parsed and its added fields were silently discarded, so the caller
received an object that looked complete and was not. Records carrying extra keys now throw
`ALDUS_CORPUS_MALFORMED`. **If you hold committed corpora with extra keys, they will refuse at this
bump** — cheap to grep for, expensive to discover during a paid run.

An **older** record still parses. A record has to be readable in order to be upgraded, so a parser
that refused everything it did not stamp would make a corpus unable to outlive a release — the
property the version field exists for. Whether an older run is _comparable_ is policy and stays
with the caller.

### Features

**`compareSchemaVersion(recordVersion)`** returns `"older" | "same" | "newer"` against
`REGRESSION_SCHEMA_VERSION`, and can be asked before parsing. Minor compares numerically, so `1.10`
is newer than `1.9`.

The decisions behind the spend work are ADR-0044 (spend is reserved before the effect), ADR-0045
(authority originates at a boundary), ADR-0046 (a Worker is a paid gateway) and ADR-0047 (a Stage
dispatches an agent explicitly).

## 0.2.0-next.0 — 2026-08-18

A prerelease on the `next` dist-tag only. `latest` still points at `0.1.0` and moves only by a
deliberate owner decision (ADR-0023, `docs/RELEASING.md`).

**Every behaviour change below came from the first real adopter integration**, which found them by
using the runtime rather than by reading it. The gate-enforcement fix is the one to read first: it
closes a hole where `status` said a stage was blocked and `run` executed it anyway.

### Behaviour changes

**`aldus run` now refuses a stage whose declared gate is unsatisfied** ([#45]). Previously
`aldus status` reported such a stage as blocked and `aldus run` executed it anyway, side effects
included. §11 requires a stage to stop at required gates; recording `waiting_for_gate` afterwards
is not stopping.

_What you will see:_ a stage declaring `requiredGates` that currently runs regardless will now be
refused, with exit code 1 and the same explanation `status` already prints. **On first upgrade a
workflow whose gates are unsatisfied early by design — a synthesis stage gated on a performance
freeze, a release stage gated on its upload gate — will present as a wall of refusals.** That is
the fix working, not a regression, but it is worth telling operators before they meet it.

_A modelling error this will surface:_ **if a stage is gated on approval of something it
produces, that used to work and now deadlocks.** The gate cannot be decided until the artifact
exists; the artifact does not exist until the stage runs. Previously `status` reported the stage
blocked and `run` executed it anyway, papering over the mistake. A gate approving a stage's output
belongs on the stage that _consumes_ it. The first adopter found three of these in their own
workflows within an hour of looking.

_What has not changed:_ a stage that declares nothing keeps running as it did. Enforcement
applies only to gates a stage actually declares. `status` output is byte-identical apart from a
new `enforcement` field, so anything parsing it keeps working.

**`aldus retry` obeys the same rule** ([#45]). It previously offered and performed a retry for a
retryable failed stage regardless of gates.

**A config module exporting an unrecognised key now fails at startup** ([#46]). Previously the
key was silently dropped, which is how a config supplying a workflow graph appeared to be
ignored — the symptom surfaced as a wrong next action, two layers from the cause. Unknown keys
are now refused by name, listing the recognised ones. A config using only documented keys is
unaffected.

**`aldus init` refuses Episode flags without `--show`** ([#46]). Previously it created the
workspace, silently created no Episode, and printed success output differing only by an absent
line.

**Run status is now derived rather than stored** ([#47]). `RunManifest.status` was written once
at creation and never again, so four of five §6.2 states were unreachable and the field the
`status` and `inspect` commands print first was permanently stale.

_What you will see:_ anything reading `RunManifest.status` and expecting `"created"` changes
behaviour. A Run resting between stages now reports `running` — §6.2 has no idle state, and §5.1
makes long pauses ordinary, so "in progress" cannot mean "a process is executing right now".

_What has not changed:_ `RunReport.run` is still the faithful stored manifest. The derived answer
lives on `RunReport.state`, deliberately, so nothing can round-trip a derived status back into
storage.

_Schema:_ `SCHEMA_VERSION` moves 1.2 → 1.3 — additive, MINOR under ADR-0003. Records written by
1.2 stay readable and need no migration.

**A config module now sees the workspace the command acts on** ([#54]). `--workspace` was parsed
after the config was loaded, so a config could observe only `ALDUS_WORKSPACE` and the cwd. One
deriving anything from the workspace therefore configured a _different_ workspace than the
command acted on, and the failure surfaced as `ALDUS_STAGE_NOT_REGISTERED` — an error pointing at
a stage list that was correct and complete.

_What you will see:_ a config that reads `process.env.ALDUS_WORKSPACE` now sees the `--workspace`
value, where before it saw the shell's. That is the fix, and it changes what such a config
observes. `--workspace` may also now be written before the subcommand.

_What has not changed:_ a config exported as a plain object, and one that derives nothing from
the workspace, behave exactly as before.

### Added

- **A refused stage says when its gate cannot yet be decided** ([#57]) — a gate with no subjects
  supplied is not merely undecided but undecidable, and "decide the gate" is advice an operator
  cannot act on. Where the refused stage is what produces those subjects, it is advice they can
  never act on. Reported only when the subjects provider is genuinely empty for that gate.
- **`AldusConfig.workflow`** ([#46]) — a workflow graph is now reachable from the CLI, so the
  stage↔gate association of ADR-0021 can actually be used from the binary.
- **A config module may export a function** ([#54]) — `export default ({ workspace }) => ({ … })`,
  given the resolved invocation. The object form is unchanged. `ConfigContext` is an object so
  the resolved actor and `--json` can join it later without breaking existing modules.
- **`ALDUS_NO_STAGES_CONFIGURED`** ([#54]) — raised when _nothing_ is registered, rather than
  reporting it as a missing stage. An empty registry is a configuration problem; a missing stage
  is a typo. Errors whose usual cause is the wrong workspace now name the workspace and config in
  effect.
- **`RunManifest.goalStages`** ([#47]) — the stages a Run intends to reach. `completed` derives
  from these rather than from "every stage in the graph", because optionality is a property of an
  episode's edition and not of the stage. **A workflow with conditional stages should set this
  explicitly:** the graph carries no edges, so the default is every stage it names, which will
  leave such a Run permanently incomplete.
- **`aldus cancel --run <id> [--reason]`** ([#47]) — a Run can be abandoned, with a recorded actor
  and an emitted event. Cancellation cannot be derived: an abandoned Run and one someone is still
  thinking about look identical in a log.
- **`StageContext.registerOutput`** ([#39]) — a stage registers an artifact by supplying only what
  it knows; the runner fills `producerRunId`, `producerStageId`, `codeRevision`, `configHash` and
  the digest. A stage cannot claim provenance that disagrees with its own attempt, because the
  registration type has no field to write it in. Purely additive — closing over a registry keeps
  working.

### Fixed

- The release workflow was unparseable to GitHub after a duplicate `inputs:` key, which made it
  fire a failing run on every push to every branch ([#50]). CI now validates workflow files.

[#45]: https://github.com/jamchen/aldus/issues/45
[#46]: https://github.com/jamchen/aldus/issues/46
[#47]: https://github.com/jamchen/aldus/issues/47
[#39]: https://github.com/jamchen/aldus/issues/39
[#57]: https://github.com/jamchen/aldus/issues/57
[#50]: https://github.com/jamchen/aldus/pull/50
[#54]: https://github.com/jamchen/aldus/issues/54

## 0.1.0 — 2026-08-18

Bootstrap public preview. Twelve packages published to npm under `@aldus-runtime`.

**Not validated by a real adopter at the time of release.** See
[`docs/releases/0.1.0.md`](docs/releases/0.1.0.md) for the full release report, integrity table,
and source commit.

Both `latest` and `next` point at `0.1.0`. That was not intended — npm assigns `latest` on a
package's first publish regardless of `--tag` — and is documented as a bootstrap exception in
ADR-0023. Later unvalidated releases use prerelease versions instead, which npm will not move
`latest` to.
