# Changelog

Every published version, and what changes for someone already using the previous one.

Aldus versions in lockstep: all `@aldus-runtime/*` packages share a version (ADR-0020). Entries
below apply to the whole set unless a package is named.

**Behaviour changes are listed before features.** An adopter should learn that something they
rely on now behaves differently by reading this file, not by watching a test go red.

## Unreleased

Nothing yet.

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
