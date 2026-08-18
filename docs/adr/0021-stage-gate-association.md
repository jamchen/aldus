# ADR-0021: A workflow declares which gates gate which stages

- Status: Accepted
- Date: 2026-08-18
- Closes: issue #38
- Relates to: §11 Workflow and stage contracts, §13 Human gates and freezes, §24 V1 definition of
  done, §12 Quality model, ADR-0011, ADR-0015

## Context

`decideActions` answers §24's requirement that "an operator can see current state and next safe
action without reading chat history". Deciding whether an unrun stage is safe to run means asking
whether a gate stands in its way — and the model had no way to say **which** gates gate **which**
stages. So the policy did the only honest thing available to it:

```ts
const blocker = gates.find((gate) => gate.blocking);
```

One blocking gate, applied to every stage that had never run.

That is safe. It is also close to useless the moment a workflow declares more than one gate. A
release gate pending at the start of a Run suppressed narration work that had nothing to do with
it, so `next` was empty from the first moment and §24's promise degraded to "here is why you
cannot act". The `blocked` entries stayed accurate, which is why this was a usability defect
rather than a correctness one — nothing unsafe was permitted, and nothing was silently skipped.

It could not surface in `@aldus-runtime/services`' own tests, which register only the gates a
scenario needs. It surfaced in the end-to-end composed-stack suite, where a realistic workflow
declares its gates up front — which is exactly what §11 describes when it calls a workflow "a
versioned graph of stages and gates".

## Decision

### 1. The association is a workflow graph, supplied by the caller

`AldusContextOptions.workflow?: WorkflowGraph` joins the gate registry and the stage registry it
already accepts. A graph is a list of stage nodes, each optionally naming the gates that gate it.

This is where §11 puts it. §11 calls a workflow a versioned graph of stages and gates, §11 makes
workflows adopter-supplied, and §4.2 keeps adopter workflows out of the runtime. `RunManifest`
already carries `workflowId` and `workflowVersion`; this is the graph those fields name.

### 2. `StageDefinition.requiredGates?: readonly string[]` is the convenience form

§11 says a stage MUST "stop at required gates", so a definition declaring its own gates is the
ergonomic shape, and a single-workflow adopter should not have to write a graph to get the
benefit.

It is **declarative, not enforcement**. `@aldus-runtime/stage-runner` does not depend on
`@aldus-runtime/gate-engine` and cannot evaluate a gate, so this field does not stop `run()`. It
informs the policy. What a gate _authorizes_ is still refused by the gate engine, where §13 puts
it — so nothing unsafe becomes reachable by declaring nothing.

### 3. Precedence: the graph wins where it names a stage

Resolution order is graph, then stage definition, then undeclared.

The reason is reuse. One stage definition may be used by several workflows that gate it
differently, and a workflow must be able to say so without editing a definition it shares. Union
was the alternative and is worse: it makes a requirement impossible to _remove_ for a single
workflow, so a stage reused in a workflow that does not need a gate would be permanently blocked
by it.

### 4. Undeclared is not "requires nothing"

Three states, and the distinction carries the safety argument:

| Declaration  | Meaning                                  | Behaviour                   |
| ------------ | ---------------------------------------- | --------------------------- |
| absent       | nothing said which gates gate this stage | any blocking gate blocks it |
| `[]`         | declared to require no gate              | never blocked by a gate     |
| `["a", "b"]` | declared                                 | blocked only by `a` or `b`  |

The dangerous reading would be treating absence as "requires nothing", because then a stage
accidentally omitted from a graph becomes _unblocked_ — a mistake in configuration silently
granting work. Over-blocking is the safe failure; under-blocking is not. So absence falls back to
the conservative reading.

To keep that from being merely annoying, the fallback **says so**: when other stages are declared
and this one is not, the blocked reason names the omission — "not declared in the workflow graph,
so every blocking gate is assumed to gate it". An operator sees a fixable configuration gap rather
than an inexplicable block. When _nothing_ is declared, the message stays as it was, because
suggesting a graph to an adopter who has not adopted one is noise.

### 5. `decideActions` stays pure

The association arrives as `StageSnapshot.requiredGates`, resolved by the caller. The policy
performs no lookup, reads no registry, and remains a pure function of state — which is what keeps
every branch reachable in a test without constructing a workspace (ADR-0011).

Whether any association exists at all is derived from the snapshots rather than passed as a flag,
so there is one source for the answer and no way for a flag to disagree with the data.

### 6. A required gate that is not registered blocks

An unregistered requirement can never be satisfied. Ignoring it would run a stage whose gate the
adopter believes is protecting it, so it blocks and the reason names the missing gate.

## Consequences

- A workflow that declares nothing behaves exactly as it did before this ADR. The change is
  additive, and a test asserts the old behaviour specifically so it cannot drift.
- §24's promise holds for a realistic multi-gate workflow, which was the point.
- **This is a public API addition landing immediately before `0.1.0`.** `WorkflowGraph`,
  `WorkflowStageNode`, `AldusContextOptions.workflow`, `StageDefinition.requiredGates`, and
  `StageSnapshot.requiredGates` are all new surface. Changing their shape after publication would
  be a breaking change for every adopter who declared a graph — which is precisely why it lands
  now rather than after. Adding _more_ ways to express the association later stays additive;
  changing what these mean does not.
- `StageDefinition.requiredGates` looks like enforcement and is not. That gap is documented on the
  field itself, because a reader who assumes it stops execution would be wrong in a way that
  matters. If enforcement is wanted later, it belongs in the services layer, which can see both
  registries — not in the runner, which by design cannot see gate state.
- An adopter who declares a graph and omits a stage gets a conservative block with an explanatory
  reason, not a silent grant. That is the intended trade.

## Alternatives considered

- **`GateDefinition.blocksStages?: string[]`** — keeps the knowledge with gates, and inverts §11's
  phrasing ("a stage stops at required gates"). Rejected mainly because it scales badly: a gate
  added late would have to enumerate every stage it gates, and forgetting one silently unblocks
  that stage. The chosen direction fails safe instead.
- **Infer the association from stage execution history** — treat a gate a stage previously halted
  at as gating it. Rejected: it cannot answer for a stage that has never run, which is the case
  the policy exists to decide.
- **Treat undeclared stages as unblocked once any graph exists.** Rejected: see decision 4. It
  makes an omission grant work.
- **Require a graph.** Rejected: it would break every existing caller for a benefit that is opt-in
  by nature, and §11 does not require an adopter to model their workflow as data.
