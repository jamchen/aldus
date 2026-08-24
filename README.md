# Aldus

A general-purpose AI content production runtime: versioned content artifacts produced through
deterministic workers, bounded agentic reasoning, explicit quality loops, human decisions, and
reusable production knowledge.

- **Architecture contract:** [`docs/ALDUS-ARCHITECTURE.md`](docs/ALDUS-ARCHITECTURE.md)
  ([繁體中文](docs/ALDUS-ARCHITECTURE.zh-Hant.md))
- **Decisions:** [`docs/adr/`](docs/adr/)
- **Working agreement:** [`CLAUDE.md`](CLAUDE.md)
- **Changes between versions:** [`CHANGELOG.md`](CHANGELOG.md)

## Status

Counts live in [`STATUS.md`](STATUS.md), measured by `node scripts/status.mjs` rather than typed
here. This section had four false numbers at once because each was true when written and nothing
recomputed it.

Contract §22 defines twelve work packages. Eleven are implemented. **WP-06 is adopter
integration work and is not implemented here** — the production scripts and their wrappers live
in the adopter's own repository depending on `@aldus-runtime/*` (§4.3, ADR-0015).

| WP      | Package                                         | State                                   |
| ------- | ----------------------------------------------- | --------------------------------------- |
| Phase 0 | —                                               | workspace, toolchain, CI, ADRs          |
| WP-01   | `@aldus-runtime/core`, `@aldus-runtime/testkit` | done                                    |
| WP-02   | `@aldus-runtime/file-store`                     | done                                    |
| WP-03   | `@aldus-runtime/artifact-registry`              | done                                    |
| WP-04   | `@aldus-runtime/stage-runner`                   | done                                    |
| WP-05   | `@aldus-runtime/gate-engine`                    | done                                    |
| WP-06   | —                                               | adopter-side; an adopter now exists     |
| WP-07   | `@aldus-runtime/tts-ledger`                     | generic half done; adoption needs WP-06 |
| WP-08   | `@aldus-runtime/services`, `@aldus-runtime/cli` | done                                    |
| WP-09   | `@aldus-runtime/core` (knowledge)               | done                                    |
| WP-10   | `@aldus-runtime/regression`                     | done                                    |
| WP-11   | `@aldus-runtime/mcp`                            | done                                    |
| WP-12   | `@aldus-runtime/release`                        | done                                    |

See [`STATUS.md`](STATUS.md) for the test total, the ADR count, the published package list, the
open issues and the current npm dist-tags.

**None of those numbers is evidence of completeness.** The direction review of 2026-08-24 is
explicit that package, ADR and test counts must stop being read that way, and that the next
milestone is one fully-owned production run rather than more surface. No adopter production path
has run end to end.

### Against §24's definition of done

Ten of the twelve criteria are met. Two are not, and neither can be met by writing more runtime
code:

- _"the current production scripts run through stage wrappers"_ — adopter-side (WP-06). The
  direction review of 2026-08-24 reports that the first adopter has ported its renderer, media and
  release stages onto published packages, pinned exactly. **Attributed to that review, not read
  here** — this repository cannot check a claim about another one, and structural porting is not
  the same as a production run, which has not happened.
- _"a representative defect corpus is executed during regression testing"_ — `@aldus-runtime/regression`
  runs a corpus; a _representative_ one is adopter content, and §19.2 forbids requiring private
  knowledge in Core's tests.

[#27](https://github.com/jamchen/aldus/issues/27) — three packages unreachable from the CLI and
MCP surface — is closed. The open issues are listed in [`STATUS.md`](STATUS.md); each came from an
adopter hitting a contract edge, which is the bar the 2026-08-24 review sets for new Runtime work.

## Packages

| Package                                            | Purpose                                                          |
| -------------------------------------------------- | ---------------------------------------------------------------- |
| [`@aldus-runtime/core`](packages/aldus-core)       | Domain types, JSON schemas, validation, ID generation, redaction |
| [`@aldus-runtime/testkit`](packages/aldus-testkit) | Deterministic builders, fixtures, and test doubles               |

## Quick start

```bash
npm install
npm run verify
```

## License

Aldus is licensed under the [Apache License 2.0](LICENSE).

That covers the runtime, its official packages, and this repository. **Adopter-owned Knowledge
Packs, integrations, workflows, and content assets may remain privately licensed** — the
architecture contract §4.2 and §4.3 already keep them outside this repository, and the license
boundary follows the same line (ADR-0018).

Copyright 2026 Jam Chen. See [`NOTICE`](NOTICE).

Third-party dependency licenses are recorded in
[`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md). No third-party code is bundled into any
published package.

## Scope

Aldus Core is generic. It contains no show, host, brand, TTS provider, publishing platform, or
cloud-storage specifics — those live in adopter integrations behind the public contracts
(architecture contract §4.2, §4.3).
