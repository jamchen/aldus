# ADR-0024: A declared gate refuses a stage; the conservative default does not

- Status: Accepted
- Date: 2026-08-18
- Closes: issue #45
- Relates to: §11 Workflow and stage contracts, §13 Human gates, §24 V1 definition of done,
  ADR-0008, ADR-0015, ADR-0021

## Context

The first external adopter integrating `0.1.0` found that `aldus status` reports a stage as
blocked, with a correct and well-worded explanation, and `aldus run <stage>` then executes it
anyway — side effects and all.

§11 requires that a stage "stop at required gates". Recording `waiting_for_gate` after the work
has run is not stopping.

`@aldus-runtime/stage-runner` genuinely cannot enforce this. It does not depend on
`@aldus-runtime/gate-engine`, deliberately, so it cannot evaluate a gate; `StageDefinition.requiredGates`
says as much in its own documentation, and ADR-0021 introduced that field for the next-action
policy rather than for enforcement. All of that is correct **at that layer**.

The reasoning stops holding one layer up. `AldusServices` holds the gate engine, the subjects
provider, and the workflow graph. ADR-0015 already establishes that policy is enforced on Aldus's
side of an injection point. Nothing about the package boundary prevents the check here — it had
simply never been written.

The adopter's own summary of the exposure is the useful framing: the two operations that must not
happen early, paid synthesis and publishing, each have an enforced path already. Everything else —
a render, a browser capture, any worker wrapped as a plain stage — has none, and the natural
reading of `requiredGates` on a stage is that it is a guard.

## Decision

### 1. `runStage` refuses when a **declared** required gate is unsatisfied

The refusal is a `refused` `ServiceResult` carrying `reason: "stage_gate_unsatisfied"`, the
blocking gate's id, and the same explanation `status` prints. It is not a thrown error and not an
`unsuccessful` run: nothing was attempted, no attempt is appended, and no side effect occurs.

`retryStage` delegates to `runStage` and therefore inherits it. That delegation exists because
§6.3 makes attempts append-only — a retry _is_ another run — and it pays off here: there is no
second path to forget.

### 2. The conservative default is deliberately **not** enforceable

ADR-0021 made an _undeclared_ stage conservatively blocked by every blocking gate, so that a
stage accidentally omitted from a workflow graph would not silently become runnable. That is the
right call for a display.

It would be a disaster as an enforcement rule. **Every gate is unsatisfied when a Run starts**,
and the subjects a gate binds are produced by stages. Refuse on the fallback and an adopter who
never declared `requiredGates` — it is optional, and nothing in the type system pushes anyone
toward it — finds every stage refused, with no way out: the evidence the gates need cannot be
produced, because producing it is what the refused stages do. That arrives on first upgrade,
accompanied by a message telling the operator to decide a gate they cannot yet supply evidence
for.

The principle, which is the durable part of this ADR:

> **A hint can afford to over-warn. An enforcement rule cannot.**

So the policy distinguishes two kinds of block, and only one refuses:

| Enforcement | When                                                                                    | `status`                      | `runStage`  |
| ----------- | --------------------------------------------------------------------------------------- | ----------------------------- | ----------- |
| `enforced`  | the stage declared this gate, via the workflow graph or `StageDefinition.requiredGates` | reports it                    | **refuses** |
| `advisory`  | nothing declared what gates this stage; the fallback assumes every blocking gate might  | reports it, wording unchanged | allows      |

A stage declaring `requiredGates: []` stays runnable while unrelated gates are pending, exactly
as ADR-0021 intended.

A future contributor tempted to "make enforcement match the display" should read the paragraph
above before changing this. There is a test named for the deadlock that will fail if they do.

### 3. The distinction lives inside the policy, not at the call site

`gateBlockerFor` returns a blocker tagged `enforced` or `advisory`; `enforcedGateBlockerFor`
returns only the former, and that is what `runStage` calls. Both are computed by the same
`blockerFor` that `decideActions` uses for display.

This matters more than it looks. The defect was `status` and `run` disagreeing, and **any fix
that computed blocked-ness a second way could drift back into disagreement.** Splitting the
enforceable/advisory judgement between the policy and the caller would reintroduce exactly that
risk one level down. One function knows the rule.

A test asserts that the refusal's explanation is character-for-character what `status` printed for
the same state, so the two cannot silently diverge.

### 4. `force` does not bypass a gate

`force` exists to take over a stage claimed by a stale attempt (ADR-0008). Overriding a human
decision is a different act, and §13 does not provide for it. The gate check runs before `force`
is consulted, and a test pins it.

### 5. `status` surfaces which kind of block it is

`BlockedAction.enforcement` distinguishes "decide this gate before this stage will run" from "I
cannot tell whether this gate applies — declare the stage's required gates to narrow it". The
second is a prompt to improve the workflow declaration, not a barrier, and without the field the
two read identically.

The wording of both reasons is unchanged from `0.1.0`, so an operator's existing reading of
`status` output stays valid.

## Consequences

- **This is a behaviour change after `0.1.0` shipped.** An adopter who declared `requiredGates`
  and relied on the stage running anyway will now see a refusal with exit code 1. That is the
  fix, not a regression: the previous behaviour executed work the operator had been told was
  blocked. An adopter who declared nothing sees no change at all, which is the majority case and
  the reason the fallback stays advisory.
- Declaring `requiredGates` now has teeth. That is the intended incentive, and it is opt-in.
- A declared gate that is _not registered_ refuses rather than being ignored — the stage named a
  guard the adopter believes is protecting it, and proceeding past a guard that does not exist is
  the worse failure.
- `StageDefinition.requiredGates` in `@aldus-runtime/stage-runner` documents itself as
  "declarative, not enforcement". That remains accurate **for that package**, which still cannot
  evaluate a gate, but now reads misleadingly in isolation. It needs a note pointing here; that
  edit belongs to a change that owns the package and is flagged rather than made.

## Alternatives considered

- **Enforce in `@aldus-runtime/stage-runner`.** Rejected: it would make the runner depend on the
  gate engine, collapsing a boundary §7 and ADR-0015 keep deliberately separate, and every
  adopter embedding the runner without gates would pay for it.
- **Leave the behaviour and document it loudly** (the issue's option 2). Rejected as the primary
  answer: it makes the safe path something each adopter must rediscover, and the field is already
  named in a way that reads as a guard. The documentation improvement in decision 5 is kept.
- **Enforce on the conservative fallback as well** — which is what the first draft of this change
  did. Rejected once the deadlock was traced: see decision 2.
- **A `--force-gate` escape hatch.** Rejected: §13 makes a gate decision a recorded, attributable
  act, and a flag that skips it would be an unrecorded approval — precisely what §3.6 exists to
  prevent. An operator who wants to proceed can decide the gate, which leaves a `GateDecision`
  behind.
- **Refuse a `StageDefinition` with no `requiredGates` at registration**, making absence
  inexpressible. Genuinely cleaner: it removes the advisory case entirely and with it the whole
  enforced/advisory split. Rejected _for now_ as a breaking change that would reject every
  existing adopter definition on upgrade. Worth revisiting once adopters have had a release to
  declare their gates.
