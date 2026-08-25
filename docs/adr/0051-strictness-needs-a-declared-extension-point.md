# ADR-0051: Strictness needs a declared extension point

- Status: Accepted
- Date: 2026-08-25
- Relates to: §4.2 Boundary, §12.1 Regression, ADR-0002, ADR-0003, #186

## Context

`0.2.0-next.21` made `defectCorpusSchema` and `evaluatorRunSchema` strict, so an undeclared key is
refused rather than stripped. The reason was sound and is unchanged: a record written by a later
runtime used to parse with its added fields silently discarded, handing the caller an object that
looked complete and was not — a read path returning a wrong answer with no signal.

The first adopter to bump reported that this broke their corpus, and the report was better than a
bug: the sibling key was **deliberate and documented**. Their corpus carried a top-level
`labelProvenance`, their own documentation said it was stripped by the schema, and their reader
took it off the raw JSON precisely because the parse discarded it. No data was ever silently lost;
the reader was correct. What strictness removed was a documented extension point, and the migration
on offer — split the file — weakens the property the single file existed for: the provenance of a
label belongs beside the label, versioned together, because a label whose source lives in another
file is one refactor from a label with no source.

Two facts made the original change look more settled than it was. **No other Core schema is
strict** — `WorkflowEvent.details` and `SpendReservationTransition.detail` are both
`Record<string, unknown>`, which is the existing convention for data Core does not interpret. And
the argument for strictness is about _the runtime's_ future fields, which was applied to _an
adopter's_ data without the distinction being noticed.

## Decision

Both record schemas gain an optional, declared `metadata: Record<string, unknown>`. Core never
interprets it.

Strictness stays. The two cases are separated rather than collapsed:

- an **undeclared** key is refused, because it may be a later runtime's field and this runtime
  cannot know what it means;
- a **declared** extension point is preserved through the parse.

That second half is strictly better than what it replaces. The sibling-key arrangement survived
only because readers went around the parser to the raw JSON; a declared field is readable through
it, so the adopter's reader gets simpler rather than more complex.

Additive and optional, so a MINOR bump under ADR-0003: `SCHEMA_VERSION` 1.11 → 1.12. No existing
record becomes invalid.

## Consequences

An adopter migrating from a sibling key moves it under `metadata` and can then read it through the
parser. An adopter with no extension data changes nothing.

**This does not settle strictness for Core's other schemas.** They remain non-strict, and the
inconsistency is real: either strictness is right everywhere and Core should follow, or the corpus
schemas are an outlier justified by being the records most often written by one runtime version and
read by another. That question is deferred rather than answered here, because nothing has forced
it — and under the current product gate, a contract question with no adopter reproduction behind it
is one to leave open.

## Alternatives rejected

**Relax strictness.** It would restore the silent-drop defect, which is the more serious of the two
failures — a wrong answer with no signal beats a refusal every time, in the wrong direction.

**Tell the adopter to split the file.** Correct-sounding and wrong: it trades a real invariant
(source travels with label) for a schema convenience, and it is a migration that makes their code
worse in order to keep ours unchanged.

**An `x-` prefix convention.** Encodes the extension point in a naming rule nothing enforces, which
is the shape of guarantee this project has repeatedly found to be decorative. A declared field is
checkable; a prefix convention is a habit.
