# ADR-0041: An enumerated finding and an aggregate report are different evidence

- Status: Accepted
- Date: 2026-08-20
- Relates to: §12 Quality model, §12.1 Promotion, §12.3 Diagnosis taxonomy, §20 Production trace, ADR-0037
- Issue: #140

## Context

ADR-0037 gave a Stage a way to report findings instead of throwing. `EvaluationFinding` is **per
finding** — and the first adopter's wiring showed only one of their four checkers produces findings
at all.

Their structured linter returns findings with a severity, which maps cleanly. Their three vendored
linters return a **process result**: `{ linter, outcome, exitCode, stdout, stderr, argv }`. No
findings. The finest true thing their stage can say about one of them is _"this linter reported
something"_.

They declared a third finding class at run granularity and wrote the limitation into
`scopeLimitations`:

> a `vendored-report` finding means this linter had something to say and not that it found exactly
> one thing

Honest, and unreadable — prose in a field nothing parses. A consumer computing a defect rate counts
one such finding as one defect, and it might stand for forty.

They did not parse the vendored linters' stdout into per-finding shape **in the stage**, and the
reason matters, but not in the absolute form this ADR first recorded.

The first draft said their reason "generalises past their case": a parser over another program's
human-facing output is a second implementation of that program's semantics, with nothing keeping
the two in step and a silent failure mode the day a message changes. They then corrected it against
their own repository, which **has parsed all three vendored linters per finding since before this
ADR**, deliberately, under a section headed _"Why this parses stdout instead of calling a
function"_. Every number in their calibration record was produced that way.

The defensible principle is narrower and turns on **where the parse sits relative to the production
path**:

- In an **evaluation harness**, parsing is the only honest option. `@aldus-runtime/regression`
  does not run evaluators — outcomes are produced elsewhere — and measuring an evaluator against a
  corpus _requires_ per-finding granularity. There is no other way to ask a vendored program that
  prints and exits what it found. Their harness guards the direction that matters: it **refuses**
  when a checker reports a count it cannot then locate, because a silent parse failure would record
  "found nothing" for a checker that found something, which is the one error a calibration record
  must never make.
- In a **stage**, on the production path, the same parse decides what blocks a Run, and a wording
  change upstream would silently change enforcement.

So the rule is not "parsing is unsafe". It is that **a fragile parse is acceptable where its
failure is loud and offline, and unacceptable where its failure is silent and gates work.**

The absolute version is worth recording as a mistake rather than quietly narrowed: stated as
written, an adopter would conclude their measurement harness must not parse either, which would
leave them unable to calibrate anything they wrapped — the opposite of what §12.1 requires of them.

**My proposed fix was wrong, and the ruling says why.** I proposed `granularity?: "site" | "run"`:

> The distinction we need is not primarily spatial scope. It is whether the observation enumerates
> one defect occurrence or only reports that an evaluator triggered without enumerating its
> contents. "Site" versus "run" is insufficient. A document-wide omission may still be one
> enumerated defect, while a report about one file may contain an unknown number of defects.
> **Subject scope and statistical cardinality are orthogonal.**

I had modelled the wrong half of the adopter's own sentence — the scope, when the load-bearing part
was the countability.

## Decision

**Two closed semantics, discriminated, declared per channel.**

```ts
type EvaluationObservation =
  | { kind: "finding"; findingClass: string; message: string; category?: string; locator?: string }
  | { kind: "report"; findingClass: string; message: string };
```

An `AggregateReport` deliberately carries no `locator` and no `category`. It is not a defect that
happens to lack detail; it is the statement _"this evaluator had something to say"_, and giving it a
finding's fields would invite it to be counted as one.

### The channel declares which form it emits

`StageEvaluationChannel.evidenceKind` is `"enumerated_findings"` or `"aggregate_reports"`, and the
runner refuses an observation whose kind disagrees. Same principle as ADR-0037's enforcement: a
stage that could choose per result whether its output is countable could make a defect rate mean
whatever this run needed it to mean. Declared, it is reviewable before execution.

