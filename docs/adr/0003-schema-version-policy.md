# ADR-0003: Schema version and compatibility policy

- Status: Accepted
- Date: 2026-08-18
- Closes: architecture contract §25 item 2 (schema-migration mechanism)
- Relates to: §6.1/§6.2/§8 (`schemaVersion` fields), §19.1 "schema migration policy"

## Context

§6.1, §6.2, and §8 each declare `schemaVersion: string` but do not define its format, its
granularity, or what a reader must do when it encounters an unfamiliar value. §19.1 requires a
schema migration policy. §5.1 notes that "long pauses between stages are normal" — so a run
manifest written weeks ago by an older build will routinely be read by a newer one, and
Git-tracked `.aldus/` state means an older build can also read newer records.

## Decision

### Format

`MAJOR.MINOR`, both non-negative integers, no prefix, no patch component. Initial value
`"1.0"`, exported as `SCHEMA_VERSION`.

### Granularity: one version for the whole Core schema set

All Core record types share a single version constant. There is no per-entity version.

### Bump rules

- **MINOR** — backward-compatible change: adding an optional field, adding a member to an open
  enumeration, relaxing a constraint. A reader on the same MAJOR can still read the record.
- **MAJOR** — anything else: removing or renaming a field, making an optional field required,
  narrowing a type or constraint, changing a field's meaning, removing an enum member.

### Reader behaviour

`checkSchemaVersion(actual, supported)` classifies into exactly three outcomes:

| Case                                          | Result         | Reader behaviour                                                      |
| --------------------------------------------- | -------------- | --------------------------------------------------------------------- |
| same MAJOR, `actual.minor <= supported.minor` | `compatible`   | read normally                                                         |
| same MAJOR, `actual.minor > supported.minor`  | `forward`      | read normally; unknown properties are ignored, not rejected           |
| different MAJOR                               | `incompatible` | refuse with `StructuredError` code `ALDUS_SCHEMA_VERSION_UNSUPPORTED` |

`forward` is a readable outcome, not an error. It is surfaced so a caller may warn or refuse to
_write back_ a record it does not fully understand — a decision left to the store (WP-02).

Writers always stamp the `SCHEMA_VERSION` of the build that wrote the record.

### Migration mechanism

There is none in WP-01, deliberately. No MAJOR 2 exists, so a migration framework would have no
case to encode. What WP-01 does provide is the machinery a migration will need:

- a version on every persisted record,
- a classifier that makes an unreadable record fail loudly instead of silently mis-parsing,
- fixtures pinned at `"1.0"` that must keep validating.

When a MAJOR bump is first required, a follow-up ADR defines the upgrade function shape. Until
then, the smallest reversible option is to detect and refuse, not to build an unused framework.

### `schemaVersion` placement

Required on record types that are persisted or transmitted **as standalone documents**:

`EpisodeRef`, `RunManifest`, `StageExecution`, `ArtifactRef`, `GateDecision`, `CostRecord`,
`ReleaseReceipt`.

Absent on **embedded value objects**, which inherit the version of the document containing
them: `ActorRef`, `StageAttempt`, `KnowledgePackRef`, `StructuredError`, `Money`,
`PerformanceSegment`-style leaf shapes.

`EpisodeRef` carries `schemaVersion` even when embedded in a `RunManifest`, because §6.1 makes
it required and because an Episode is persisted independently (§7 `episode.json`).

## Evidence, 2026-08-19

This policy was asserted by fixtures for its first two minor versions. It has now been exercised
against real stored state by the first adopter integration, upgrading `1.2` → `1.3`:

- **37 stored `1.2` records across five workspaces, all classified `compatible`.** Read through
  the real stores — episode store, run store, run manifests, event logs, artifact reports, and the
  status service — with nothing migrated and nothing rewritten.
- **Manifests still reported `1.2` after a `1.3` runtime read them.** Silent restamping would have
  looked like success while destroying the evidence that the rule holds, so this is the specific
  property worth having checked.
- **The reverse direction was tested too**, which an upgrade cannot check afterwards: a real
  workspace copied, every `schemaVersion` restamped to the _next_ minor, and read back by the
  older runtime. Episode, runs, an eleven-event log, and `status` all read correctly.

The reverse direction is the half that matters when a Git-friendly `.aldus/` is shared between
machines on different builds — the situation §5.1's long pauses make ordinary — and it is the half
no fixture in this repository exercises, because every fixture is older than the build reading it.

A rule validated against real data is a different claim from a rule asserted, and this note exists
so a future reader can tell which one this is.

## Consequences

- One constant to reason about. A reader checks one field per document and knows whether the
  whole document is readable.
- A single version means a MAJOR change to any one record type bumps the version for all of
  them, and every fixture must be revisited. This is accepted: it makes breaking changes
  expensive and visible, which is the desired pressure at this stage.
- Non-strict object parsing (ADR-0002 decision 6) is what makes `forward` safe. If Core ever
  needs strict rejection of unknown fields, that is a MAJOR change to reader behaviour and
  needs its own ADR.
- Splitting into per-entity versions later is additive: pin each entity at the current value and
  bump them independently from then on. No stored record changes.

## Alternatives considered

- **Full semver (`MAJOR.MINOR.PATCH`).** Rejected: a schema has no patch-level change that is
  neither additive nor breaking. The third component would always be `0` or would be used to
  encode something the reader must ignore.
- **Per-entity schema versions.** Rejected as premature: eleven independently moving versions
  before a single one has moved once, and every cross-record consistency check would need a
  compatibility matrix.
- **Date-stamped versions (`2026-08-18`).** Rejected: ordering is clear but compatibility is
  not — nothing in a date says whether the change was breaking.
- **No version check, tolerate everything.** Rejected: violates §19.1, and silent mis-parsing of
  a renamed field is exactly the failure mode `schemaVersion` exists to prevent.
