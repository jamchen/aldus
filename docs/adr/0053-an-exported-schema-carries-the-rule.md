# ADR-0053: An exported schema carries the rule

- Status: Accepted
- Date: 2026-08-25
- Relates to: §4.3 Dependency direction, ADR-0002, ADR-0003, ADR-0004, #199

## Context

`checkSchemaVersion` classified a differing major as `incompatible` and `assertSchemaVersionReadable`
threw on it. Both were correct, and both were reached from exactly two call sites: `validate.ts` and
the artifact store.

Every versioned schema object is also exported from the package index, and `safeParse` called
neither. So `artifactRefSchema.safeParse` accepted a `2.0` record this build cannot interpret while
`assertValidRecord` refused the same bytes. **Which guarantee a caller got depended on which door
they came through, and the exported object is the obvious door.**

A rule enforced at one entry point and not the other is not a rule; it is a rule plus a bypass, and
the bypass was on the public surface of a published package.

Two measurements, taken by different sessions through different entry points, read as a
contradiction until the doors were named — which is the same failure one level up.

## Decision

One combinator, `withForeignMajorRefused`, applied in one block in the schema barrel. Twenty-two
hand-written refinements would be twenty-two chances to write it slightly differently, and the
differences would be invisible.

**Refined on the `schemaVersion` field, not on the object.** An object-level `.check()` does not run
when the shape has already failed, so a record missing an unrelated field would slip past the
version rule — and worse, a test probing the guard with an incomplete fixture would see it fail for
the wrong reason and report the guard as working. That was measured, not reasoned: the first
implementation was object-level and the conformance test failed all eleven schemas because the
probe's other fields were absent.

**The unguarded `*SchemaBase` exports remain**, because `validateRecord(name, data, supported)`
takes the supported version as a parameter — reading records written for a different build is a
supported case, and a field-level refinement has no context, so it can only bake in
`SCHEMA_VERSION`. The registry holds the bases; the exported names are guarded.

A newer **minor** still passes. Refusing one would make every additive change breaking for older
readers, which is the case ADR-0003 exists to support, and `assertValidRecord` already reports such
a record as `compatibility: "forward"`.

`packages/aldus-core/test/exported-schemas-carry-the-rule.test.ts` **enumerates the exports
dynamically**. This is what makes the design safe rather than merely correct: a hand-written list
needs exactly the attention it exists to remove, because a maintainer who forgets to guard a new
schema forgets the list entry too and the suite stays green. Exemptions live in a named allowlist
with reasons, so they are few and visible rather than absent and unbounded.

**It worked immediately.** The sweep found `spendReservationSchema` and
`spendReservationTransitionSchema` — two exported schemas carrying `schemaVersion` that are not in
`coreSchemas` and that a hand-written list would have missed.

## Consequences

A record with a foreign major now throws where it previously parsed, through the exported schemas
as well as through `validateRecord`. That is a behaviour change and is in the CHANGELOG as one.

Composition is unaffected: `.safeExtend()` preserves `ZodObject`, so `.shape`, `.extend` and
`.pick` still work on an exported schema.

`breaking-notes` does not catch this change. No signature is removed and nothing becomes newly
required — it is a semantic break, the blind spot already recorded in `CLAUDE.md`, and the BREAKING
entry was written by hand rather than prompted.

## Alternatives rejected

**Refining the shared `schemaVersionString` field** — one line, eleven schemas, and it breaks
`validateRecord`'s `supported` parameter by baking a constant into the one place the API made
variable. Tried, measured against the existing test, reverted.

**Dropping the parse-ready exports** — a larger break, and it removes something adopters
legitimately compose with. The problem was never that they are exported; it is that the exported
ones carried no rule. Fix the door, keep the door.
