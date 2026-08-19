# ADR-0031: Derive prose about the program from the program

- Status: Accepted
- Date: 2026-08-19
- Relates to: §20 Production trace, §24 V1 definition of done, ADR-0003, ADR-0030

## Context

ADR-0030 is about a runtime that holds a fact and either does not say it or says it wrongly, and
what that costs an operator. This ADR is the same failure aimed at a different reader: a
**maintainer**, misled by a comment or a document rather than by a message.

It was deferred until a second instance existed. Five arrived together.

The first came out of the `registerOutput` migration. The adopter's comment said their digest
comparison "keys on `sha256`" — ambiguous between _hashes the bytes_ and _reads the digest off the
record_. I read it the second way and warned them their cross-check had become a check of the
registry against itself. The code had always hashed the bytes independently; the comment was
wrong, and it was wrong in three separate documents. I inferred behaviour from prose instead of
code and was wrong, which is the mistake this ADR exists to make less available.

Searching for more of it in the adopter's repository found four, all the same class — **true when
written, quietly false later**:

| Statement                                               | Why it went false                           |
| ------------------------------------------------------- | ------------------------------------------- |
| README and RUNBOOK: "the pin is `0.1.0`"                | the pin moved                               |
| Upgrade report: "once #45 lands"                        | #45 landed                                  |
| Upgrade report: "a 1.3 record read by this 1.2 runtime" | the runtime was 1.3, restamping to 1.4      |
| AF-3 and INVENTORY: shadow comparison "keys on sha256"  | ambiguous from the start, then read wrongly |

Note which way round the failure runs. In every case **the code was correct and its description
was not**, which is the more expensive orientation: a maintainer reconciling the two has no reason
to assume the prose is the broken half, and the repair they reach for is to change the code.

## Decision

**A statement about the program's behaviour that the program can compute MUST be computed, not
restated.**

The distinguishing observation, and the reason this is a rule rather than an exhortation:

> The drift was in the strings that were hardcoded, and absent from the strings that were
> computed.

Once the adopter's upgrade report drew its version strings from `SCHEMA_VERSION`, it became unable
to describe an upgrade that had already happened. Not because anyone remembered to update it —
because the sentence no longer contained a fact anyone could forget.

This gives a sharper rule than "keep documentation current", which is a request for diligence and
therefore fails on exactly the days it matters:

1. **Prose rots at the rate you restate facts the program already knows.** Version numbers,
   dependency pins, issue states, counts, file paths, and enumerations of supported values are all
   facts with an owner in the code. Restating one creates a second owner and no mechanism to keep
   them agreeing.
2. **Where a fact cannot be computed into the prose, assert it in a test.** The ADR index test,
   the licensing test, the release-metadata test, and the package-dependency test all exist for
   this reason: each pins a statement made in prose to the state it describes. That is the same
   move as interpolation, taken where interpolation is not available.
3. **A comment that explains _why_ something is safe outranks one that restates _what_ the code
   does.** The restatement is the part that goes stale and the part the code already says. The
   reason is the part that is nowhere else, and it is what stops a later contributor "fixing" a
   correct implementation.

## Amendment, 2026-08-19: which artifact the reader trusts

The rule above is stated for prose, because that is where all five instances lived. Two things
found immediately afterwards show the class is wider, and give it a sharper edge.

### The cost is set by trust, not by wrongness

Two failures on the same axis, from the same week:

- I read a failing test as a possible runtime finding. My test was wrong — deterministic builders
  collided on an id and the store correctly refused to overwrite an append-only record. Had I
  believed myself, I would have gone and changed a correct runtime.
- The adopter had a comment that was wrong about correct code. A maintainer reconciling the two
  reaches for the code, because prose is not what they distrust.

The adopter's statement of what the two have in common:

> The expensive direction is whichever artifact the reader trusts more, not whichever one is
> wrong.

That is the operative principle, and it is why "keep documentation current" is the wrong frame.
The damage is not proportional to how false a statement is; it is proportional to the authority of
the thing making it. A comment carries the authority of having been written by someone who knew.
A passing test carries the authority of having run.

### The stale artifact need not be prose

#74 is a third instance, and the reader that was misled is a program rather than a person.
`executeCleanup` trusted a `CleanupPlan` — computed correctly, `safe` honestly true, never wrong
about the artifact it cleared — and deleted a working file the plan had never examined, because a
re-take had been registered at the same path in between. The bytes were `irreplaceable`.

The plan is the same failure as a comment that was true when written: an artifact describing the
world, correct at the moment of writing, consulted after the world moved. The difference is the
reader.

> Programs do not notice the way a maintainer eventually does.

