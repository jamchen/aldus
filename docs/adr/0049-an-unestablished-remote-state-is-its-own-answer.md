# ADR-0049: An unestablished remote state is its own answer

- Status: Accepted
- Date: 2026-08-21
- Relates to: §13.4 Release approval, §17 Release, §19.1 Idempotency, §20 Trace, ADR-0048, #169

## Context

ADR-0048 removed the question for an operation whose effect is safe to repeat. This is the other
half of #169: an operation that genuinely needs reconciling, whose answer cannot be established
_right now_ — a rate-limited destination, a privacy transition that leaves nothing on the channel
identifying it, a dropped connection.

`RemoteState` was `{ exists: boolean }`, so such an adapter had two options and both were wrong:

- **return `exists: false`**, asserting a completed search nobody performed;
- **throw**, which aborted the whole reconciliation pass before a single operation executed,
  because `reconcile` awaited every `lookup` bare — so a quota error raised while asking about a
  tidy-up blocked the upload beside it.

The asymmetry underneath is that `execute` already treats a best-effort _failure_ as a warning and
continues. The same operation could fail to be performed without consequence and could not fail to
be asked about.

## Decision

**`cannotEstablish(reason)` is a third answer to `lookup`, and the executor's response to it
depends on criticality.**

### One state, with a required reason

Not two states distinguishing _"cannot answer"_ from _"did not look"_. With ADR-0048 in place,
"did not look" stops being something an adapter can answer at all — the executor knows it did not
look, because it decided not to. The only remaining case is "asked and cannot establish", which is
one fact needing one state.

The reason is **required**. A rate limit, a permission problem, and a destination that does not
retain what identifies the operation call for three different responses, and an operator cannot
tell them apart from the absence of an answer.

### Impossible to produce accidentally

Minted, and recognised by **`WeakSet` membership rather than by shape** — the same runtime proof
`SynthesisPermit` uses. The brand is a phantom, absent at runtime, so a narrowing that trusted it
would be trusting a type assertion. A state that suppresses a publish-safety check must not be
reachable by writing an object literal.

**`exists: false` remains the answer only a completed search can give.** That is the invariant the
whole mechanism exists to restore.

### The response is keyed on criticality

- **required + cannot-establish → refuse before executing.** Unknown must never license a publish:
  executing might repeat the operation and skipping might drop it, and neither is a choice to make
  blind.
- **best-effort + cannot-establish → no receipt, not performed this pass, and the release
  continues.** Matching what `execute` already does with a best-effort failure.

  **No receipt is the load-bearing half, and the first version got it wrong.** Writing a `skipped`
  receipt is the obvious thing and it is this issue's own defect one level down: `skipped` is
  terminal in both directions — `execute` skips it and `reconcile` treats it as already recorded —
  so **one momentary query failure permanently retired the operation for that bundle.** At the
  destination that produced #169, quota exhaustion is routine, so a rate limit while _asking
  about_ a best-effort operation would have silently dropped it forever, and the record would have
  said `skipped`: a decision, when what happened was an unanswered question.

  A durable record of a transient failure is the same defect as a durable record of a search
  nobody performed. So the not-performing lives in the pass only — the finding and the warning say
  what happened now, and the next pass asks again.

  Not performed **either**, because executing on an unknown prior state is the other half of the
  trap: it might repeat an operation that already happened. Skipping without recording is what
  makes the retry safe rather than merely possible.

  The adopter had already met this hazard from the other side. They declined to name an authority
  on their cleanup precisely because an unheld authority writes a terminal `skipped` — a workaround
  available to them because the authority was their choice. A transient query failure is not.

An **unanticipated throw** from `lookup` becomes the same cannot-establish finding for a
best-effort operation; a required operation's throw still aborts the pass. Fail-closed stays where
a mistake publishes twice, and stops being where a tidy-up could not be queried.

`cannot_establish` joins `OPERATOR_FACING_FINDINGS`. It is the state an operator most needs to see,
and under the deny-list ADR-0048 replaced it would have been surfaced by accident rather than by
decision.

### Item 4: a success that has something to say

`AdapterOutcome.succeeded` gains an optional `note`, carried through to `ReleaseReceipt.note`.
`failed` has `message` and `pending` has `message?`; a success had nowhere to put a sentence, so an
adapter that removed a marker from one item of several, or found nothing to remove, had to discard
the only part an operator would have wanted.

**Explicitly not a channel for a qualified absence.** An adapter that cannot establish remote state
returns `cannotEstablish`; footnoting a fabricated `exists: false` here would be the same false
record with better documentation, which is what #169 is about preventing.

Carried into the receipt rather than left on the outcome, because a field an adapter can set and
nothing reads is #107's defect one contract over.

## Consequences

Stated three ways, as ADR-0048 established:

- **For an adapter: not additive.** `lookup` returns `RemoteState`, which is now a union. An
  adapter is unaffected in practice — returning `{ exists: … }` still compiles — but the type it
  implements has widened, and an adapter that assigned the result of `lookup` to
  `{ exists: boolean }` internally will not compile.
- **For an adopter composing the executor: additive in shape, and a behaviour change.** No wiring
  changes. But a required operation whose state cannot be established now refuses where it
  previously proceeded on a fabricated `false`, and that is the point rather than a side effect.
- **For a consumer that reads the types: not additive.** `RemoteState` becomes a union and
  `ReconciliationFinding.action` gains a sixth member. Both break an exhaustive reader.

`SCHEMA_VERSION` goes to 1.11 for `ReleaseReceipt.note` — an additive optional field, a MINOR bump
under ADR-0003 — with the addition sanctioned in `contract-conformance.test.ts` and justified here.

### What the new check found

A latent bug the runtime had been papering over. A CLI test fixture's adapter returned
`{ present: false }` from `lookup` — a typo — which the old code read as `exists: undefined`,
falsy, and recorded as `confirmed_absent`: a completed search finding nothing, asserted from a
value that was not a `RemoteState` at all. The executor now refuses a value that is neither arm,
and that is how the fixture was found.

That refusal is the **fifth** instance in this contract of the lesson ADR-0048 records: a narrowing
that trusts the declared type is not a narrowing. It was added because a mutation survived — an
assembled `{ reason: … }` was correctly rejected as an issued state and then silently became
`confirmed_absent`.

## Alternatives considered

- **Two states, "cannot answer" and "did not look".** Rejected: with ADR-0048 the second is not
  something an adapter can answer, and a second enum member that changes no behaviour is how a
  vocabulary comes to look more precise than the logic behind it.
- **An optional reason.** Rejected: a finding an operator cannot act on.
- **Treating a cannot-establish as a failure of the operation.** Rejected: the operation may have
  succeeded. Recording a failure would be as false as recording an absence.
- **Letting `note` explain a fabricated absence.** Rejected explicitly, and documented on the field
  itself, because it is the shape someone will reach for next.
