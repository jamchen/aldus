# ADR-0023: The bootstrap release carries `latest`; later unvalidated releases use prerelease versions

- Status: Accepted
- Date: 2026-08-18
- Amends: [ADR-0020](0020-versioning-and-release-policy.md) decision 3. The rest of ADR-0020 stands.
- Relates to: §21 Repository and open-source boundary, issue #29

## Context

ADR-0020 decision 3 said the first release publishes under `next`, and that nothing is assigned
to `latest` until the clean-consumer gate and an adopter smoke test pass. Every publish in the
0.1.0 bootstrap ran `npm publish --tag next --access public`, exactly as intended.

All twelve packages nonetheless ended with **both** tags pointing at `0.1.0`.

The cause is npm semantics, not a mistake in the command: **npm assigns `latest` on the first
publish of a package regardless of `--tag`.** A package must have a `latest` tag, and when none
exists the registry creates one pointing at whatever was just published. `--tag next` controlled
the _additional_ tag, not the default one. ADR-0020 assumed `--tag` was sufficient. It is not,
for a package that does not yet exist.

This was discovered immediately after publishing, by verification rather than by a user.

## Decision

### 1. The `0.1.0` bootstrap keeps both tags

`latest = 0.1.0` and `next = 0.1.0` on all twelve packages. Nothing is removed.

Removing `latest` was considered and rejected. npm's behaviour when a package has no `latest`
is at best unhelpful — an unversioned `npm install` either fails to resolve or resolves
surprisingly — so the cure is more confusing than the condition. Removing it from some packages
and not others would be worse still: **consistency across the twelve matters more than
reconstructing the intended tag state**, because a consumer reasoning about one package's tags
should be able to assume the rest match.

The exposure this leaves is genuinely small and bounded. `0.1.0` already communicates a
pre-stable API under SemVer, the project has not been announced, and `latest` is repointed by the
first deliberate promotion anyway.

### 2. Future unvalidated releases use prerelease versions, not just a tag

A release that has not been validated by an adopter publishes as a **prerelease SemVer version**
— `0.2.0-next.0`, `0.2.0-next.1`, and so on — to the `next` tag only.

This is the durable fix, and it works because npm does not move `latest` to a prerelease version.
The protection therefore lives in the **version string**, which the registry enforces, rather
than in a flag whose behaviour depends on whether the package already exists. A rule that only
holds for the second publish onwards is not a rule worth relying on.

### 3. A stable version reaches `latest` only after adopter validation

`0.2.0` — no prerelease suffix — is published only once an adopter has installed from npm and
exercised the composed surface with real adapters. That promotion is a deliberate act with the
owner's approval, not a side effect of publishing.

### 4. The workflow records and asserts tags around every publish

The release workflow captures `latest` and `next` for every package immediately before and
immediately after publishing, prints both, and **fails if `latest` moved when the release was
not intended to move it**. An unexpected tag movement becomes visible within the same job rather
than during a later audit.

This is the specific control that would have caught the bootstrap deviation as it happened,
instead of minutes afterwards.

## Consequences

- The bootstrap is a documented exception rather than an unexplained inconsistency. Anyone
  reading the tags in six months finds the reason here.
- `0.1.0` is the public-preview release. It is installable by default, and that is now a stated
  position rather than an accident.
- Every subsequent unvalidated release is protected by SemVer semantics, which do not depend on
  registry state — a strictly stronger guarantee than the one ADR-0020 assumed.
- The workflow's tag assertion adds a failure mode: a legitimate `latest` promotion must state
  its intent explicitly. That is the intended cost.

## Alternatives considered

- **Remove `latest` from all twelve.** Rejected: it makes unversioned installation confusing or
  unavailable without materially reducing exposure, and it invents a registry state npm does not
  expect a package to be in.
- **Remove `latest` from one package as a test.** Rejected: an inconsistent set is worse than a
  consistent one, and the test itself would leave a package in the state under evaluation.
- **Publish `0.1.1` immediately so `latest` points somewhere deliberate.** Rejected: it burns a
  version to relabel the same code, and `latest` would still point at an unvalidated release.
- **Treat `--tag next` as sufficient in future and rely on care.** Rejected: the failure was
  precisely that a flag's behaviour depended on state nobody checked. A version-level guarantee
  does not.
