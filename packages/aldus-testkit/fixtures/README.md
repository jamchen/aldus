# Fixture corpus

The durable contract corpus for `@aldus-runtime/core`. Every file here is JSON on disk rather than an
object literal in a test, because two consumers cannot see a literal: a non-TypeScript validator
checking the published JSON Schema (ADR-0002), and a future schema migration that must prove it
can still read records written today (ADR-0003).

## Layout

| Path                             | Contents                                                                                                                                       |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `manifest.json`                  | The index. Every fixture is listed here, with a description and — for invalid fixtures — the expected failing path and `jsonSchemaDetectable`. |
| `valid/<Schema>.<case>.json`     | Records expected to validate. Every schema has at least a `minimal` case (required fields only) and a `full` case (every optional populated).  |
| `invalid/<Schema>.<defect>.json` | Records expected to fail, one file per distinct defect.                                                                                        |

The manifest and the directory are checked against each other **in both directions**. A manifest
entry without a file fails loudly on load; a file without a manifest entry would fail silently by
never being exercised, which is the worse failure and the reason that check exists.

## The corpus is frozen

Every fixture is pinned at `schemaVersion` `"1.0"`.

Fixtures are **not** edited to make a failing test pass. A fixture that stops validating means
one of two things:

- the schema changed compatibly, in which case the fixture should still validate and the failure
  is a real regression; or
- the schema changed breakingly, which is a MAJOR bump under ADR-0003 — and the corpus is
  revisited deliberately, as part of that decision, not as a fix-up.

## `jsonSchemaDetectable`

Each invalid fixture declares whether a generic JSON Schema validator also rejects it.

`false` marks a defect only the normative Zod schema catches, because the constraint is a
cross-field refinement JSON Schema cannot express (ADR-0002). There are exactly two:

| Fixture                                 | Constraint                                                               |
| --------------------------------------- | ------------------------------------------------------------------------ |
| `CostRecord.no-amounts`                 | At least one of `estimated` / `actual` must be present (contract §19.3). |
| `StageExecution.non-ascending-attempts` | `attempt` ordinals must strictly ascend (contract §6.3).                 |

The flag lives in the manifest, not inside the fixture record — it is metadata _about_ the
fixture, and burying it in the payload would make the payload not quite the record under test.

`conformance.test.ts` asserts the declaration in **both** directions: if Ajv rejects a fixture
marked `false`, that fails too. Otherwise the flag decays from "here is exactly where the
projection is weaker" into "here is somewhere it might be", which is not a statement anyone can
rely on.

## Boundary

Contract §4.2 keeps show, host, provider, platform, and cloud identities out of Core, and §19.2
states private Knowledge Packs must never be required by Core tests or distributions. Every
identity here is transparently fictional — `example-show`, `example-host`, `provider-a`,
`destination-a`, `workflow-a` — and must stay that way. CI enforces it.