A maintainer who reads a stale comment for long enough usually trips over the contradiction. A
program re-reads a stale structure with undiminished confidence every time. So where the consumer
is code, the mitigation cannot be clearer writing — the fact has to be **re-derived at the point
of use**, which is what #74's fix does by re-hashing every file against its record immediately
before deleting it.

That is the same decision as the rule above, applied one level down: do not restate a fact the
program can compute — and where the restatement is unavoidable because it was computed earlier,
recompute it at the moment it is acted on.

## Amendment, 2026-08-19: what derivation costs, and a third reader

Two more from the adopter, one of which is a limit on the decision above rather than support for
it.

### Deriving a value can weaken the check the constant was carrying

Their pin checker held a hardcoded `ALDUS_VERSION`, so bumping the pin made the checker fail
against the very version it was enforcing — exactly the defect this ADR names. They fixed it the
way the decision says to: derive the expected version as the value every `@aldus-runtime/*`
dependency agrees on.

But agreement is a weaker property than correctness, and the difference is a real hole. **A
uniformly wrong value looks exactly like consensus.** If every pin drifts to a floating range
together, a checker that asks "do they agree?" says yes. The hardcoded constant, for all its
staleness, was asserting something agreement cannot: that the pins are _exact_ and _this specific
value_.

So the rule needs its own caveat, and it is the part most likely to be got wrong by someone
applying this ADR enthusiastically:

> "Derive it from the data" quietly weakens a check unless you keep the property the constant was
> carrying.

Their replacement keeps it by checking exactness separately from agreement, and is mutation-tested
through all four paths — partial bump, floating range, local link, and uniformly-floating pins.
That last case is the one agreement alone cannot see, and the one worth naming, because it is
invisible in every test that does not deliberately construct it.

The general form: when replacing a restated fact with a computed one, enumerate what the
restatement was asserting. Some of it is usually not in the derivation, and that part needs
saying another way.

### A third reader: the build

The amendment above distinguishes a maintainer misled by prose from a program misled by a data
structure. There is a third case, and this repository had it undetected.

`aldus-e2e` composes the workspace through package entry points, which resolve to `dist/`. Editing
a source file and running those tests directly exercises the _previous_ build and reports green.
The stale artifact is a build; the reader it misleads is a person; and the authority it carries is
the strongest of the three, because a passing test is what people trust most.

What makes it worse than a stale comment is the indistinguishability:

> A mutation that was never loaded and a mutation that had no effect produce identical output.

The comfortable readings — "the guard is unnecessary", "my test is weak" — are both wrong in the
same direction, and the result contains nothing that points at the real cause. The adopter hit
this twice in one migration, and notes that both times the wrong conclusion was the comfortable
one. That is the argument for a mechanical tripwire over more care, and it is the same argument
their workspace near-miss made: care was available and did not generalise.

`packages/aldus-e2e/test/fresh-build.test.ts` is the tripwire, and it was proven against the real
scenario before being trusted — an unbuilt edit fails and names the package.

## Consequences

- Some prose becomes less readable to gain this. A sentence carrying an interpolated constant
  reads worse than one carrying a literal. That is the trade, and it is worth it wherever the
  literal would otherwise outlive its truth.
- This does not license removing explanation. The target is **restatement of computable facts**,
  not exposition. An ADR explaining a decision, a comment giving a rationale, and a runbook
  describing intent are all outside it.
- It applies to this repository's own documents. `docs/ALDUS-ARCHITECTURE.md` is checked against
  the implemented schemas by `contract-conformance.test.ts` precisely because a contract restated
  in prose would otherwise drift from the code claiming to implement it — that test is this ADR
  applied before this ADR was written.
- The failure mode has no detector of its own. Nothing here proposes one, because a general "is
  this comment still true" check is not a thing that can be written. What is available is
  narrowing the surface: fewer restated facts means fewer places for the drift to live.

## Alternatives considered

- **A documentation review step before release.** Rejected as a substitute rather than as a bad
  idea. Every one of the five statements above would have passed a review by whoever wrote it,
  because each was true when written and the reviewer's memory of writing it is the thing that
  went stale.
- **Treat this as part of ADR-0030.** Rejected deliberately, and the boundary is the reader. ADR-0030
  is about an operator acting on what the runtime tells them at the moment they act; this is about
  a maintainer acting on what a document tells them long after it was written. Folding them
  together would blur an ADR that currently states one thing clearly, and the fixes differ:
  ADR-0030's is to say more, this one's is to restate less.
- **Ban comments describing behaviour.** Rejected as over-correction. A comment stating what
  non-obvious code does is worth its maintenance cost; the rule is that a fact the program can
  produce should be produced rather than transcribed.
