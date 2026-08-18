# ADR-0010: Evaluator promotion evidence

- Status: Accepted
- Date: 2026-08-18
- Closes: architecture contract §25 item 9 (minimum evaluator evidence required to promote an advisory check to a hard gate)
- Relates to: §12 Quality model, §12.1 Evaluator promotion policy, §12.3, §12.4, §9.3, §13, §24, ADR-0006

## Context

§12 defines four quality levels and closes with a rule that governs everything below it:
"Machine pass MUST NOT be presented as semantic correctness." §12.1 permits an evaluator to move
from advisory to blocking "only after it is calibrated against human-labeled examples", and lists
what promotion should consider: recall, false-positive rate, severity-weighted false negatives,
asymmetric harm caused by unnecessary automatic correction, show/host/voice/model/script-form
scope, and known blind spots.

What §12.1 does not say is **how much** evidence is enough. §25 item 9 records that as open.

Five things are underdetermined, and each shapes either a public API or a decision an operator
will make about real money and published content:

1. Is promotion a property of an evaluator, or of an evaluator _within a scope_?
2. What does a whole-corpus number mean when §12.1 requires scope be considered?
3. How is "asymmetric harm caused by unnecessary automatic correction" measured, given that it
   is listed **separately** from the false-positive rate?
4. What are the actual thresholds?
5. What happens when a metric cannot be computed at all?

## Decision

### 1. Promotion is always scoped; there is no unscoped promotion

No API returns "this evaluator is promotable". `PromotionVerdict` carries `promotableScopes` and
`blockedScopes`, and a caller must pick a scope to act on.

§12.1 lists scope dimensions for a reason: calibration does not generalise. An evaluator tuned on
one host's cadence says nothing about another's; one calibrated against a single voice says
nothing about a second voice's artefacts. A boolean `promotable` would be an invitation to apply
evidence from one scope to a different one, which is exactly the mistake §12.1's list is there to
prevent.

The corollary is that a corpus declaring no scope dimensions yields **no promotion decision at
all** — not a positive one. `isPromotableEverywhereMeasured` therefore requires at least one
measured slice, because an empty slice list would otherwise satisfy `Array.every` and read as
universal approval.

### 2. Slicing defaults to one dimension at a time

The default is one slice per observed dimension value — one per distinct `host`, one per distinct
`voice` — not the cross-product. With five dimensions a corpus shatters into slices of one or two
cases, and a metric over two cases is noise that reads like evidence. A caller who genuinely wants
a joint slice passes the grouping explicitly, which makes combinatorial slicing a deliberate
request rather than an accident.

A case that does not declare every dimension in a grouping is omitted from that grouping's slices
rather than being placed under a substituted value. Inventing a scope the labeller never asserted
would put a case forward as evidence about something nobody recorded for it.

Scope is `Record<string, string>` throughout, consistent with Knowledge Pack scope (ADR-0006).
§12.1's list is illustrative and §4.2 forbids Core from naming a provider.

### 3. The whole-corpus figure is descriptive and gets no vote

Metrics are computed over the whole corpus and reported. **No threshold is applied to them.**

This is the strongest available answer to the failure mode in question 2. An evaluator can be
excellent across a corpus and useless on one host inside it; if the aggregate could satisfy a
threshold, that evaluator would read as promotable. Giving the aggregate no vote makes that
impossible by construction rather than by the report's tone.

Two supports go with it:

- `PromotionVerdict.aggregateFlattersWorstScope` is set when the whole-corpus agreement figure
  exceeds the worst slice's, and the rendered report prints a warning saying so in words.
- `renderPromotionReport` prints every scope **before** the aggregate and labels the aggregate
  "descriptive only". Ordering is part of the guarantee: a summary at the top is the one people
  quote.

### 4. Unnecessary-correction harm is measured separately from the false-positive rate

§12.1 lists them as distinct considerations, and §12.4's repair ladder explains why: a spurious
flag that regenerates one TTS segment costs a request, while a spurious flag that revises
narration invalidates the Content Freeze and every approval downstream of it (§13.1). Charging
both to one precision figure would hide precisely the asymmetry §12.1 asks to be weighed.

So a case names the **correction class** a flag would trigger, the policy assigns each class a
harm weight, and `meanUnnecessaryCorrectionHarm` has its own threshold. An evaluator can clear the
false-positive rate and still be blocked because its few false positives are expensive. Default
weights transcribe §12.4's ladder, from `advisory: 0` to `reviseNarration: 10`.

Severity weighting works the same way and for the same reason: §12.1 asks for severity-weighted
false negatives, not a count, because a missed unsupported claim and a missed cosmetic wobble are
not one unit of the same currency.

### 5. Unweighted severities and unknown correction classes are refused, not defaulted

A severity the policy assigns no weight to raises `ALDUS_SEVERITY_UNWEIGHTED`. Defaulting it to
zero would silently drop every case at that severity out of severity-weighted recall while the
metric still printed a plausible number — a wrong answer that looks like a right one is worse than
an error.

### 6. An unmeasurable metric is a shortfall, never a pass

A slice with no defective cases has undefined recall. Treating undefined as satisfied would
promote an evaluator that was never tested against a single defect. Every unmeasurable metric
produces an explicit `unmeasurable` shortfall naming what could not be computed and why.

### 7. An open blind spot disqualifies, regardless of metrics

§12.1 lists "known blind spots" alongside the numeric considerations. A blind spot is by
definition a failure the corpus did not sample, so good corpus metrics are not evidence against
it — they are evidence that the corpus did not look. `openBlindSpotDisqualifies` defaults to
`true`.

