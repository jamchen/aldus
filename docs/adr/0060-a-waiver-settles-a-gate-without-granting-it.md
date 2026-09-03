# ADR-0060: A waiver settles a gate without granting what it authorizes

- Status: Accepted
- Date: 2026-09-03
- Relates to: §13 Gates, §13.4 Release authority, §24 Operator surface, ADR-0009, ADR-0058,
  ADR-0059, #278, #281

## Context

#281 reports that `aldus status` tells an operator who has waived a gate that «the operations it
authorizes are refused», and asks for the opposite: that a waived gate's operations be reported as
authorized, on the evidence of two predicates that treat `satisfied` and `waived` alike — the
engine's `currentlyBlocking` (`packages/aldus-gate-engine/src/engine.ts:399`) and `gateIsSettled`
(`packages/aldus-services/src/nextaction.ts:59`, ADR-0059).

Both predicates are real, and neither is about grants. They answer two other questions:

- `currentlyBlocking` — does this gate stop a stage from running right now?
- `gateIsSettled` — is a decision outstanding on it?

The question the reported sentence is about is the third one, §13.4's: **which operations does this
gate authorize.** That is `GateEngine.authorize`, and it is unambiguous
(`packages/aldus-gate-engine/src/engine.ts:552`):

```ts
const granted = relevant.find(
  (status) => status.state === "satisfied" && status.decision?.decision === "approved",
);
```

A waiver does not satisfy it. The rule is deliberate, tested, and older than this issue —
`packages/aldus-gate-engine/test/release.test.ts:139`, _"does not let a waived upload gate authorize
publication"_, whose own comment reads **"the waiver unblocks the chain, but grants nothing:
`authorize` requires an approval."**

So the premise the issue reasons from does not hold in the code, and the fix it proposes would make
`status` promise an authority that `aldus publish` then refuses — the failure this module's own
docstring names as worse than saying nothing.

The residual complaint is nevertheless correct, and it is about the sentence rather than the
verdict. One string served every non-`satisfied` state, so a waiver produced the same line as a
rejection, and an operator who had just used a verb designed for exactly this situation was told
nothing had changed. What the waiver did change — the gate stopped blocking, its parked stages were
released (ADR-0059), the cascade below it cleared — was invisible.

## Decision

**A waiver settles a gate and grants nothing.** Three states, not two, in everything an operator
reads:

1. `satisfied` — the operations are authorized; the plan says nothing, because there is nothing to
   explain.
2. `waived` — nothing awaits a decision and no stage is held, **and** §13.4's operations stay
   refused, because they are granted by an approval. The plan says both halves in one sentence and
   names the waiver as a bypass rather than a pass.
3. everything else — refused, and the gate is still in the way.

`nextaction` reads `gateIsSettled` for the second arm rather than a second literal, which is what
#281 asked for and is worth doing on its own terms: this sentence and ADR-0059's release rule must
agree that a waiver settles the gate, and disagree only about grants.

**`GateEngine.authorize` is not changed.** It is the mechanism §13.4's separation of uploading from
publication rests on, `next.29` made every gate waivable — `release.public` included — on the
strength of a waiver expiring with its subjects, and widening it would let a bypass hand out a
publication authority nobody judged. ADR-0058 refused the same widening one level down, for the same
reason.

## Consequences

- An operator who waives a gate to get past a blocking check sees that it worked, and sees in the
  same line that the gate's §13.4 grants still need an approval. Neither half was previously legible.
- The waiver keeps its use: it clears the block, releases the parked stage, and clears the cascade.
  What it never did, and still does not, is issue a grant.
- Nothing in the export surface moves. `check-breaking-notes.mjs` reports no surface change; the
  change is one operator-facing string and the branch that selects it.
- The disagreement between this ADR and #281's proposed fix is deliberate and is the reason the ADR
  exists rather than the change going in silently. If the coordinator's reading is that a waiver
  _should_ grant, that is a change to `GateEngine.authorize` and to
  `release.test.ts:139` — a §13.4 authority change, not a wording one, and it needs its own decision.

## Alternatives rejected

**Report a waived gate as authorizing, as #281 proposes.** The plan would offer an authority the
release path refuses. `status` and `runStage` disagreeing about blocked-ness is the defect ADR-0024
and ADR-0021 were written to remove; this would reintroduce it one field over, on the publish path.

**Drop the line for a waived gate, the way `satisfied` is dropped.** Silence reads as authorized to
an operator scanning for a reason, and the one operator who most needs the sentence — the one who
waived `release.public` and cannot publish — is the one who would get nothing.

**Widen `authorize` to accept a waiver.** Rejected above. It is defensible only as a product
decision about §13.4 authority, taken with the owner, and it is not what #281 asked for.
