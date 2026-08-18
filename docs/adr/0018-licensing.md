# ADR-0018: Apache-2.0 for the runtime; adopter content stays privately licensed

- Status: Accepted
- Date: 2026-08-18
- Closes: the license and visibility decisions on issue #29
- Relates to: §4.2 Aldus Core does not own, §4.3 Integration owns, §19.2 Security, §21
  Repository and open-source boundary, ADR-0001, ADR-0015, ADR-0017

## Context

§1 describes Aldus as "a general-purpose AI content production runtime" and §21 anticipates it
being "independently open-sourceable". Every package has carried `UNLICENSED` since Phase 0 —
correct while the decision was open, and untenable once the repository is public: source with no
license grants no rights, so a public repository without one is strictly worse than a private
one. It looks available and is not.

Two things had to be settled together, because settling one without the other produces an
incoherent result. A permissive runtime license implies nothing about the editorial knowledge an
adopter runs through it; and licensing that knowledge permissively would be a decision about
someone's business, not about a runtime.

## Decision

**The Aldus runtime, its official packages, and this repository are licensed under the Apache
License 2.0.** The repository is public.

**Adopter-owned Knowledge Packs, integrations, workflows, and content assets may remain
privately licensed.** They are not covered by this grant and do not live in this repository.

The license boundary follows the boundary the architecture already draws. §4.2 lists what Core
does not own — show identities, host personas, private editorial rules, credentials, provider
choices — and §4.3 places them in Integration. §19.2 states that private Knowledge Packs MUST
never be required by Aldus Core tests or distributions, and a CI job enforces it by grep. So the
line this ADR draws is not a new one; it is the existing architectural line, restated in
licensing terms.

That alignment is the point. A licensing boundary that cut across §4's boundary would be
unenforceable in practice, because nobody could tell which side a given file was on.

### Why Apache-2.0 rather than MIT

Apache-2.0 grants patent rights explicitly (§3) and terminates them on patent litigation. A
production runtime that an organisation builds a business on is exactly the case where an
implied-only patent position is worth removing. It also requires changes to be marked (§4(b)),
which suits a runtime whose whole purpose is traceability.

The cost is a longer license file and a `NOTICE` convention. That is a small price against
leaving patent grants implicit.

### Compliance requirements this creates

- **§4(a): every recipient gets a copy of the License.** The root `LICENSE` is not included in a
  workspace package's npm tarball, so each package carries its own byte-identical copy listed in
  `files`. A test asserts both, because a package that silently ships without its license looks
  no different from one that does.
- **§4(d): a `NOTICE` file must be propagated if the work has one.** Deliberately **not created
  yet** — see below.

### Third-party material

No third-party code is bundled, inlined, or vendored into any published package. Dependencies
are resolved by npm and reach the consumer under their own licenses from their own publishers,
so Apache-2.0 §4 obligations attach to Aldus's own source rather than to redistributed material.

The audit is recorded in `THIRD-PARTY-NOTICES.md`. The distributed surface is a single runtime
dependency (`zod`, MIT) — a consequence of ADR-0002 keeping Core to one schema library and §4.2
forbidding provider, platform, cloud, and storage dependencies.

## Consequences

- The repository grants real rights for the first time. Anyone may use, modify, and redistribute
  the runtime under Apache-2.0's terms.
- Publishing is still gated. Every package remains `private: true` at `0.0.0`; the license was
  one blocker on issue #29 and the owner's final pre-publish approval is another. This ADR
  settles the license, not the release.
- **The copyright holder is not recorded, and no `NOTICE` file exists.** Naming a legal entity is
  the owner's to state, not an implementation detail to infer from a git config. Until it is
  confirmed, the `LICENSE` appendix keeps its canonical `[yyyy] [name of copyright owner]`
  placeholders — which is the verbatim apache.org text and is legally unobjectionable, since the
  appendix is instructions for applying the license rather than part of the grant.
- Contributions are inbound under Apache-2.0 §5 by default. Whether a separate CLA or DCO is
  required is not decided here.

## Alternatives considered

- **MIT.** Rejected: shorter and more familiar, but leaves patent rights implicit, which is the
  one thing worth being explicit about for a runtime an organisation depends on.
- **A copyleft license (GPL/AGPL).** Rejected: it would reach into adopter integrations that
  §4.3 deliberately places outside this repository, forcing a disclosure obligation onto private
  editorial knowledge and provider configuration. That contradicts the boundary the architecture
  is built around, and would make the runtime unadoptable for its intended use.
- **Dual licensing, or a source-available license with a commercial exception.** Rejected as
  premature: no adopter or commercial arrangement exists yet, and a licensing regime is far
  easier to loosen later than to tighten.
- **Leaving `UNLICENSED` until the first publish.** Rejected: the repository is already public,
  and public source without a license grants nothing while appearing to.
