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

## Amendment, 2026-09-02: the rule is per record class, and both doors carry it

The #199 ruling ordered three things: close the reachability hole, then write down that the two
packages in this runtime answer the same event differently, then make the enforcing path say what it
dropped. The first landed with the decision above, in `core` only. This amendment records the other
two and closes the hole on the `regression` side.

**Same-major readability is a property of `core`'s records and not of `regression`'s.** Both stamp
`SCHEMA_VERSION`, and a record stamped one minor ahead of the reader is read differently:

| record stamped              | `core` — `validateRecord`, exported `*Schema` | `regression` — `parse*`, exported `*Schema`     |
| --------------------------- | --------------------------------------------- | ----------------------------------------------- |
| older, or the reader's own  | read; `compatibility: "compatible"`           | read; `compareSchemaVersion` says `older`       |
| **newer minor**, same major | **read**; `compatibility: "forward"`          | **refused**, `ALDUS_SCHEMA_VERSION_UNSUPPORTED` |
| different major             | refused, `ALDUS_SCHEMA_VERSION_UNSUPPORTED`   | refused, `ALDUS_SCHEMA_VERSION_UNSUPPORTED`     |

The divergence follows from a second difference, and that is why it is a decision rather than a
defect. `core`'s object schemas strip unknown properties (ADR-0002 decision 6), which is what makes
a `forward` read possible at all: an older reader can accept a newer artifact. `regression`'s two
record schemas are `.strict()` (#186, ADR-0051), because a corpus whose fields silently vanish is a
wrong number rather than a wrong record — so a newer minor would fail on its added keys anyway, and
refusing on the version names the reason instead of reporting a field error about a field the reader
has never heard of. Converging either way gives something up: major-only in `regression` gives up
what #186 bought; refuse-newer in `core` makes every additive change breaking for older readers,
which is the case ADR-0003 exists to support. Neither is taken. **The rule is stated per record
class, and a consumer must not infer one package's behaviour from the other's.**

**Both `regression` doors now carry `regression`'s rule.** `defectCorpusSchema.safeParse` and
`evaluatorRunSchema.safeParse` accepted a newer minor and a foreign major that `parseDefectCorpus`
and `parseEvaluatorRun` refused — the same shape as the `core` finding above, on the same day, and
measured then rather than fixed. The `schemaVersion` field of both schemas is refined to refuse a
newer version, and the parse functions check the version **before** the shape so a newer record
still fails with one `ALDUS_SCHEMA_VERSION_UNSUPPORTED` rather than a field issue. No base/guarded
split is needed here: `regression` has no `supported` parameter to preserve.
`packages/aldus-regression/test/exported-schemas-carry-the-rule.test.ts` enumerates the exports
dynamically, as the `core` test does, and pins the count at two so a third door cannot appear
unexamined.

**The enforcing path says what it dropped.** `validateRecord` and `assertValidRecord` return
`droppedPaths` — the paths of properties the record carried and this build's schema does not
declare — whenever the parse discarded something, on any compatibility. `compatibility: "forward"`
told a caller the record came from a newer build; it did not tell them what they lost. Paths only,
never values (§19.2): the value under a dropped key is the thing this build cannot interpret. A
dropped subtree is reported once at its root, because its interior is the other build's schema and
not this one's. The field is absent rather than empty when nothing was dropped, so its presence is
the signal. Whether to persist those paths is the caller's question, and the stage runner's answer
to the analogous one (#255) is a reason to think before writing a caller-supplied key into a durable
record.

## Consequences

A record with a foreign major now throws where it previously parsed, through the exported schemas
as well as through `validateRecord`. That is a behaviour change and is in the CHANGELOG as one.

A `regression` record newer than the reader now fails through the exported schemas as well as
through `parseDefectCorpus` and `parseEvaluatorRun`. Also a behaviour change, also in the CHANGELOG.

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
