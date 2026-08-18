# ADR-0017: The published npm scope is `@aldus-runtime`

- Status: Accepted
- Date: 2026-08-18
- Supersedes: ADR-0001 decision 4 (the `@aldus/*` working name) only. ADR-0001 otherwise stands.
- Closes: contract §25 item 10, **in part** — package names are decided; extraction criteria and
  the decision to publish are not.
- Relates to: §21 Repository and open-source boundary, issue #29

## Context

ADR-0001 adopted `@aldus/*` as a **working name**, explicitly "not a claim on a public package
name", and left §25 item 10 open. That was the right call at the time: naming a scope nobody had
registered would have been a claim the project could not honour.

The `aldus-runtime` npm organization is now registered, so the working name can become a real
one. `@aldus` itself was unavailable, which is why the published scope differs from the product
name.

Issue #29 sequences release preparation and states the constraint that shapes this ADR: **do not
publish under a temporary namespace.** A rename after publication is far more expensive than one
before it — every consumer's imports break, and the abandoned scope stays resolvable and
confusing. Renaming now costs a mechanical edit; renaming later costs a deprecation.

## Decision

The published npm scope is **`@aldus-runtime`**. Every workspace package is renamed
`@aldus/<name>` → `@aldus-runtime/<name>`.

**Only the npm namespace changes.** These are deliberately unchanged, and each has a reason
beyond inertia:

| Identifier      | Value                               | Why it does not move                                                                                                                                             |
| --------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product         | `Aldus`                             | §2 ties the name to the design intent; the registry could not accommodate it, which is a registry fact, not a rename                                             |
| Repository      | `jamchen/aldus`                     | renaming would break every existing link and issue reference                                                                                                     |
| CLI binary      | `aldus`                             | §18's documented command surface; an operator types this                                                                                                         |
| State directory | `.aldus/`                           | §7's recommended layout, and existing workspaces contain it                                                                                                      |
| Schema `$id`    | `urn:aldus:schema:<version>:<Name>` | a persisted identity in committed artifacts (ADR-0002); changing it would force a schema version bump for a packaging decision, which ADR-0003 does not sanction |
| MCP tool names  | `aldus_*`, `aldus:*` capabilities   | a host's configuration references these (ADR-0014)                                                                                                               |

The distinction is that an npm scope is a _distribution_ identity, while the others are _runtime
and data_ identities. Only the first was ever provisional.

Directory names under `packages/` keep their `aldus-` prefix, matching §21's recommended layout.

## Consequences

- The rename is mechanical and complete: 341 occurrences, all of the form `@aldus/`, with no
  bare `@aldus` anywhere. The invariants above share no `@` with the scope, so the replacement
  could not touch them by accident — verified by counting each before and after.
- The architecture contract required no edit at all: it never referenced the npm scope, only the
  directory layout. That is a small piece of evidence that §4's boundary was drawn in the right
  place.
- Publishing remains blocked and deliberately so. Every package stays `private: true` at
  `0.0.0` under `UNLICENSED`. The license, repository visibility, and final publish approval are
  owner decisions tracked on #29, and this ADR does not pre-empt any of them.
- §25 item 10's other half — the extraction criteria in §21 — is untouched. A registered scope is
  not evidence that "at least one alternative adapter or test double proves substitutability".

## Alternatives considered

- **Keep `@aldus/*` and negotiate for the scope.** Rejected: it makes the release date depend on
  someone else's decision, and #29 forbids publishing under a temporary namespace in the
  meantime.
- **Rename the product, repository, and binary to match the scope.** Rejected: the registry's
  availability is a poor reason to rename a product §2 names deliberately, and it would break
  every existing link, operator habit, and persisted schema identity to fix a packaging problem.
- **Publish unscoped as `aldus-core`, `aldus-cli`, …** Rejected: a scope is what makes it
  evident which packages belong to one runtime, and unscoped names are individually squattable
  in a way an organization is not.
- **Defer the rename until just before publishing.** Rejected: it leaves every import, ADR, and
  example carrying a name known to be wrong, and concentrates the change at the moment with the
  least room for error.
