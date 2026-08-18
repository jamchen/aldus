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

| Work package | Contents                                                             | State       |
| ------------ | -------------------------------------------------------------------- | ----------- |
| Phase 0      | workspace, toolchain, CI, ADR-0001…0003                              | done        |
| WP-01        | core domain types, JSON schemas, validators, IDs, redaction, testkit | in progress |

Everything else in contract §22 (file store, artifact registry, stage runner, gates, CLI, MCP,
release adapters) is unimplemented.

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
