# ADR-0022: Release pipeline, the clean-consumer gate, and trusted publishing

- Status: Accepted
- Date: 2026-08-18
- Closes: issue #29 items 4, 5, and 6
- Relates to: ADR-0017 (npm scope), ADR-0018 (licensing), ADR-0020 (versioning and release
  policy), §21 Repository and open-source boundary

## Context

Every package passes 1,600-odd tests, builds cleanly, and typechecks. None of that says whether
the thing npm would hand a consumer works, because **npm workspaces symlink every package into
the root `node_modules`**. Inside the monorepo, a package can import something it never declared
and nothing notices.

This is not hypothetical. `@aldus-runtime/cli` and `@aldus-runtime/mcp` both declared three
workspace packages as `devDependencies` while importing them from `src/` — the CLI _constructed_
them at runtime. Build, type checker, and full suite all passed. A consumer would have crashed on
first import. It was found by hand while inspecting a tarball, which is not a process.

Publishing is also irreversible in a way little else in this project is. npm forbids
unpublishing after 72 hours, and unpublishing inside 72 hours breaks anyone who already
installed. A mistake here cannot be fixed by a follow-up commit.

## Decision

### 1. The publish set has one definition

`scripts/publish-set.mjs` owns the question of what is published. Packing, the gate, and the
release workflow all import it rather than each deriving the set. Three independent derivations
would be three chances to publish something internal.

`@aldus-runtime/e2e` is named in a `NEVER_PUBLISH` set **as well as** carrying `private: true`.
Two independent mechanisms must fail before a test harness reaches the registry, and `private` is
a flag a manifest edit can clear by accident.

The set is deliberately **not** derived from `private`, because the set must be stable while the
manifests are being prepared — the gate has to pack the real publish set before `private` has
been cleared. `assertReleaseReady` checks `private`, versions, licence, repository, and exact
internal pins separately, at the point where those conditions actually matter.

### 2. The clean-consumer gate installs tarballs, not directories

The consumer's dependencies point at `file:` **tarballs**. This is load-bearing: npm _symlinks_ a
`file:` directory and _extracts_ a `file:` tarball. Only the second proves the published artifact
stands on its own, and the gate asserts it by resolving every package and failing if any realpath
falls inside the repository.

Internal dependencies are exact pins to a version that is not on the registry (ADR-0020), so
resolution needs help. **`overrides` mapping every `@aldus-runtime/*` name to its local tarball**
is the mechanism: no service to run, no network, and third-party dependencies (`zod`) still
resolve normally from the registry — which is itself worth proving.

A local registry (Verdaccio) was the alternative. Rejected: it adds a service to start, wait for,
and tear down in CI, and its failure modes are its own rather than npm's.

### 3. Each package is also installed alone, with hoisting defeated

**This is the part that actually catches the defect that motivated the gate**, and the first
version of it did not.

Installing all twelve packages together cannot prove any one of them declared what it imports —
everything is present regardless. Worse, even installing one package alone was insufficient:
npm _hoists_ transitive dependencies to the top level, so `@aldus-runtime/cli` importing an
undeclared `file-store` still resolved, because its declared dependency on `services` pulled
`file-store` to the root.

So each package is installed alone with `--install-strategy=nested`, which places each
dependency beneath its dependent instead of hoisting. Only what a package actually declared is
reachable from it. Importing the package then executes its module graph, and a missing
declaration throws.

Verified by mutation: moving `@aldus-runtime/file-store` back to `devDependencies` fails the
gate, naming exactly that package. Before the nested strategy, the same mutation passed — which
is why the mutation test is part of the decision rather than a footnote to it.

The static check added in #37 (`package-dependencies.test.ts`) catches the same class earlier and
more cheaply. Both are kept: the static check reads source, the gate proves the artifact.

### 4. Trusted publishing, gated by a GitHub Environment

The release workflow triggers **only** on a `v*` tag or manual dispatch — never on
`pull_request`, so it is not reachable from a branch anyone can open. It requests
`id-token: write` on the publish job alone and uses npm's OIDC trusted publishing, which removes
the long-lived automation token from repository secrets entirely.

The publish job runs in a `npm-publish` GitHub Environment. It had the owner as a required
reviewer, and this paragraph said the owner's approval was _"therefore enforced by the platform,
not by anyone remembering to withhold a tag"_.

