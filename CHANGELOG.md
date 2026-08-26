# Changelog

Every published version, and what changes for someone already using the previous one.

Aldus versions in lockstep: all `@aldus-runtime/*` packages share a version (ADR-0020). Entries
below apply to the whole set unless a package is named.

**Behaviour changes are listed before features.** An adopter should learn that something they
rely on now behaves differently by reading this file, not by watching a test go red.

## Unreleased

Nothing yet.

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
