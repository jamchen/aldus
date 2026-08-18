# ADR-0004: Event envelope placement and forward-record writes

- Status: Accepted
- Date: 2026-08-18
- Closes: the two cross-cutting questions raised on issue #3
- Relates to: §6.4 Event log, §7 Storage contracts, §19.1 Reliability, ADR-0002, ADR-0003

## Context

WP-01 deliberately did not define the event envelope that §6.4 requires, on the grounds that it
belongs with the store that writes it. Two things have since made that the wrong call:

1. **More than one work package needs it.** WP-02 writes events, but WP-03 (artifact lineage),
   WP-04 (stage lifecycle events), and WP-05 (gate decisions) all _emit_ them. If the envelope
   lives in the file store, every one of those packages depends on a storage implementation to
   describe a domain fact — the exact inversion §7 exists to prevent ("Core models MUST be
   independent of physical storage").
2. **It blocks parallel work.** WP-03 cannot start against an envelope that does not exist yet.

The second open question is the one ADR-0002 decision 7 deferred. Zod objects **strip** unknown
properties on parse. So when a build reads a record written by a newer minor version, validates
it, mutates it, and writes it back, the newer version's fields are silently gone. ADR-0003 calls
a newer minor version `forward` and explicitly _readable_; nothing yet says what happens on the
write half of that cycle.

This matters concretely because §7's recommended layout puts state in a Git-friendly `.aldus/`
directory, and §5.1 notes long pauses between stages are normal. A workspace shared between two
machines on different builds is an ordinary situation, not an edge case.

## Decision

### 1. The event envelope is a Core schema

`AldusEvent` joins the Core schema registry, alongside the eleven WP-01 types. Storage
implementations consume it; they do not define it.

Its field list implements §6.4's requirement list directly. Two shape choices are worth naming:

- **`action` is an open string, not an enum.** §11 makes workflows adopter-supplied and §4.2
  keeps adopter concepts out of Core, so Core cannot enumerate the actions an adopter's stages
  perform. A `<subject>.<verb>` convention is documented and unenforced.
- **`sequence` is optional.** §6.4 does not require it, and ULIDs already sort by creation time
  _within one process_. Two concurrent sessions in one workspace do not share that guarantee, so
  a store may well need a per-run monotonic sequence — but a store can always populate an
  optional field and enforce its presence on read, whereas promoting an optional field to
  required later is a MAJOR bump under ADR-0003. Optional is the smaller reversible option.

### 2. Adding a record type is a MINOR bump

`SCHEMA_VERSION` moves from `1.0` to `1.1`. Adding a type changes no existing record's shape, so
every `1.0` record stays readable — which is precisely what ADR-0003's same-major rule promises.
The WP-01 fixture corpus stays pinned at `1.0` and must keep validating unchanged; that is the
test that proves the rule rather than asserting it.

### 3. A store MUST preserve unknown properties across a read-modify-write

When a store reads a record classified `forward` (ADR-0003), it MUST retain the raw parsed JSON
and re-merge validated changes over it on write, so that properties belonging to a newer minor
version survive the round trip.

Refusing to write `forward` records was the alternative and is rejected: it would leave an older
build unable to record a stage attempt at all against a workspace another machine had touched,
turning a routine version skew into a hard stop. Preservation costs a retained reference and a
shallow merge.

The store is where this is enforced, because the store is the only component that performs the
full read-modify-write cycle. `validateRecord()` already returns the compatibility
classification, so a store has what it needs without new Core machinery.

## Consequences

- WP-03, WP-04, and WP-05 can be specified against `AldusEvent` before any store exists.
- The version bump exercises ADR-0003 end to end on a real change rather than a hypothetical.
  Every emitted JSON Schema `$id` becomes `urn:aldus:schema:1.1:<Name>`; that churn is the
  honest signal that the schema set changed.
- Decision 3 is a requirement on implementations, not something Core's types can enforce. WP-02
  must test it explicitly: read a record carrying an unknown property, mutate a known field,
  write, and assert the unknown property survived.
- A store that ignores decision 3 loses data silently rather than loudly. That asymmetry is why
  it is written down as a MUST here rather than left as implementation taste.

## Alternatives considered

- **Envelope in `aldus-file-store`.** Rejected: makes domain packages depend on a storage
  implementation, contradicting §7.
- **Envelope in a standalone `aldus-events` package.** Rejected as premature: one small schema
  does not justify a package, and §21's recommended layout does not include one.
- **Refuse to write `forward` records.** Rejected: see decision 3.
- **Make `sequence` required now.** Rejected: unrequired by §6.4, and if it proves unnecessary
  the cost of removing it is a MAJOR bump.