> **Superseded by ADR-0050.** The reviewer is gone: the `next` line publishes unattended on merge
> to `main`, because it is unvalidated by construction and a countersignature on it authorized
> nothing a reviewer could evaluate. The sentence above was not merely stale but **inverted** —
> with the reviewer removed and the trigger still `push: tags: v*`, the only thing between a tag
> and a publish was exactly someone remembering to withhold one. The trigger has moved to merge on
> `main` so the reviewed merge is the publish event.
>
> `latest`'s protection is unchanged and was never this Environment: nothing in CI assigns
> `latest`, and promotion is ADR-0042's interactive script behind npm 2FA.
>
> The Environment declaration stays in the workflow — npm's trusted-publisher binding is scoped to
> workflow plus environment name, so removing it would break OIDC rather than tighten anything. Everything that can fail — verification, readiness, tag/manifest
> agreement, the clean-consumer gate, packing — runs _before_ the gate, so approval is asked for
> only when the release is otherwise ready, and the tarballs are uploaded as an artifact for
> inspection before approving.

Readiness is re-checked inside the publish job rather than trusted from the earlier one, because
approval may arrive hours later, and that step is the last point before an irreversible act.

Publishing uses `--tag next --access public --provenance`. **The workflow never assigns
`latest`.** Promotion is a separate, deliberate command in `docs/RELEASING.md`.

### 5. Rollback is deprecate-and-fix-forward

`npm unpublish` is not the answer and the procedure says so: unavailable after 72 hours, and
within 72 hours it breaks installs that already succeeded, including other people's lockfiles.

The order is: move `latest` back to the last good version for **every** package, deprecate the
bad version with a message naming what breaks, then fix forward through the full procedure at the
next patch. A partial rollback across a lockstep set is worse than none, because a consumer would
get a mixed composition — precisely what lockstep exists to prevent.

And when a defect does reach the registry, the fix must extend the gate in the same change. A
gate that missed something and was not taught the case will miss it again.

### 6. No release framework

Native npm plus three small dependency-free Node scripts. Changesets, semantic-release, and Lerna
all solve independent versioning, changelog generation from commit conventions, and multi-package
graphs — problems a lockstep monorepo with twelve packages and one version does not have. The
cost of a framework here is a configuration surface and an upgrade treadmill in exchange for
behaviour that fits in about 200 lines we can read.

If independent versioning is ever adopted (ADR-0020 leaves that open), this decision should be
revisited — that is the change that makes a framework worth its weight.

## Consequences

- A packaging defect fails CI on every pull request rather than being found by inspection. The
  gate runs on PRs and `main`, not only at release.
- The gate costs about 13 seconds locally, for twelve packs and thirteen npm installs. I expected
  to have to argue that a release gate is worth being slow; it turns out not to be slow, because
  every tarball is local and the only registry traffic is `zod` and the two dev tools. It runs on
  every pull request rather than only at release.
- No npm automation token exists in repository secrets once trusted publishing is configured, so
  there is no long-lived credential to leak or rotate. Until the first publish creates the
  packages, npm has nothing to attach a trusted publisher to — that bootstrap is documented as a
  one-time granular token or a local publish, deleted immediately after.
- The `npm-publish` environment must exist and have a required reviewer, or the publish job
  cannot run. A missing environment fails closed, which is the right direction.
- The gate found two things on its first run beyond the defect it was built for: the published
  declarations require `@types/node` (undeclared), and source maps reference sources that are not
  shipped. Both are recorded in `docs/RELEASING.md` rather than fixed here, because both touch
  package manifests that were being edited in parallel.

## Alternatives considered

- **Trust `npm pack --dry-run`.** Rejected: a dry run reports what _would_ be included. It cannot
  show that a tarball extracts, that an `exports` map resolves, that declarations are reachable,
  or that a package declared what it imports.
- **A local registry for the gate.** Rejected: a service to start and tear down, with failure
  modes of its own, to solve what `overrides` solves with a JSON field.
- **Publish straight to `latest`.** Rejected by the owner and by this ADR: the first installer
  would receive a composed surface no adopter has exercised, and `latest` is the version every
  tool picks by default.
- **A long-lived npm automation token in repository secrets.** Rejected: it is a standing
  credential with publish rights on every package in the scope, and OIDC removes the need for it.
- **Publishing from a maintainer's machine as normal practice.** Rejected: it skips every gate
  and leaves no record of what was verified. Permitted exactly once, for the bootstrap npm's own
  design requires, and documented as such.
