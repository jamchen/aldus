# ADR-0048: Repeatability is a property of the operation, declared in the bundle

- Status: Accepted
- Date: 2026-08-21
- Relates to: §13.4 Release approval, §17 Release, §19.1 Idempotency, ADR-0013, #169

## Context

An adopter's bundle publishes a temporary marker with an upload and removes it with a best-effort
cleanup once the receipt is durable. The cleanup **cannot** answer `ReleaseAdapter.lookup`, for two
reasons that are both properties of the Runtime rather than of the destination:

- **Reconciliation runs before execution.** `execute` calls `reconcile` first, so when the cleanup
  is asked, the upload in the same bundle may not have happened. The marker's absence then means
  _"nothing is published"_, not _"the marker was removed"_ — and a `succeeded` receipt written from
  that reading strands the marker on a published video permanently, because a repaired receipt is
  terminal in both directions.
- **An honest failure takes the release down.** `reconcile` awaits `adapter.lookup(request)` inside
  a loop over every operation with no `try` anywhere. A quota error raised while asking about a
  tidy-up aborts the pass before a single `execute`.

So the adapter returned `{ exists: false }` without reading the channel, and the executor recorded
`action: "confirmed_absent"` — **a durable statement that a search was performed and found
nothing, when nothing was read.** That is the harm: not a missing field, but a record asserting
more than what established it.

The asymmetry has three sites in the Runtime and only the third is right. `reconcile` aborts on any
`lookup` throw. `execute` throws `RECONCILIATION_UNAVAILABLE` on a `pending` receipt **before
consulting criticality**, so a best-effort tidy-up whose outcome went unanswered once refuses every
later release of that bundle — which the adopter avoided by making sure the cleanup never returns
`pending`, the same gap's second forced workaround. Only `execute`'s outcome handling gets it
right: a best-effort failure becomes a warning and the release continues.

The same operation may fail to be _performed_ without consequence, may not fail to be _asked
about_, and may not have failed to be _confirmed_ in the past.

## Decision

**Repeatability is a property of the operation, declared in the bundle.**

The rejected alternative is instructive. A third `RemoteState` state — _held_, _not held_, _cannot
say_ — looks like it subsumes this, and it does not: the cleanup is not saying "I cannot answer".
It is saying something stronger and simpler, **repeating this effect is safe**, which is known when
the bundle is written and is the same fact on every pass. Modelling it as an answer about remote
state would make a static property into a per-call opinion.

### In the bundle, not on the adapter

§13.4 binds a release approval to the bundle, so a fact that licenses re-performing an external
effect must be visible in the artifact an approver approved. An adapter-side flag would let an
adapter license repeating an operation the approver believed happened once.

Nor is it inferable. `deriveIdempotencyKey` documents its result as the key that makes re-running
safe, and that holds only where the destination honours the key — plenty do not. A key's presence
is a request, not a guarantee.

### Minted, with a required reason

`repeatable(reason)` returns a branded `RepeatableDeclaration`, unassemblable as an object literal
for the same reason `RequiredOperation` is: a shape a caller can write is a shape that gets written
from configuration by someone who has not thought about it. The reason is required and refused when
empty — an operation that may be repeated is one an approver is being asked to accept the
repetition of, and "safe to repeat" with no account of why is not something anyone can approve or
audit.

**And checked at runtime, because the type is not the enforcement.** `assertBundleValid` refuses a
declaration that is not one — a non-object, a missing reason, a reason that is not a string, or a
blank one. A caller can write `{ reason: "" } as RepeatableDeclaration`,
and the code that will assemble operations from configuration is exactly the code that does — the
argument this codebase has now had to apply three times, at `executionId`, at `maxSpend`, and here.
It took two passes, and the second is the more instructive. The first version validated only in the
constructor, so a cast produced an operation treated as repeatable whose warning ended in a bare
colon where the justification should be. The second read `repeatable.reason.trim()` — **the check
written to stop a cast made the assumption it exists to prevent.** `repeatable: true`, the single
most likely thing someone writes in a config file when they mean this, threw a bare `TypeError`:
fail-closed, so nothing unsafe, but with no code, no bundle or operation id and no sentence saying
what was wrong, arriving from exactly the source the check's own comment named.

Every malformed shape is now one table in the tests, so a fifth is a row rather than a
rediscovery. Higher stakes
than the usual version: the declaration licenses an external effect happening twice, and §13.4
binds approval to the bundle, so a blank reason is an approval of nothing.

**Absence means one-shot.** That is the conservative reading and the behaviour every existing
bundle already has; repetition is licensed only by saying so. This is deliberately an optional
field rather than a required closed one, because the two readings of absence that usually make an
optional field wrong — _"nobody said"_ versus a substantive answer — collapse here into a single
safe meaning.

### What it settles

- **`reconcile` does not query a repeatable operation.** The answer would change nothing, so no
  adapter has to fabricate one. The finding is `not_reconciled_repeatable`, carrying the declared
  reason.
- **`confirmed_absent` is true again by construction.** It is now produced only by a `lookup` that
  returned `exists: false`. Every other reason an operation might not have been found has its own
  action.
- **A `pending` receipt on a repeatable operation licenses re-execution** instead of refusing, with
  a warning naming the reason.

Fail-closed stays where a mistake publishes twice. It stops being where a tidy-up could not be
queried.

## Consequences

The ruling asks whether this is additive, and the answer differs by audience — which is the point
of asking.

- **For an adapter: additive.** `ReleaseAdapter` is untouched. An adapter that implements `lookup`
  is simply asked less often, and one that does not is unaffected.
- **For an adopter composing the executor: additive.** An operation that declares nothing behaves
  exactly as it did. Every new behaviour is opt-in, and the opt-in is a function call.
- **For a consumer that reads the types: not additive.** `ReconciliationFinding.action` gains a
  fifth member. Code that switches exhaustively on it, or assigns it to a narrower union, stops
  compiling. A widened return union is a breaking change for a reader even when it is invisible to
  a writer, and calling the whole change "additive" would be true of two audiences out of three.

Also:

- **The warning filter became an allow-list.** It was a deny-list — any finding carrying an
  explanation except `confirmed_absent` — which meant every action added later was opted in by
  default, with nobody deciding. `not_reconciled_repeatable` was opted in exactly that way and
  appeared in the warnings of every ordinary release of a bundle holding a repeatable operation,
  reporting that the expected thing had happened.

  Membership now answers the question a warning asks — _did something go differently than
  intended?_ `repaired` and `unavailable` yes; `confirmed_absent` and `not_reconciled_repeatable`
  no. Adding an action requires either adding it here or leaving it out, and both are decisions.

  A deny-list on a growing union is the general defect: the safe default is silence, and it was
  configured as noise.

- Mechanism two — a third answer for an operation that is reconcilable in principle and cannot be
  established _now_ — remains open and independent (#169). This ADR does not address it.

## Alternatives considered

- **A third `RemoteState` state.** Rejected above: it models a static property of the operation as
  a per-call answer about the destination, and it puts the declaration on the adapter where §13.4
  says it must be in the bundle.
- **An explanation on `confirmed_absent`.** Rejected: the cause is an adapter with no way to
  decline the question, and `exists: false` being the only sentence available. An explanation would
  make the false statement better documented.
- **Inferring repeatability from `idempotencyKey`.** Rejected: the key is honoured by the
  destination or it is not, and the runtime cannot tell which.
- **A boolean field.** Rejected for the reason `QualityEnforcement` is not a boolean: this licenses
  a real external effect to happen twice, and a bare `repeatable: true` is a thing someone flips in
  a config file without producing a justification anyone reviewed.
