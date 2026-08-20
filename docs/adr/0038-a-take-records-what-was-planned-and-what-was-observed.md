# ADR-0038: A take records what was planned and what was observed, side by side

- Status: Accepted
- Date: 2026-08-20
- Relates to: §13.2 Authorization, §15 TTS ledger, §20 Production trace, ADR-0030, ADR-0037
- Issue: #133

## Context

`SynthesisGateway` builds a take from the plan:

```ts
take: {
  text: segment.text,                 // the plan's
  parameters: input.plan.parameters,  // the plan's
```

`SynthesisOutcome` had no field for either, so an adapter could report a request id, a digest, a
cost and findings — and nothing about what actually produced the audio.

Two instances arrived from the same adopter, a week apart, in the same adapter.

**Parameters.** Seven takes synthesised by a local engine each recorded the planned hosted
provider, model and voice. The only field telling the truth was `providerRequestId`, and only
because their adapter had adopted a string convention for exactly this reason. Anyone answering
_"which takes were paid for"_ from `parameters.provider` gets seven charges that never happened,
from records that are individually well-formed.

**Text.** Their plan carries 36 performance tags. Neither local engine can read a tag and both
speak them aloud — a clip transcribed as `pause，回到座位，…` — so their adapter strips them before
synthesis. The take then records text containing tags the engine never received. They wrote a
sidecar file and called it a workaround in the code, which was the right instinct.

The second instance is the sharper one, because of what the field said about itself:

> Exactly what was sent to the provider. This is the string §13.2 binds. If it differs from what
> the operator approved, the authorization does not cover the request that was actually made.

The field declared that its purpose was to be compared against the approval, and was structurally
assigned _from_ the approved plan. Nothing consumed it, so nothing was broken in a running system.
What was broken is that the comparison it exists for **could not fire once anyone wrote it**: both
sides are the same expression, so the check would pass and mean nothing.

That is worth separating from the family it otherwise belongs to. The rest are records asserting
more than was established; this is a _check whose two inputs are the same value_. The adopter hit
the same shape independently — a passing tag test on a two-second clip too short to contain the
failure, which they noted is "not a weaker version of a passing check, it is a different statement
wearing its clothes."

| record                             | asserted              | established               |
| ---------------------------------- | --------------------- | ------------------------- |
| `{ kind: "human", id: decidedBy }` | a human decided       | nothing about the kind    |
| `alreadyAbsent`                    | the file is gone      | the delete failed         |
| `verified: true`                   | bytes were re-read    | set unconditionally       |
| `parameters.provider`              | this provider made it | this provider was planned |
| `text.finalProviderText`           | this text was sent    | this text was planned     |

## Decision

**A take stores planned and observed values side by side. Observed values never overwrite planned
ones.**

`SynthesisOutcome` gains `observedParameters`, `observedFinalProviderText` and
`observationReason`. The gateway writes them to `TakeRecord.observed`, leaving `text` and
`parameters` exactly as before.

### Beside, not preferred

The alternative — the gateway preferring an observed value into `parameters` — was the initial
recommendation and was withdrawn once the second instance appeared. With one field and rare
divergence it is defensible. With two fields diverging routinely for an entire class of adapter,
the warranty becomes: _"`parameters` means used, unless the adapter did not say, in which case
requested."_ That is a sentence someone reading a record at speed will get wrong, and it
renegotiates the meaning of every record already written.

Side by side, each field means one thing, always. No field's meaning depends on whether another
field is present.

### The precedence rule exists, and lives in one named place

Readers still need the effective answer, and pushing the fallback into every call site would be
worse than a renegotiated warranty — it would be an unwritten one. So `effectiveParameters`,
`effectiveFinalProviderText` and `takeDivergences` are exported functions: documented, tested, and
the obvious thing to reach for. **`effectiveParameters` is the function that answers "which takes
were paid for."** Reading `take.parameters` answers "which takes were _planned_ to be paid for",
and the two differ exactly where the question matters.

`takeDivergences` is derived on read and never stored. A stored divergence flag would be a third
value to keep consistent with the two it summarises, which is a defect class this repository has
now hit four times.

### Observations are whole values

`observed.parameters` is a complete `SynthesisParameters` or absent — never partial. A partial
observation would mean "provider is what I say, voice is whatever was planned", reintroducing one
key at a time the exact ambiguity the record exists to remove.

Only `finalProviderText` is observable among the text stages. Normalisation, substitution and
tagging are transformations the _planner_ performed, so the plan's record of them is the true one.
What an adapter knows, and nothing else does, is the bytes it sent.

### Absence means nobody said

`observed` is omitted entirely when the adapter reported nothing, rather than written as an empty
object — "did not report" is a silence, "reported that it matched" is a claim, and only the second
is evidence. Neither means the plan was followed. An adapter that never learned to report is
indistinguishable from one with nothing to report, and no function over this record can tell them
apart. That limit is documented on the field rather than left to be discovered, because it is
invisible from the value.

## Consequences

- Schema version 1.6 → **1.7**. Additive optional field, so MINOR (ADR-0003). Existing records stay
  valid and keep their exact meaning — which is the property "beside" was chosen for.
- `finalProviderText`'s documentation is corrected in both the plan and the take. It said "exactly
  what was sent"; it is what the planner intends to send.
- §13.2's approved-versus-sent comparison becomes writable for the first time. This ADR does not
  write it, and deliberately does not make divergence a refusal: the adopter's tag stripping is a
  _legitimate_ divergence, and a gateway that refused it would break the correct case while
  claiming to protect it.
- The adopter's sidecar file can be deleted rather than migrated. Nothing depended on it.

## Alternatives considered

- **Prefer observed into `parameters`.** Rejected above; it was my own first recommendation and
  the second instance is what changed it.
- **A single `observed: true/false` flag.** Rejected: it records that something differed without
  recording what, which leaves the original question — which provider made this audio — exactly as
  unanswerable as before.
- **Refuse a take whose observed text differs from the approved text.** Rejected: the divergence
  that motivated this ADR is legitimate and necessary. §13.2's comparison is a policy an adopter
  composes, not a rule the ledger imposes on every adapter that adapts.
