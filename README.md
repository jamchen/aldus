# Aldus

A general-purpose AI content production runtime: versioned content artifacts produced through
deterministic workers, bounded agentic reasoning, explicit quality loops, human decisions, and
reusable production knowledge.

- **Architecture contract:** [`docs/ALDUS-ARCHITECTURE.md`](docs/ALDUS-ARCHITECTURE.md)
  ([繁體中文](docs/ALDUS-ARCHITECTURE.zh-Hant.md))
- **Decisions:** [`docs/adr/`](docs/adr/)
- **Working agreement:** [`CLAUDE.md`](CLAUDE.md)

## Status

Early implementation. Delivered so far:

| Work package | Contents                                                             | State |
| ------------ | -------------------------------------------------------------------- | ----- |
| Phase 0      | workspace, toolchain, CI, ADR-0001…0003                              | done  |
| WP-01        | core domain types, JSON schemas, validators, IDs, redaction, testkit | done  |

Everything else in contract §22 — file state and event store (WP-02), artifact registry
(WP-03), stage runner (WP-04), gate and authorization engine (WP-05), TTS ledger (WP-07), CLI
(WP-08), Knowledge Pack loader (WP-09), regression harness (WP-10), Production MCP (WP-11), and
release adapters (WP-12) — is unimplemented.

## What WP-01 delivers

Eleven domain types with Zod schemas as the single source of truth, JSON Schema draft 2020-12
projections generated and committed, a validation layer, ULID-based identifiers, canonical
content identity, redaction helpers, and a deterministic testkit with a 47-file fixture corpus.

556 tests. Three checks are worth calling out, because they enforce the architecture rather
than the code:

- **The contract is executable.** `contract-conformance.test.ts` parses the TypeScript
  declarations out of `docs/ALDUS-ARCHITECTURE.md` and fails if a schema drifts from them in
  either direction. The three sanctioned departures are enumerated; a fourth cannot appear
  silently.
- **The boundary is enforced by CI, not by review.** A job greps `packages/` for provider,
  platform, cloud, and adopter identifiers and fails the build on a hit (contract §4.2).
- **The JSON Schema projection is honest about being weaker.** Cross-field refinements cannot
  be expressed in JSON Schema, so each invalid fixture declares whether a JSON Schema validator
  can detect it, and conformance asserts that declaration in both directions. Exactly two
  constraints are Zod-only, and a test pins that count.

## Packages

| Package                                    | Purpose                                                          |
| ------------------------------------------ | ---------------------------------------------------------------- |
| [`@aldus/core`](packages/aldus-core)       | Domain types, JSON schemas, validation, ID generation, redaction |
| [`@aldus/testkit`](packages/aldus-testkit) | Deterministic builders, fixtures, and test doubles               |

## Quick start

```bash
npm install
npm run verify
```

## Scope

Aldus Core is generic. It contains no show, host, brand, TTS provider, publishing platform, or
cloud-storage specifics — those live in adopter integrations behind the public contracts
(architecture contract §4.2, §4.3).
