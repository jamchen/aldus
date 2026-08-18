# ADR-0020: Lockstep versioning, exact internal pins, and `next` before `latest`

- Status: Accepted
- Amended by: [ADR-0023](0023-bootstrap-release-exception.md) — decision 3 only; the rest stands
- Date: 2026-08-18
- Closes: issue #29 item 3 (monorepo versioning and release policy)
- Relates to: §21 Repository and open-source boundary, ADR-0001, ADR-0015, ADR-0017, ADR-0018

## Context

Thirteen packages have carried `0.0.0` with internal dependencies written as `*` since Phase 0.
That was correct while nothing was published and every consumer was the workspace itself. It
stops being correct the moment a tarball reaches a registry, because `*` means _any version,
forever_: a consumer installing `@aldus-runtime/cli@0.1.0` could be handed
`@aldus-runtime/core@2.0.0` and fail in a way neither they nor we can reproduce.

Three questions had to be answered together, because answering one without the others produces a
release policy that contradicts itself: how versions relate across packages, how internal
dependencies are expressed, and how a first release reaches users.

The constraint shaping all three is that **publishing is irreversible in practice**. npm
unpublish is unavailable after 72 hours and disruptive within it, so the recovery for a bad
release is a deprecation and a follow-up version. Every choice below prefers a cost paid before
publication over one paid after.

## Decision

### 1. Lockstep versioning

Every published package shares one version. `0.1.0` is the first.

These packages are developed, tested, and released together, and §22's work packages describe one
system rather than a collection. A consumer debugging behaviour across `services`, `gate-engine`,
and `file-store` should be able to read three version numbers that are the same number, rather
than reason about a compatibility matrix nobody has tested.

The cost is honest: a change confined to one package still bumps all thirteen, so a version
number stops being evidence that a particular package changed. The changelog carries that
information instead. Independent versioning remains adoptable later; the reverse — collapsing
diverged versions back into lockstep — is far harder.

### 2. Internal dependencies are exact pins

`"@aldus-runtime/core": "0.1.0"`, not `^0.1.0` and not `*`.

**The first release must install exactly the composition that was tested.** A caret range on a
`0.x` package permits patch drift, and `0.x` is precisely the period when a patch may carry a
behavioural change. Exact pins mean the dependency graph a consumer resolves is the graph CI
packed and the clean-consumer gate exercised.

The cost is duplication: a consumer depending on two Aldus packages at different versions gets
two copies rather than a deduplicated one. That is acceptable while lockstep guarantees a
consumer has no reason to mix versions.

Compatible ranges are revisited **after an explicit compatibility policy exists and has been
tested** — not before. A range is a claim about which combinations work, and no such claim has
been verified yet.

### 3. `next` before `latest`

The first release publishes under the `next` dist-tag. Nothing is assigned or promoted to
`latest` until the clean-consumer gate and an adopter smoke test pass and the owner approves.

> **Amended by [ADR-0023](0023-bootstrap-release-exception.md), 2026-08-18.** This assumed
> `--tag next` keeps a first publish off `latest`. It does not: npm assigns `latest` on the
> first publish of a package regardless of `--tag`, because a package must have one. The
> `0.1.0` bootstrap therefore carries both tags, and later unvalidated releases use prerelease
> versions rather than relying on a flag.

`latest` is what `npm install @aldus-runtime/core` resolves to. Publishing straight there hands
the first person who types that command a runtime whose composed surface no adopter has ever
exercised. Promotion costs one command; a bad `latest` costs a deprecation and an explanation.

### 4. What is published, and what never is

Twelve packages are published. `@aldus-runtime/testkit` is among them: its builders, fixtures,
and harnesses are part of the supported adopter-facing surface, and an adopter writing tests
against these contracts needs them.

`@aldus-runtime/e2e` is **permanently private**. It exists to prove the composed stack works and
has no meaning outside this repository. It carries `private: true`, no `publishConfig`, and the
release tooling excludes it explicitly rather than relying on that flag alone.

### 5. Every published package declares `publishConfig`

`access: "public"` and the registry URL, per package. A scoped package defaults to _restricted_
access — without this a publish either fails or silently succeeds as a private package, and a
privately published name is still a taken name.

### 6. Breaking changes during `0.x`

Semver permits a breaking change in a `0.x` minor. Aldus will still treat one as significant: a
breaking change bumps the minor, is recorded in the changelog with a migration note, and — where
it affects a persisted record — requires the schema-version treatment ADR-0003 already defines.
The two versioning schemes are independent: `SCHEMA_VERSION` describes stored data, package
versions describe code, and neither implies the other.

### 7. Rollback

A published version is never unpublished. The response to a bad release is `npm deprecate` with a
message naming the replacement, followed by a fixed version. If the bad version reached `latest`,
`latest` is repointed at the last good version first — before the deprecation, so the fast path
stops serving it immediately.

## Consequences

- The release becomes a single decision about one number, which is the point.
- `packages/aldus-core/test/release-metadata.test.ts` enforces every invariant above: one version
  across all packages and the root, exact internal pins, `private` exactly where intended, and
  `publishConfig` on everything publishable. Drift fails CI rather than reaching a registry.
- Exact pins mean the release tooling must update every manifest atomically. A partial bump is a
  broken release rather than a mixed one, which is the safer failure.
- Lockstep plus exact pins makes the clean-consumer gate meaningful: the tarballs it installs are
  the exact set a real consumer would get.

## Alternatives considered

- **Independent versions per package.** Rejected for a first release: it front-loads a
  compatibility matrix nobody has tested, and the packages have never been released separately.
  Adoptable later without unwinding anything.
- **Caret ranges on internal dependencies.** Rejected: a caret is a claim that any matching
  version works, and that claim is unverified. It also makes "which composition failed?"
  unanswerable from a lockfile a user sends us.
- **Publishing straight to `latest`.** Rejected: it spends the one chance to find integration
  problems before anyone depends on them.
- **A release framework (Changesets, Lerna, semantic-release).** Rejected for now: lockstep with
  exact pins is a version-number rewrite across thirteen manifests, which native npm workspaces
  plus a small script handle. A framework earns its place when independent versioning arrives, and
  #29 explicitly asks that one not be added without documenting why native tooling is
  insufficient.
