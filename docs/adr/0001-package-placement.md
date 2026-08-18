# ADR-0001: Package placement during incubation

- Status: Accepted
- Amended by: [ADR-0017](0017-npm-scope.md) — decision 4 only; the rest stands
- Date: 2026-08-18
- Closes: architecture contract §25 item 1 (partially — extraction timing stays open)
- Relates to: §21 Repository and open-source boundary, §4 System boundary

## Context

§21 recommends a logical layout (`packages/aldus-core`, `aldus-cli`, `aldus-mcp`,
`aldus-file-store`, `aldus-testkit`, plus `integrations/`) and states this is "logical, not an
instruction for an immediate repository move". It also says the first implementation SHOULD
live as an internal package or workspace alongside the adopter until five extraction criteria
are met.

This repository (`jamchen/aldus`) contained only a README and the architecture document. There
is no adopter code in it. So the "alongside the adopter" guidance has no adopter to sit next
to here, and WP-01 still needs a home that does not prejudge the extraction decision (§25 item
10: public package names and extraction criteria).

## Decision

1. The repository is an **npm workspaces monorepo**. Workspace glob: `packages/*`.
2. WP-01 creates exactly two packages:
   - `packages/aldus-core` → `@aldus/core`
   - `packages/aldus-testkit` → `@aldus/testkit`
3. Both packages are `"private": true` and version `0.0.0`. Nothing is published from this
   repository yet.
4. The `@aldus/*` npm scope is a **working name**, not a claim on a public package name.
   §25 item 10 (public package names) stays open and is not decided here.
   **Superseded by [ADR-0017](0017-npm-scope.md):** the `aldus-runtime` npm organization was
   registered, and the published scope is now `@aldus-runtime/*`. The rest of this ADR stands.
5. Directory names follow §21 verbatim (`aldus-core`, `aldus-testkit`) so a later move to the
   §21 layout — or into an adopter monorepo — is a directory move, not a rename.
6. `integrations/` is **not** created. No adopter integration exists yet, and creating an empty
   adopter slot inside Core's repository would invite the dependency direction §4.3 forbids.

## Consequences

- Reversible. Publishing, renaming the scope, extracting to another repository, or absorbing
  this tree into an adopter monorepo are all still open; none requires a code change beyond
  package metadata.
- npm workspaces (not pnpm/yarn) keeps the toolchain to what ships with Node, so a contributor
  needs no package-manager install step. If workspace features later prove insufficient, the
  lockfile is the only artifact that must be regenerated.
- `private: true` means CI cannot accidentally publish. Removing it is a deliberate act tied to
  the §21 extraction criteria.
- Because there is no adopter in this repository, the §21 criterion "private packs can be
  absent from core tests" is satisfied structurally: Core has no way to reach adopter content.

## Alternatives considered

- **Single flat package (`src/` at repo root).** Rejected: WP-01 explicitly delivers a testkit,
  and merging testkit helpers into Core would ship test builders to production consumers or
  require a second entry point that is a package boundary in all but name.
- **Create all §21 packages now as empty stubs.** Rejected: WP-03…WP-12 are out of scope for
  this work package, and empty stubs are indistinguishable from unimplemented contracts.
- **Start inside the adopter repository.** Rejected: the adopter repository is not this one, and
  moving the contract document out of `jamchen/aldus` to follow the code would leave the
  architecture contract homeless.
