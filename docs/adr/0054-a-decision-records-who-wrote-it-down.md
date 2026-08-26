# ADR-0054: A decision records who wrote it down

- Status: Accepted
- Date: 2026-08-26
- Relates to: §13 Gates, §19.2 Auditability, ADR-0003, ADR-0034, #213

## Context

`GateDecision.decidedBy` answered _who decided_ and nothing answered _who wrote the record_. So one
field carried two events:

- the person typed it;
- the person decided it and something else typed it.

Both read as "a human decided". The second has one more link that can fail, and the failure is
**misrepresentation** rather than usurpation — a different mode from the delegation this contract
spends §13.3 refusing. The first adopter reported two of their own transcription failures in the
same message that asked for the field: a spend figure relayed from the wrong ledger, and an
arithmetic error amplified with its contradicting data present. Neither was a judgement failure.

**The honest shape was unreachable while the misleading one was not.** Nothing authenticates an
actor string — `parseActor` splits `"kind:id"` and believes it, which `config.ts` already records —
so an agent transcribing a decision could always set the human as the actor, and nothing could
distinguish that from the human having typed it. Refusing the field never prevented transcription.
It prevented _truthful_ transcription.

The case that forced it was operational rather than theoretical. The owner works from a mobile app,
where `!` is a Claude Code **terminal** feature and is not intercepted; their approval command
arrived as text, twice, and never executed. Everything in the pipeline worked and the channel did
not exist. The only path open to their adopter was typing the owner's identity — the shape reachable
from a phone was the dishonest one.

## Decision

`GateDecision` gains an optional `transcription: { recordedBy: ActorRef; verbatim: string }`.

**One object, not two optional fields.** A transcriber with no record of what they were told cannot
be checked against anything, and words with no transcriber name nobody. Both-or-neither is
structural rather than validated.

**`recordedBy` is derived from the acting actor, never supplied.** There is no flag for it. A
transcriber that could name itself could name someone else, and the whole value of the field is that
it says who actually ran the command.

**The engine refuses a decision naming the decider as its own transcriber**
(`ALDUS_GATE_TRANSCRIPTION_INVALID`). That is not a transcription; it is the ordinary case wearing
an extra field, and allowing it would make the field unreadable wherever it is real.

`aldus approve|reject <gate> --decided-by <kind:id> --verbatim <text>`. The flags are required
together and refused apart: `--verbatim` without `--decided-by` is a comment under another name.

Additive and optional, so MINOR under ADR-0003: `SCHEMA_VERSION` 1.13 → 1.14.

## Consequences

**This grants no authority.** `recordedBy` names who wrote the record; `permittedActorKinds` still
applies to `decidedBy`, so an agent transcribing cannot record a decision an agent could not make.
Tested in both directions: an agent deciding for itself is still refused, and an agent naming
another agent as decider is still refused.

An adopter whose owner is not at a keyboard now has a supported way to record a decision that owner
made. What it does not do is make a decision nobody made recordable — the test remains whether a
human formed the judgement, and the field makes that legible rather than assumed.

## Alternatives rejected

**"An approval means the person acted, and acting includes typing."** Defensible, and it was the
real alternative. It does not survive the observation that authentication-by-doing is not what the
terminal provides: nothing authenticates the actor string on either path, so the rule would enforce
a ritual rather than a guarantee — and it would leave an owner unable to approve their own gate.

**Requiring `recordedBy` only when a caller says the actors differ.** A transcription that can omit
its transcriber is the current situation with extra steps.
