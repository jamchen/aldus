# ADR-0052: Provenance records what produced the bytes

- Status: Accepted
- Date: 2026-08-25
- Relates to: §4.2 Boundary, §8.1 Artifacts, §20 Reproducibility, ADR-0003, ADR-0044, #196

## Context

`ArtifactRef` provenance pinned every **input** — the digests a stage read, the knowledge pack
versions, `producerRunId`, `producerStageId` — and recorded nothing about what produced them.

The first adopter measured it during a rehearsal: a `research/thread-proposal` artifact, classified
`source`, carried three input digests and four knowledge pack ids. The model that wrote it appears
in the agent definition's frontmatter, is passed to the CLI, and reaches neither the result, the
cost record, nor the artifact. So the same briefing, the same prompt, the same packs, on a later
model, produce a different document and **no field distinguishes the two records**.

**The Runtime had already decided this evidence is worth keeping — for money, not for artifacts.**
`AgentBackend.version` is required, and says why: _"a spend reservation records which version was
dispatched under an enforced ceiling, and that evidence must not be reconstructed by re-reading
today's capabilities."_ That argument transfers unchanged to a `source` artifact, and more
strongly: a reservation settles within minutes, an artifact is read a year later.

The sharpest evidence that this is a gap rather than a tidiness point came from the adopter's own
records. Their `agent-spend-ceiling` disposition names _"the agent backend or its model changes"_ as
its re-examination trigger — **a control they already rely on, whose trigger nothing in the system
can observe.**

## Decision

`ArtifactRef` gains an optional `producers` list. Each entry carries `id`, `version`, and
`versionEvidence: "reported" | "requested"`. All three are opaque to Core (§4.2).

**Not "model".** That is provider-shaped, and the concept generalises past agents to a renderer
binary or an embedded font — which is what makes it belong in Core at all.

**A list, not a value.** The adopter measured an agent CLI reporting `modelUsage` as a map keyed by
model, with a delegating execution reporting more than one. A single producer would force a caller
to pick, and the choice would be invisible in the record: a guess that reads as a fact. It costs
nothing when there is one.

**`versionEvidence` exists because requested and executed are different strings.** Measured:
`--model haiku` in, `claude-haiku-4-5-20251001` out. A field holding the frontmatter value would
record an intention and read as evidence — a new instance of the problem inside its own fix. So the
weaker state is representable rather than guessed, the way `billing_unknown` is.

**Not on `CostRecord`, as the primary home.** A free execution writes no cost record at all, so an
artifact produced by a free run would have no producer identity — and a `source` artifact is
exactly as irreproducible whether or not anyone was billed. Putting it there would also make
reproducibility a side effect of having been charged. A cost record may carry producer detail as
well; that is a separate question about billing.

Optional, so no stored record becomes invalid: additive, `SCHEMA_VERSION` 1.12 → 1.13 (ADR-0003).
Non-empty when present, because an empty list asserts that nothing produced the bytes.

`producerProvenanceGap()` reports the absence, and distinguishes a `source` artifact — where the gap
is unrecoverable — from a `reproducible` one, where it can be closed by regenerating. An optional
field nobody fills is decoration, and decoration is worse than absence because it reads as coverage;
this makes the hole queryable rather than silent.

## Consequences

An adopter recording producers gets artifacts that say what wrote them. One that does not is
unchanged, and can ask `producerProvenanceGap` which of its artifacts cannot answer.

**What this does not do**, stated because a predicate implying otherwise would be the drift the
field exists to close: it does not check that a recorded producer is **true**. A caller may record
`versionEvidence: "reported"` for a value it never observed. It checks that the question was
answered.

## Alternatives rejected

**A compound `provider` string** — `provider` is opaque to Core by §4.2, so a compound value cannot
be split by anything here, and it breaks grouping by provider in the ledger.

**A dimension on `CostQuantity`** — `quantity` is `{unit, amount}`, a measure of consumption. A model
is not a quantity, and encoding one there makes every ledger sum meaningless.

**Hashing producer identity into `inputHashes`** — works today with no schema change and makes two
documents distinguishable, but you learn that _something_ changed, never what. It also overloads a
field whose documented meaning is what the stage **read**, with a gate-satisfaction property resting
on it. The adopter was offered this as a stopgap and declined it for that reason.

**Requiring `producers` on `source` artifacts** — would invalidate every stored `source` record.
Whether the writer boundary should require it once adopters are populating it is left open.
