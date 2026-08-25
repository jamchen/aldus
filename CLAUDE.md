# Aldus — working agreement

## The contract

`docs/ALDUS-ARCHITECTURE.md` is the architecture contract. Read it before changing anything in
`packages/`. Normative terms (MUST / SHOULD / MAY) are used deliberately there.

`docs/adr/` records decisions the contract leaves open. If you need to decide something the
contract does not settle, choose the **smallest reversible option**, record the assumption, and
write an ADR if the choice shapes a public API.

## The boundary — the rule that matters most

Aldus Core is a **generic** production runtime. Contract §4.2 lists what Core does not own.
Concretely, nothing under `packages/` may contain:

- a show name, host persona, company, brand, or adopter identity;
- a TTS provider, voice ID, or model name (`elevenlabs`, `openai`, …);
- a publishing platform (`youtube`, `spotify`, `rss`, …);
- a cloud or storage service (`gcs`, `s3`, `firestore`, `drive`, …);
- an adopter-specific filename, path, or Markdown convention.

Provider- and platform-shaped concepts are represented as **opaque strings supplied by the
caller** (`provider: string`, `destination: string`, `kind: string`), never as enumerations
Core defines. Contract §4.3: the dependency direction is `Adopter Integration → Aldus public
contracts`, never the reverse.

Test fixtures use obviously fictional placeholders (`example-show`, `example-host`,
`provider-a`, `destination-a`). Private Knowledge Packs MUST never be required by Core tests
(§19.2).

**An adopter's identity does not belong in `docs/` either.** Provider and platform names appear in
`docs/` deliberately — §4.2 quotes "YouTube channel IDs" to state its own rule — but a specific
adopter's repository, product or company has no place in the record any more than in the runtime.
Where an adopter's case is the evidence, "the first adopter" carries the same substance.

`scripts/check-generic-boundary.mjs` enforces both, with the list in one place and a per-category
scope: provider/platform/cloud in `packages/`, adopter identity in `packages/` **and** `docs/`. CI
runs it and `packages/aldus-e2e/test/boundary.test.ts` runs the same script, so the local check and
the CI check cannot disagree.

