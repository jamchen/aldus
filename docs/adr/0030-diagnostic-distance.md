# ADR-0030: Rank diagnostic work by distance from symptom to cause

- Status: Accepted
- Date: 2026-08-18
- Relates to: §20 Production trace, §24 V1 definition of done, ADR-0024, ADR-0025, ADR-0029

## Context

The first real adopter integration surfaced five defects in a week. Four shared a shape, which
only became visible once they were seen together:

| Defect                                                      | The fact the runtime had        | Where the symptom appeared            |
| ----------------------------------------------------------- | ------------------------------- | ------------------------------------- |
| A config key the loader did not recognise was dropped       | the key was unknown             | `status` reported a wrong next action |
| `--workspace` was invisible to the config module            | the resolved workspace          | `ALDUS_STAGE_NOT_REGISTERED`          |
| A block reason could not distinguish enforced from advisory | which gates a stage declared    | a stage refused with no way out       |
| A gate with no subjects reported as merely undecided        | the subjects provider was empty | "decide the gate", forever            |

In every case **the runtime held the fact and did not say it.** None was a computation it could
not perform; each was a sentence it did not write.

The adopter's measurement is what turns this from an observation into a rule:

> Every one of them cost me time proportional to the **distance between where the fact lived and
> where the symptom appeared**, not to how subtle the fact was. The dropped config key was the
> worst, and it was also the simplest fact in the set. The gate-subject cycles were the most
> conceptually involved and cost the least, because once enforcement fired I was looking at the
> right place.

## Decision

**When ranking work on this class of defect, rank by distance from symptom to cause, not by
subtlety of the underlying problem.**

Two consequences follow, and they are the operative part:

1. **A refusal states what it knows.** If the runtime can distinguish two situations that produce
   the same message, it says which one this is — even when the distinction is only occasionally
   load-bearing. "You have not decided this gate" and "this gate cannot be decided yet" are
   different sentences, and an operator can act on exactly one of them.
2. **An input that is accepted and then ignored is a defect**, not a convenience. Silently
   dropping an unrecognised config key, a flag the loader never sees, or an option a constructor
   forgets to copy all produce a symptom arbitrarily far from the cause. Refusing loudly at the
   point of the mistake is cheaper than any amount of downstream diagnosis.

This is the operational form of §20's requirement that production trace answer _what happened_ and
_what can be retried safely_. A trace that records the facts but cannot present the one that
explains the current refusal satisfies the letter and not the purpose.

## Consequences

- Fixes that only improve a message are worth prioritising against fixes that change behaviour.
  That is counter-intuitive — a message change looks cosmetic on a board — and it is precisely
  the ranking this ADR exists to make defensible.
- Over-reporting has a real cost, which bounds this: a hint shown when it does not apply becomes
  noise an operator learns to skip, and then it fails on the day it matters. Each distinction
  must be reported only when it actually holds. The gate-undecidability message is emitted only
  when the subjects provider is genuinely empty for that gate, never speculatively.
- Some distances cannot be closed. Whether a gate's subjects are produced by the stage being
  refused is not knowable to Aldus: what a gate binds is adopter process supplied through a
  `SubjectsProvider` (§4.2), and nothing relates a subject to its producer. Where the fact is
  genuinely absent, the honest move is to name the hypothesis rather than assert the conclusion —
  and to document the failure mode where the adopter will meet it.
- This ADR records a ranking principle rather than a mechanism, so nothing enforces it. Its value
  is that a future contributor deciding whether a message-only fix "counts" has an argument to
  point at.

## Alternatives considered

- **Rank by severity of consequence.** Rejected as insufficient, not wrong: gate enforcement
  (#45) was correctly ranked first by consequence, and the four defects above were all
  low-consequence and high-cost. Severity and distance are orthogonal, and only one of them was
  being measured.
- **Treat message quality as documentation work.** Rejected: the four defects were diagnosed from
  messages, not from documentation, and in each case the documentation was correct and unread
  because the message pointed elsewhere.
- **Add a diagnostic mode that dumps resolved configuration.** Rejected as a substitute — it helps
  someone who already suspects a configuration problem, which is the step the misleading message
  prevented them from reaching.
