# ADR-0050: The `next` line publishes unattended; `latest` keeps its reviewer

- Status: Accepted
- Date: 2026-08-21
- Relates to: §19.1 Reliability, §22 Work packages, ADR-0020, ADR-0022, ADR-0023, ADR-0042, #173

## Context

The Runtime is being forged against a real adopter, and their convergence _is_ the first stable
release. The release policy was built for a different mode, and it is well built:

- **ADR-0020 §3** gates `latest` behind adopter smoke tests.
- **ADR-0022 §4** puts the owner in the `npm-publish` Environment as a required reviewer, and
  replaces long-lived automation tokens with OIDC.
- **ADR-0042** keeps promotion to `latest` interactive, with no bypass token in CI.

Each is correct alone. Together they make **one approval do two jobs**: the same human gate stands
in front of a prerelease nobody has validated and in front of the tag that changes what `npm
install` gives everyone. The prerelease gate is the one that costs something, because the `next`
line is unvalidated _by construction_ — that is what `next` means — so approving each prerelease
publish authorizes nothing a reviewer can evaluate.

The question was put in one sentence: approve every prerelease publish, or only every promotion to
`latest`.

## Decision

**Only promotion to `latest` requires the owner's approval.**

- **`next` publishes unattended on merge to `main`**, with OIDC and provenance, and with every
  readiness check and the clean-consumer gate still running _before_ publish. The tarball is still
  uploaded for inspection.
- **`latest` is unchanged.** ADR-0020 §3's gates, the required reviewer, and ADR-0042's interactive
  promotion all stand exactly as they are.

### An unattended Environment is not the bypass token ADR-0042 rejected

Worth stating because the two are easy to conflate, and the answer decides the ADR.

ADR-0042's object is a **credential** — a token that removes a check from the path, so that
something publishes without the check having run. An Environment without a required reviewer
removes an **approval** while every check still runs: `npm run verify`, the readiness set, the
clean-consumer gate, the dist-tag snapshot and the post-publish assert are all unchanged and all
still precede the publish.

Different things. One deletes evidence; the other stops asking a human to countersign evidence
nobody disputes.

### What is not relaxed

- Consumers still install **exactly pinned tarballs from the registry**. No adopter may use a
  workspace link, a git dependency, or an unpublished build — that is what makes the clean-consumer
  gate mean anything, and it is unaffected by who approves a publish.
- `--tag next`, never `latest`, on every automatic path. The dist-tag snapshot and assert stay, so
  a run that moved `latest` fails whether or not anyone was watching.
- ADR-0042's promotion script and its interactive 2FA remain the only way `latest` moves.

### The 1.0 criterion

Unchanged and restated here because it is what the cadence exists to serve: **an independent
adopting project completes a full production run against a published artifact.** Not a passing
suite, not an internal run, and not a workspace link — a published artifact consumed the way any
adopter would consume it.

## The mechanism, and the one thing the ruling did not settle

"Publishes unattended on merge to `main`" is not implementable from the ruling alone, because the
version comes from the committed manifest: a merge that does not change it would attempt to
republish an existing version.

Three ways out were considered. **Bump in each PR** collides — six PRs were open simultaneously on
the day this was written, and the second to merge would carry a version the first already
published. **Bump on merge in the workflow** needs `contents: write` and a bot commit to `main`,
which puts a publishing workflow in the business of writing to the branch that triggers it.

**The version bump stays a reviewed change in a PR**, so it is part of the diff under review and
ADR-0022's tag/manifest agreement keeps meaning something. A merge that did not bump does not
publish — see the refusal rules below, which distinguish that from a merge that bumped to a version
already on the registry.

So the cadence is: bump the version in the PR that is ready to ship, and the merge publishes it.

### One Environment, kept exactly as declared

An earlier draft of this ADR — mine — said the workflow needed two Environments, one unattended for
`next` and one reviewed for anything that could move `latest`. **That was wrong, and it was wrong by
assuming a mechanism instead of reading it.**

`release.yml` runs exactly one publish command, `npm publish --tag next --access public
--provenance`, and never assigns `latest`. `allow-latest-move` does not cause a move: it is a
_tolerance_ flag passed to the post-publish assert, so a first publish where npm auto-creates
`latest` can be declared rather than inferred. CI cannot promote. Promotion is ADR-0042's
interactive script, twelve npm 2FA authentications, deliberately outside CI.

So the `npm-publish` Environment's only function was gating **prerelease** publishes — precisely
what the ruling says needs no approval. There is no second Environment to build.

