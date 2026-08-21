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

### A guard is only tested when its result comes from the mechanism under test

The general form of four rules that arrived separately in one day, which is why it is stated here
rather than left as four anecdotes:

- _establish the instrument is sound before believing what it says_ — an invalid measurement that
  agrees with a plausible worry is the hardest to discard, because discarding it feels like refusing
  evidence;
- _commit the instrument before probing it_ — `git reset --hard` deleted an uncommitted check, and
  the cases that followed exited on `MODULE_NOT_FOUND` and read as passes;
- _assert on output, not status, wherever a check can afford to_ — a missing file, a misspelled
  filename and a real negative share an exit code;
- and the case that produced the sentence: testing this runner's preflight and output assertions
  required **committing** the modified manifest first, because with a dirty tree the worktree guard
  fires and both look verified for the wrong reason. Two guards confirmed by a third.

### Verify in the environment that will run it, or say that you did not

Three rules in this repository turn out to be one, and the third arrived by breaking `main`:

- **the clean-consumer gate** — an adopter installs a published tarball, never a workspace link,
  because a link resolves what a tarball cannot and passes checks the real thing fails;
- **exact internal pins, never ranges** — a range is a promise about a package you did not test;
- **and: a release check verified against a full local clone, when CI checks out shallow.** The
  script read the previous commit's version, `actions/checkout` is shallow by default so that commit
  was absent, and a merge that changed nothing shippable reported an attempted republish. The local
  run passed. It could not have failed: a full clone is to a shallow checkout what a workspace link
  is to a tarball — a more convenient version of the thing, missing the constraint that matters.

The rule is not "test more". It is that **a friendlier environment does not disprove a fault, and
passing in one is not evidence about the other.** Where the real environment cannot be reproduced —
and often it cannot — say so in the claim rather than leaving the reader to assume otherwise. The
`does not:` line of an evidence block is where that belongs: _"reproduced locally with `--depth 1`,
which is the condition CI has, not CI itself."_

This sits beside "check the mechanism, not its description" rather than inside it. That one is about
a description drifting from its code; this one is about a measurement taken somewhere the code will
never run.

### A claim about another repository is not checkable from here

`check-generic-boundary.mjs` catches an adopter's identity entering our record. It cannot catch the
opposite direction across the same line: a claim _about_ the adopter's repository asserted here
without being read there. Both happened in one day — a `git grep` result recorded as ADR evidence
that named the adopter, and a file attributed to this repository that exists in neither, whose
supposed contents came from a chat message rather than any artifact.

There is no grep for the second. What there is: **attribute a cross-repository claim to where it was
read, or do not make it.** "A search across the first adopter's integration finds neither export" is
checkable by whoever has that repository. "Your `mutate.mjs` header names this error" is not
checkable by anyone, because the file is not there.

**Checks that replace something a reviewer did by hand:**

| script                         | the claim it verifies                                                                         |
| ------------------------------ | --------------------------------------------------------------------------------------------- |
| `check-generic-boundary.mjs`   | no provider/platform/cloud name in `packages/`, no adopter identity in `packages/` or `docs/` |
| `check-version-bump.mjs`       | a PR changing `files`-scoped contents bumps the version                                       |
| `check-resolution-surface.mjs` | a merge's diff is a subset of the union of its parents' diffs                                 |
| `check-claim-scope.mjs`        | `docs-only` / `no-shipped-change` is true rather than asserted                                |

`check-resolution-surface.mjs` does **not** establish that a resolution chose correctly — keeping
one caller's shape and dropping the other's argument is a correct-surface, wrong-content failure,
and no diff comparison catches it.

**A coordinator sits upstream, so its errors are amplified rather than filtered.** Three times in
one day a coordinator's error propagated into implementation before being caught: a trial-merge
result relayed forward as fact, a ruling written against an unpublished arm, and a two-Environment
split that assumed a mechanism `allow-latest-move` does not have. All three were caught downstream,
by reading the mechanism. **When a ruling asserts a mechanism, check the mechanism before building
on it.** The review direction that matters most is implementation over coordination, not the reverse.

## Check the mechanism, not its description

Four defects in two days shared one mechanism, and it is worth stating separately from any of them
because each looked like an isolated lapse:

| the description                 | the mechanism                                               |
| ------------------------------- | ----------------------------------------------------------- |
| `absenceIsReadable`             | equivalent to `true`                                        |
| "test-harness-only"             | a published surface (`RecordingReleaseAdapter` is exported) |
| "all genuinely clean"           | trial-merged against the wrong base                         |
| "Reject adopter-specific names" | a regex holding no adopter name                             |

**In every one the description was checked and the mechanism was not.** Nobody re-read the regex
against the sentence above it. A name, a comment and a claim are all easier to read than the code
under them, and they are read first — so a mechanism that has drifted from its description keeps
passing review for as long as reviewers read the description.

Two habits that catch this cheaply, both earned rather than invented:

- **Before describing a change's blast radius** — _test-only_, _docs-only_, _additive_ — check the
  **export surface**, not the file path. Three of the four above would have fallen to that question
  alone.
- **Before claiming a measurement**, ask what was measured, with what, and whether it answers the
  question the claim is about. "All genuinely clean" was true of what was measured and false of
  what it was taken to mean; so were "trivial" and "test-harness-only".

A corollary about instruments. A harness that lies is found by someone else; an instrument that
lies is only ever found by the person holding it — so the check has to be habitual rather than
triggered by suspicion. And an invalid measurement that happens to **agree with a plausible worry**
is the hardest to discard, because discarding it feels like refusing evidence. Establish the
instrument is sound before believing what it says.

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