Blind spots are scoped, and one scoped to a single voice disqualifies only the slices covering
that voice. A blind spot applies to a slice when everything it scopes itself to is either held at
the same value by the slice or not held by the slice at all — so a voice-scoped blind spot does
apply to the whole-corpus slice, because the whole corpus contains that voice.

`mitigated` and `accepted` are distinct: the first is a fix, the second is a standing decision to
tolerate. Both stay listed so tolerating one remains visible rather than forgotten.

`KnowledgePackManifest.negativeKnowledge` (WP-09) holds resource _paths_ Core never parses (§1.2,
§9.1). This registry holds the structured records a policy can evaluate. They are complementary,
not duplicates.

### 8. The default thresholds, and their honesty requirement

Closing §25 item 9:

| Threshold                      | Default | Why                                                                                                                                                                                                         |
| ------------------------------ | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `minCases`                     | 50      | Below this a slice's rates move by whole percentage points per case.                                                                                                                                        |
| `minDefectiveCases`            | 20      | Recall over three positives is not a measurement.                                                                                                                                                           |
| `minCleanCases`                | 20      | Without clean cases the false-positive rate is unconstrained.                                                                                                                                               |
| `minRecall`                    | 0.95    | A blocking evaluator that misses defects is worse than an advisory one, because §12 warns that a machine pass must not be read as correctness — and a hard gate that passes is exactly such a presentation. |
| `minSeverityWeightedRecall`    | 0.98    | Higher than plain recall: what it misses matters more than how often.                                                                                                                                       |
| `maxFalsePositiveRate`         | 0.05    | Above this, operators learn to dismiss the gate.                                                                                                                                                            |
| `maxUnnecessaryCorrectionHarm` | 0.1     | Mean harm per clean case, on §12.4's ladder.                                                                                                                                                                |
| `minLabellers`                 | 1       | A floor, not a recommendation — see below.                                                                                                                                                                  |

**These defaults are uncalibrated.** Nobody has run a real corpus through them. They are chosen to
fail closed, and that is the only claim made for them. Every verdict therefore carries
`policyOrigin`, and a verdict measured against the defaults prints a note saying the bar itself is
provisional. §12 demands honesty about what a number means; a threshold presented as authoritative
when nothing validated it would be the same failure one level up.

`minLabellers` defaults to 1 and is documented as a floor rather than a recommendation: a
single-labeller corpus has no inter-rater signal at all, so its labels are one person's judgement
presented as an oracle. It is left at 1 because refusing every single-labeller corpus would block
adoption before a second labeller exists, and raising it is a one-line change once one does.

### 9. The report's language is a design constraint

§12's rule binds hardest where numbers become prose. Three rules, each pinned by a test:

- The aggregate is never rendered without the per-scope breakdown, and appears after it.
- No word implying correctness — `accurate`, `correct`, `proven`, `verified`, `guarantees`. The
  metric is named `agreementWithHumanLabels`, and there is no `accuracy` field anywhere. The
  forbidden list is exported so the test and the implementation cannot drift.
- A blocked slice lists every shortfall with observed and required values. "0.94" tells nobody
  whether to promote.

The standing caveat also states that scopes absent from the corpus were not evaluated and must not
be assumed covered — the limit a reader is least likely to infer unaided.

## Consequences

- An adopter must supply severity weights; there is no default scale, because levels are
  caller-named and inventing an ordering would be guessing at their meaning.
- A corpus without scope dimensions can never promote anything. That is intended, and the report
  says so in words rather than returning a confusing empty result.
- Because promotion is per scope, an evaluator may be blocking for one host and advisory for
  another simultaneously. The gate engine (WP-05) must be able to represent that; it already
  models advisory and blocking as distinct states rather than a boolean.
- Harm weights are opinions expressed as numbers. Two adopters weighing `reviseNarration`
  differently will get different verdicts from identical evaluator behaviour. That is correct —
  the cost of an unnecessary rewrite genuinely differs between productions — but it means a
  verdict is not portable between adopters without its policy.
- Nothing here runs an evaluator, so this package cannot tell whether a corpus is representative
  of production. §24's "representative defect corpus" remains a human judgement.

## Alternatives considered

- **A single `promotable: boolean` on the evaluator.** Rejected: it invites applying evidence from
  one scope to another, which §12.1's scope list exists to prevent.
- **Apply thresholds to the whole-corpus metrics, with per-scope figures as supporting detail.**
  Rejected: this is the exact failure mode §12.1 warns about, and it is the natural design if
  scope is treated as reporting rather than as the unit of decision.
- **Emit no aggregate at all.** Considered seriously — it would make the failure impossible rather
  than merely unhelpful. Rejected because a reader legitimately needs the corpus's shape, and
  withholding it invites people to compute it themselves without the warning.
- **Fold correction harm into precision by weighting false positives.** Rejected: §12.1 lists the
  two separately, and a single blended figure cannot distinguish "flags often, harmlessly" from
  "flags rarely, catastrophically".
- **Default an unweighted severity to zero.** Rejected: it produces a plausible number computed
  over a silently truncated set.
- **Treat an unmeasurable metric as satisfied.** Rejected: it promotes an evaluator that was never
  tested on a defect.
- **Enumerate §12.3's diagnosis taxonomy as a union type.** Rejected: §12.3 introduces it with
  "for example", and §4.2 keeps adopter vocabularies out of the runtime — the same reasoning as
  ADR-0006's rejection of enumerated scope dimensions.
- **Let good metrics override an open blind spot.** Rejected: the corpus is the thing that failed
  to sample the blind spot, so its metrics cannot be evidence about it.
- **Publish the thresholds without flagging them as uncalibrated.** Rejected: it would repeat, at
  the level of the bar itself, the error §12 forbids at the level of the evaluator.