### Counting is where the distinction pays

- one `finding` counts as one enumerated finding;
- one `report` counts as one evaluator report and **never contributes 1 to a defect count**;
- the absence of parsed findings inside a report is **not zero defects**.

`countEvaluationEvidence` returns both counts plus `defectCountMeasurable`, which is `false`
whenever any report is present. A consumer computing a defect rate must treat that as unmeasurable
rather than substituting zero or the number of reports — both of which look plausible and are
wrong in a direction nobody checks.

### Blocking and countability are separate questions

Both forms trigger the channel's declared enforcement. A report that cannot be counted can still
stop work; an enumerated finding on an advisory channel still cannot. Conflating the two would make
"can we measure this" and "does this halt production" one decision, and they are not.

### Regression integration flags without fabricating

An outcome may carry `flagged: true` with an empty `findings` list. That is not a contradiction to
be repaired by inventing an entry — inventing one would make a report count as one defect, which is
the statistic this ADR exists to protect.

`CaseComparison.siteMetricsMeasurable` records that everything per site is unmeasurable for such a
case, and `SliceMetrics.unmeasurableSiteMetrics` counts them. This closed a live defect rather than
adding a field: with no evaluator categories to compare, `categoryMismatch` came out `false`, which
reads as _the categories agreed_. **An evaluator nobody measured scored a clean sheet, next to
numbers that mean something.**

### Compatibility runs one way

`EvaluationFinding` documented itself as one identified defect, so a record carrying it decodes as
an enumerated finding via `asEnumeratedFinding`. Nothing infers a report from an undiscriminated
record: a record written under the old meaning was never claiming to be one.

`scopeLimitations` stays. It records what an evaluator **cannot detect**, which is a different
question from whether one observation is enumerated or aggregate. I had those blurred.

### The measurability property is reachable from either end

The adopter checked whether the regression defect this ADR fixes had reached their numbers. It had
not: every flagged outcome across four recorded runs enumerates findings — 11 of 11, 14 of 14, 1 of
1, 1 of 1 — so `categoryMismatch` was never computed over an empty category set and their
calibration stands.

The reason is worth recording, because it was not foresight about this defect. Their harness
already refused to record a flag it could not localise, for its own reason: a silent parse failure
must never look like a clean checker. That refusal and this ADR's `siteMetricsMeasurable` prevent
the same state from opposite ends — one by declining to produce it, one by declining to score it —
which suggests the property is real rather than an artefact of where either of us happened to look.

## Consequences

- `StageOutcome`'s `evaluated` arm carries `observations` rather than `findings`, and
  `evidenceKind` is required on a channel. Both are compile-time breaks, shipped alongside
  ADR-0040's required `artifacts` so an adopter absorbs one break rather than two.
- A stage wrapping a legacy evaluator can now be honest without prose. The adopter's three vendored
  linters get an `aggregate_reports` channel, and their defect statistics stop silently including
  three numbers that were never defect counts.
- Something that was measurable-looking becomes explicitly unmeasurable. That is the point, and it
  will make some slices look worse — correctly, because they were never measured.

## Alternatives considered

- **`granularity?: "site" | "run"`.** Rejected in the ruling. Orthogonal to the property that
  matters, and optional, so absence would be one more unreadable silence.
- **Parse vendored output into findings, in the stage.** Rejected: on the production path a
  wording change upstream would silently change what blocks a Run, and the parser's count would be
  presented as the evaluator's. **Not** rejected in an evaluation harness, where the same parse is
  the only way to obtain the per-finding granularity calibration needs and its failure is loud and
  offline. See the narrowing above.
- **Let a report carry a `count` the adopter estimates.** Rejected. An estimated count is a number
  that will be summed, and the whole finding here is that a number nobody can verify gets used as
  though it were one.
