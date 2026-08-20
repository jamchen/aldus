# ADR-0038: A take records what was requested and what produced the bytes, side by side

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

**A take stores requested facts and produced facts side by side. Produced facts never overwrite
requested ones, and their absence is never decoded as agreement.**

`SynthesisOutcome` gains `producedParameters`, `producedFinalProviderText` and `productionReason`.
The gateway writes them to `TakeRecord.produced`, leaving `text` and `parameters` exactly as
before.

### Beside, not preferred

The alternative — the gateway preferring a produced value into `parameters` — was the initial
recommendation and was withdrawn once the second instance appeared. With one field and rare
divergence it is defensible. With two fields diverging routinely for an entire class of adapter,
the warranty becomes: _"`parameters` means used, unless the adapter did not say, in which case
requested."_ That is a sentence someone reading a record at speed will get wrong, and it
renegotiates the meaning of every record already written.

Side by side, each field means one thing, always. No field's meaning depends on whether another
field is present.

### Unknown is a value, and is never decoded as agreement

`producedParameters` and `producedFinalProviderText` return `undefined` when nothing recorded what
made the bytes. **`undefined` means unknown, never "the same as requested."**

The first draft of this ADR had them fall back to the requested value, under the name
`effectiveParameters`. It read well and it was wrong, for the reason the ruling states directly:
_never infer that observed equals requested_. An adapter that never learned to report is
indistinguishable from one that produced exactly what was planned, and a fallback states the second
while establishing only the first. That is the same defect as the field it was introduced to fix,
one layer up — worth recording, because it survived being written by someone who had just finished
describing the defect.

`compareProducedToRequested` is three-valued for the same reason: `unknown`, `matches`, `diverged`.
A boolean, or a list whose emptiness means agreement, folds unknown into matches.

It is derived on read and never stored. A stored comparison would be a third value to keep
consistent with the two it summarises, which is a defect class this repository has now hit four
times.

### Produced facts are whole values

`produced.parameters` is a complete `SynthesisParameters` or absent — never partial. A partial
report would mean "provider is what I say, voice is whatever was planned", reintroducing one
key at a time the exact ambiguity the record exists to remove.

Only `finalProviderText` is observable among the text stages. Normalisation, substitution and
tagging are transformations the _planner_ performed, so the plan's record of them is the true one.
What an adapter knows, and nothing else does, is the bytes it sent.

### Absence means nobody said

`produced` is omitted entirely when the adapter reported nothing, rather than written as an empty
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

## Scope, and what this ADR does not settle

The ruling on #133 models **three** facts, and this ADR implements the first two:

1. **Requested / approved** — the plan's text and parameters, unchanged in place and now documented
   strictly as requested facts.
2. **Produced with** — the exact text and parameters that made the bytes.
3. **Delivered through** — the adapter and mechanism by which bytes entered the Run.

The third is deliberately not here, and neither are four consequences of it: the gateway recording
`adapterId` itself rather than trusting an adapter to self-identify; provenance linkage for replay
and import; refusing a **paid** execution whose produced facts differ from the authorized ones; and
the paidness correction below. They are one coherent piece of work and are tracked as such rather
than half-built here.

`isPaid` currently reads:

```ts
return take.authorization !== undefined || take.costRecordId !== undefined;
```

An authorization means spending was _permitted_, not that it _occurred_. The adopter's seven local
takes are authorized and free, and `isPaid` calls all seven paid — the same defect as
`parameters.provider`, in the same records, for the third time.

## Alternatives considered

- **Prefer produced values into `parameters`.** Rejected above; it was my own first recommendation and
  the second instance is what changed it.
- **A single `diverged: true/false` flag.** Rejected: it records that something differed without
  recording what, which leaves the original question — which provider made this audio — exactly as
  unanswerable as before.
- **Refuse a take whose observed text differs from the approved text.** Rejected: the divergence
  that motivated this ADR is legitimate and necessary. §13.2's comparison is a policy an adopter
  composes, not a rule the ledger imposes on every adapter that adapts.