**The Environment declaration stays in the workflow.** npm's trusted-publisher binding is scoped to
workflow _plus_ environment name, so deleting the declaration would break OIDC rather than tighten
anything. What changes is the required reviewer on it, which is a settings change and the owner's.

### Three records asserted a protection that no longer exists

Corrected here because they were false the moment the reviewer was removed, independently of this
ADR:

- `release.yml:1` — _"Nothing here runs `npm publish` until a human approves the `npm-publish`
  environment."_
- `release.yml`'s readiness re-check, whose stated reason was that _"the environment approval may
  arrive hours later"_. **The re-check stays** — a re-verify before publishing is right whatever the
  delay — and only the reason changes.
- **ADR-0022 §4** — _"the owner's approval is therefore enforced by the platform, not by anyone
  remembering to withhold a tag."_ This one was not merely stale but **inverted**: with the reviewer
  gone and the trigger still `push: tags: v*`, the only thing between a tag and a publish was
  exactly someone remembering to withhold one.

This ADR **supersedes ADR-0022 §4**. What replaces it: `latest`'s protection is **npm 2FA on an
interactive command**, not a GitHub Environment. That is a stronger claim than the one it replaces,
and unlike it, it is true.

That is the fifth instance of a description outliving its mechanism, and the first in the release
pipeline — the most consequential place for it, because a false safety claim is _relied on_ rather
than merely read.

### The trigger moves to merge on `main`

The arrangement between the ruling and this change had both disadvantages and neither advantage: no
continuous train, because a human still had to tag; and no gate, because the reviewer was gone. A
tag push was an out-of-band publish button that any account with write access could press — which
today includes every session authenticating as the owner.

Moving the trigger makes **the reviewed merge the publish event**. Tag pushes stop being a second
path to the registry.

### Refusing a republish, and the two places the literal condition needed work

The ruling requires refusing to publish a version already on the registry, so a merge that forgot to
bump fails loudly rather than attempting a republish. Implemented, with two refinements that the
condition as stated would have broken:

**A merge that did not bump does not attempt to publish at all.** Applied literally to every merge,
"refuse if already published" makes every docs-only or test-only merge fail — main would be red
between releases, which is not a loud failure but a broken signal. So the publish job runs only when
the version in the manifest **changed in that merge**. A merge that did not intend to ship does
nothing; a merge that bumped to a version already on the registry fails loudly. The condition's
phrase _"forgot to bump"_ conflates those two, and they are different facts.

**Partial-set resumability is preserved.** The existing skip-if-already-published exists because a
twelve-package publish set has twelve ways to fail halfway, and a retry must resume rather than die
on its own earlier success. Replacing it with a refusal would break that. So the refusal is checked
**for the set before publishing** — every package already present means nothing was bumped, and that
refuses — while a partially-published set still skips what landed and publishes the rest.

Same mechanism, two purposes, and the distinction is whether _all_ of the set is already there.

## Release notes carry the three-way additivity

Every release states, per change, whether it is additive **for an adapter**, **for a composition**,
and **for a consumer that reads the types** — the standard ADR-0048 and ADR-0049 already hold
per change.

The reason is a consumer's, not a publisher's. A bump that says only "minor" forces an adopter to
re-run every measurement they have. A bump that says which of the three audiences it breaks lets
them scope which measurements it invalidates and re-run a computed subset. Unattended publishing
raises the cadence, so the cost of an unscoped bump is paid more often — the notes are what keeps a
faster line cheaper to consume rather than more expensive.

## Consequences

- The prerelease line moves at the speed of merges, which is the point: the adopter's convergence
  is the release, and a human countersignature per prerelease slowed the loop without adding a
  judgement anyone could make.
- `latest` is exactly as hard to move as it was. Nothing in this ADR touches it.
- A merge publishes only if its PR bumped the version, which makes shipping a deliberate line in a
  reviewed diff rather than a consequence of merging.
- `latest = next.19` behind `next = next.20` is the policy working, not a stale artifact: one
  version behind the unvalidated line is ADR-0020 §3 doing its job. Recorded because it was once
  characterised as a lie, by a reader who had not read ADR-0042.

## Alternatives considered

- **Keep per-publish approval and accept the cadence.** A legitimate answer and it was put on the
  record as such rather than defaulted past. Rejected because the approval it asks for is not one a
  reviewer can evaluate: `next` is unvalidated by definition, so the gate tests willingness to
  click rather than fitness to publish.
- **An automation token for the unattended path.** Rejected — that _is_ ADR-0042's bypass token,
  and OIDC already removes the need for one.
- **Publish every merge with an auto-incremented version.** Rejected: it makes every merge a
  release, so the registry fills with versions nobody chose to ship and an adopter pinning one
  cannot tell which were intended.