The check it replaced was named "Reject adopter-specific names", said in its comment that it covered
adopter identity, contained none, and scanned `packages/` only — so two files reached `main` naming
an adopter, one of them in `docs/` (#173). A claim about a boundary has to be enforceable rather
than asserted, and a neutrality rule enforced by attention fails on the busiest day.

## Layout

```
packages/aldus-core/      @aldus-runtime/core     domain types, schemas, validation, IDs, redaction
packages/aldus-testkit/   @aldus-runtime/testkit  deterministic builders, fixtures, test doubles
docs/adr/                                 architecture decision records
```

Package placement rationale: ADR-0001.

## Commands

```bash
npm install
npm run verify           # format:check + build + schema:check + test — run before every commit
npm run build            # tsc -b across the workspace
npm test                 # vitest in every package
npm run schema:generate  # regenerate packages/aldus-core/schema/*.schema.json
npm run schema:check     # fail if committed JSON Schema is stale
npm run format           # prettier --write
```

## The contract is executable

`packages/aldus-core/test/contract-conformance.test.ts` parses the TypeScript declarations out
of `docs/ALDUS-ARCHITECTURE.md` and checks the implemented schemas against them: every declared
field present, optionality preserved, and no unlisted additions.

So a schema change that departs from the contract fails CI. If the departure is intended, add
it to `SANCTIONED_ADDITIONS` in that test **and** justify it in an ADR or the work-package
issue. If the contract itself changed, the test starts failing until the schema follows.

## Schemas

Zod definitions in `packages/aldus-core/src/schema/` are the single source of truth. TypeScript
types are inferred from them; JSON Schema files in `packages/aldus-core/schema/` are generated
and committed. **After changing any Zod schema, run `npm run schema:generate` and commit the
result** — CI fails on drift. Rationale: ADR-0002.

Schema version is a single package-wide `SCHEMA_VERSION` (`MAJOR.MINOR`). Adding an optional
field is a MINOR bump; anything else is MAJOR. Rationale: ADR-0003.

## Security invariants

- Validation errors carry the failing **path and issue code only, never the received value**
  (§19.2). If you add an error path, keep it value-free.
- Anything that could reach a log goes through `redact()` first.
- Secrets are referenced, never embedded in manifests, errors, or fixtures.

## Review protocol

Agreed with the owner and the architecture coordinator on 2026-08-21. Recorded here because the
cross-session channel does not survive a restart and this does.

**What a review pass is.** The coordinator does not re-run suites CI has already run — a green
suite re-run produces no information. What produces findings is the other half: mutants, and
sequences nobody wrote. Every real finding in the #165–#171 series came from one of those — a
two-pass test where the first pass wrote a terminal receipt, a retry after a durable cost write,
reverting a rule to see whether four composed tests were load-bearing. Make those two things cheap
to reproduce and the round-trip shrinks on both sides.

**Batch or ping, by the same content line the owner uses for authorizations.** Batch anything whose
failure a follow-up commit can repair: two or three changes, then one review request. Ping
immediately and singly for anything touching publish, an irreversible external effect, or a
contract an adopter pins exactly.

**Every review request carries an evidence block**, so a reviewer starts at the reasoning rather
than parsing prose for it:

```
head:      <sha>
suites:    <package: count, …>  (in one tree, not the union of separate passes)
mutants:   <a runnable command per mutant, not a description>
claims:    <each claim, and what would invalidate it>
does not:  <what this change does NOT establish>
```

The last two are the load-bearing ones.

**The evidence block is emitted, not transcribed.** `node scripts/evidence.mjs --suites` measures
the head sha, every check with its real exit, and the suite counts, and prints the block. `claims:`
and `does not:` stay human — what a claim rests on and what a change fails to establish are
judgements, and a tool emitting them would invent the part worth reading.

The reason is a controlled experiment nobody designed. PR #176 carried two claims in the same hour
by the same author: the mutant table, produced by `run-mutants.mjs`, correct at 14/14; and a
`docs-only` claim, hand-copied, false twice — wrong path, and the run that "confirmed" it had
refused as vacuous. The machine-produced claim was right and the transcribed one was wrong, so the
transcription step is the defect.

**A mutation must reach the code under test.** `run-mutants.mjs` rebuilds before measuring whenever
a case's setup edited `packages/*/src`, derived from the setup paths rather than declared per case,
because a flag that must be remembered is what this file exists to replace.

Without it the mutation never arrives: `@aldus-runtime/core` resolves through package `exports` to
`dist`, so an importer sees the last build. Measured — `src` set to `99.99`, a sibling still
resolving `1.11`. A case that edited a built source and measured through another package would
report **SURVIVED for a mutation that never took effect**, which is the worst form of the
non-answer: the dirty worktree and the vacuous diff both _refused_, and this one answers, wrongly.

**A check has three states, and `DECLINED` is never folded into either other.** The costliest
failure across this whole series was **a non-answer read as an answer** — `MODULE_NOT_FOUND` as a
meaningful exit code, a dirty-worktree refusal read as a preflight pass, uniform failures read as
four disagreements, and a vacuous-diff refusal read as a claim holding. In none of them was the
object or the venue wrong: the instrument declined to answer and the answer was recorded anyway.

Better wording does not fix it, and that was checked rather than assumed: the refusal printed
`refusing to pass vacuously` on stderr with exit 2, against `holds across N changed paths` on stdout
with exit 0. The tool was unmistakable; the reading was not. So `evidence.mjs` exits non-zero when
any check declined, and says that a declined check is neither a pass nor a failure.

**Mutants assert their own results.** `scripts/mutants.mjs` holds the cases as data — reviewable in
the diff — and `node scripts/run-mutants.mjs` runs them and compares. The `mutants:` line of an
evidence block is that one command.

Not shell one-liners for a reviewer to re-run, because two shells produced **four** invalid
measurements in one day and none was carelessness about the checks:

| what went wrong                                      | why it looked like a result                                        |
| ---------------------------------------------------- | ------------------------------------------------------------------ |
| probed with uncommitted edits                        | `git diff base...HEAD` reads the committed tree, so nothing fired  |
| `git reset --hard` deleted an uncommitted instrument | later cases exited on `MODULE_NOT_FOUND`                           |
| `node scripts/$cmd` in zsh                           | no word-splitting, so every case invoked one filename with a space |
| piped to `head` and read `head`'s status             | the pipeline's exit, not the command's                             |

So the runner has three properties, each the fix for one of those encoded rather than remembered:
it **refuses a dirty worktree**, because every case commits and resets; it **preflights every
script a case names**, because a missing file exits exactly like a real negative; and every case
asserts an **output fragment**, not only a status, because a status cannot tell a finding from a
typo. Both invalid runs failed through `MODULE_NOT_FOUND` read as meaningful — assert on output
wherever a check can afford to.

### Four ways a check misleads, by remedy

One day produced enough instances to catalogue rather than remember. The categories are
distinguished by **what was wrong**, because the remedies differ.

Not a complete set — it is what one day produced, and the fifth arrived within an hour of the first
four being written down, which is why the caveat is kept rather than softened:

| what was wrong                                                           | remedy                                       |
| ------------------------------------------------------------------------ | -------------------------------------------- |
| the description drifted from the mechanism                               | **read the mechanism**                       |
| the measurement was taken where the code will never run                  | **run it where it runs**                     |
| the instrument declined to answer and the non-answer was recorded as one | **make that impossible to record**           |
| an answer was given and pointed adjacent to the cause                    | **treat a diagnostic's location as a hint**  |
| the premise came from a report and was never checked in the code         | **check the premise where the mechanism is** |

**1. Description drifted from mechanism.** `absenceIsReadable` equivalent to `true`;
"test-harness-only" said of a symbol exported from a package index; "all genuinely clean"
trial-merged against the wrong base; a CI step named `Reject adopter-specific names` whose regex
held no adopter name. In every one the description was checked and the mechanism was not — a name, a
comment and a claim are all easier to read than the code under them, and they are read first.

Two habits catch most of it. Before describing a change's blast radius — _test-only_, _docs-only_,
_additive_ — check the **export surface**, not the file path. Before claiming a measurement, ask
what was measured, with what, and whether it answers the question the claim is about.

**2. Measured where the code will never run.** The clean-consumer gate and exact internal pins are
both this rule: a workspace link resolves what a tarball cannot, and a range is a promise about a
package nobody tested. The instance that broke `main` was a release check verified against a full
local clone when CI checks out shallow — the local run passed and could not have failed. A friendlier
environment does not disprove a fault, and passing in one is not evidence about the other. Where the
real environment cannot be reproduced, say so in the claim; the `does not:` line is where that goes.

**3. A non-answer recorded as an answer.** The costliest of the four. `MODULE_NOT_FOUND` read as a
meaningful exit code; a dirty-worktree refusal read as a preflight pass; uniform failures read as
four disagreements; a vacuous-diff refusal read as a claim holding; a parse failure read as a check
firing. In none of them was the object or the venue wrong.

Better wording does not fix it — checked, not assumed: one refusal printed `refusing to pass
vacuously` on stderr with exit 2 against `holds across N changed paths` on stdout with exit 0. The
tool was unmistakable; the reading was not. So: `DECLINED` is a state, never folded into pass or
fail; assert on **output**, not status, since a missing file and a real negative share an exit code;
**a guard is only tested when its result comes from the mechanism under test** — two guards were once
confirmed by a third; and **a filter narrow enough to be useful is narrow enough to hide a
refusal**, so read what a tool emits rather than an extraction of it.

**4. An answer pointing adjacent to the cause.** A glob containing a star followed by a slash closes
a block comment, and the parse error named the line _after_ the offending one — so the first repair
fixed the wrong line and the error persisted unchanged. The general form: a diagnostic's location is
where the **detector** stood, not where the fault is.

**5. A premise inherited from a report.** Distinct from the first, not an instance of it. There the
description had drifted from a mechanism it once matched; here the premise was never a description of
the code at all — it is someone's account of it, arriving in prose.

Why it escapes checking is social rather than technical. **A premise arriving in a report gets
checked less than one arriving in code, because reading a report does not feel like reading a claim
— it feels like being told a fact by someone who did the work.** Three instances in one day, one per
party:

- _"`release.public` binds a `release/receipt` artifact"_, inherited from an adopter report, and
  three routes derived from it — two existing only because of it, one nearly a MAJOR schema break.
  `GateSubject`'s docstring settles it in two lines and was never opened;
- _"the one real render predates the registration fix"_, inherited and carried into a ruling as a
  negative worth keeping. Wrong run, wrong reason, two `ls` commands away;
- _"a pin bump re-runs every measurement"_, inherited and carried to the **owner** as a decision they
  needed to make. It was four measurements, computable from a classification already in the
  reporter's own registry.

The remedy is cheap: **when a report supplies a premise your work will rest on, check the premise in
the code rather than in the report.** A report is evidence that someone believes it, which is worth
having and is not the same thing.

And when a report's framing turns out false, **check whether your own documentation planted it — and
accept the answer if it did not.** "Our docs misled them" flatters everyone, so it is the finding to
distrust. Here §13.4 names _"the final render, captions, metadata, destination, and visibility
policy"_ — things, not artifacts — and `GateSubject` documents itself accurately, so the framing came
from the reader and there was nothing to fix.

**This entry has a mechanism, and it is a weaker kind than the other four.** An earlier version of
this section said it could not have one, on the grounds that there is no grep for "this premise
arrived in prose". That aimed at the wrong target: the failure is not that the premise is prose, it
is that **the omission is invisible** — nothing distinguishes "I opened the file" from "the report
said so". The move for invisibility is a required field, not a detector.

So `evidence.mjs` requires **`verified at:`** on every claim. Three honest answers and no fourth: a
`file:line`, which requires opening the code, and opening the code _is_ the remedy; `report: <who
said it>`, which makes the inheritance visible — all three instances above would have been caught by
seeing that line written under a claim the work rested on; or a visible hole.

And the sharper half: **a claim whose verification reduces to a command does not belong in `claims:`
at all** — it belongs in `checks:`, where the emitter runs it and prints the exit. What is left in
`claims:` after that move is the genuinely judgement-based residue, and none of the three above was
in it. Two `ls` commands and a two-line docstring are not judgement.

`node scripts/evidence.mjs --check <file>` validates a **filled** block, because a required field
nothing checks restores the invisibility it was added to remove and becomes decoration — worse than
absent, since it looks like coverage. It **refuses** structural absence: a residual `<FILL`, a claim
with no `verified at:`, a claim with no `invalidated by:`. It **surfaces without refusing** the
claims whose locus is a report, because a report can be a legitimate locus and a reviewer should
still be told how many rest there.

**What it does not do, stated because a validator implying otherwise would be the first category
inside the tool built for the fifth:** it catches a missing or placeholder field, never a false one.
`verified at: yes` passes. It checks that the question was answered, not that the answer is true.

A fourth honest answer, better than the three originally specified: **say why a hole is
irreducible.** `report: … — NOT independently checked, because it is a counterfactual about past
claims and cannot be` tells a reader the difference between _nobody checked_ and _nobody can_, which
neither a `file:line` nor a bare `report:` conveys.

The difference from the other four is real and worth keeping: they **refuse** outright, and this one
refuses only the structural half and makes the substantive half visible. A weak mechanism labelled
as weak is worth more here than conceding the category to habit.

**A case is a claim too.** Two mutant cases were written on premises that were never checked — a
forty-zero base ref assumed to make a check decline, and an appended export assumed visible to an
importer. Both read as failures of the thing under test. `invalidated by:` applies to cases, not
only to findings.

**And an instrument is only ever checked by its holder**, so the check has to be habitual rather
than triggered by suspicion. An invalid measurement that agrees with a plausible worry is the
hardest to discard, because discarding it feels like refusing evidence. Establish the instrument is
sound before believing what it says, and commit it before probing it.

### A claim about another repository is not checkable from here

`check-generic-boundary.mjs` catches an adopter's identity entering our record. It cannot catch the
opposite direction across the same line: a claim _about_ the adopter's repository asserted here
without being read there. Both happened in one day — a `git grep` result recorded as ADR evidence
that named the adopter, and a file attributed to this repository that exists in neither, whose
supposed contents came from a chat message rather than any artifact.

There is no grep for the second. What there is: **attribute a cross-repository claim to where it was
read, or do not make it.** "A search across the first adopter's integration finds neither export" is
checkable by whoever has that repository. A header attributed to a file that is not there is
checkable by nobody.

**Checks that replace something a reviewer did by hand:**

| script                         | the claim it verifies                                                                         |
| ------------------------------ | --------------------------------------------------------------------------------------------- |
| `check-generic-boundary.mjs`   | no provider/platform/cloud name in `packages/`, no adopter identity in `packages/` or `docs/` |
| `check-version-bump.mjs`       | a PR changing `files`-scoped contents bumps the version                                       |
| `check-resolution-surface.mjs` | a merge's diff is a subset of the union of its parents' diffs                                 |
| `check-claim-scope.mjs`        | `docs-only` / `no-shipped-change` is true rather than asserted                                |
| `check-build-topology.mjs`     | every package compiles `src` to `dist`, which the rebuild predicate assumes                   |
| `check-breaking-notes.mjs`     | a breaking change to the built export surface carries a `BREAKING` CHANGELOG entry            |
| `evidence.mjs`                 | emits the review block, measured; `--check` validates a filled one                            |
| `run-mutants.mjs`              | runs the cases in `mutants.mjs` and asserts each one's own result                             |

`check-breaking-notes.mjs` compares **built `.d.ts` against built `.d.ts`**, never source, because a
blast radius is a question about the export surface. It finds a removed export and a newly required
member; it does **not** find a semantic break. The two most dangerous changes in the release it was
built for — `effectKey` namespacing and `unestimatedExecution` defaulting to refuse — compile
cleanly and behave wrongly, and are invisible to it.

It exists because of who could otherwise catch such a change. `0.2.0-next.21` shipped eight breaking
signature changes with notes describing one. The adopter asked in advance and in writing what the
release contained, got no answer in time, bumped on a summary, and found the rest by compiling.
**Three humans in the loop failed to surface it and the compiler was the only mechanism that did** —
and a pinned adopter is, by construction, the last party to know and has no way to volunteer the
information. A detection that only the last party can perform has to move to the other side of the
line.

Its own first run produced two false positives, both fixed and both recorded in the source: a
one-line `type` alias whose body was taken from the _following_ declaration, and Zod-inferred types
where optionality lives in `z.ZodOptional<…>` rather than in a `?`, so every optional schema field
read as newly required. Validated against the release it was built for — eight findings, zero false
positives, and it passes on the same surface once the notes exist.

`check-resolution-surface.mjs` does **not** establish that a resolution chose correctly — keeping
one caller's shape and dropping the other's argument is a correct-surface, wrong-content failure,
and no diff comparison catches it.

**A coordinator sits upstream, so its errors are amplified rather than filtered.** Three times in
one day a coordinator's error propagated into implementation before being caught: a trial-merge
result relayed forward as fact, a ruling written against an unpublished arm, and a two-Environment
split that assumed a mechanism `allow-latest-move` does not have. All three were caught downstream,
by reading the mechanism. **When a ruling asserts a mechanism, check the mechanism before building
on it.** The review direction that matters most is implementation over coordination, not the reverse.

## Style

- ESM only, `NodeNext` resolution, explicit `.js` extensions on relative imports.
- `strict` plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` — respect them
  rather than casting around them. No `any`; use `unknown` and narrow.
- Every exported symbol carries a TSDoc comment that names the contract section it implements.
- Tests are colocated per package under `test/`, named `<unit>.test.ts`.

## Scope discipline

Work is tracked as Work Packages (contract §22), one GitHub issue each. Implement only the WP
you were assigned. If you find something a later WP needs, note it in the issue — do not
implement ahead.
