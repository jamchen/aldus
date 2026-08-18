# ADR-0016: Service composition and the shape of an injection point

- Status: Accepted
- Date: 2026-08-18
- Closes: items 1–3 of issue #27
- Relates to: §4.2, §4.3, §7, §8.1, §13.2, §13.4, §15, §17, §18, §20, ADR-0004, ADR-0005,
  ADR-0009, ADR-0011, ADR-0012, ADR-0013, ADR-0015

## Context

ADR-0015 decided that Aldus composes its own packages and adopters supply adapters rather than
orchestration. That settles _who_ wires things together; it does not say what a wired injection
point looks like, and the difference between a safe one and an unsafe one is not a matter of
taste.

Three packages needed wiring, and they are not the same problem:

- `@aldus/artifact-registry` needs no adapter at all. Wiring it is plumbing.
- `@aldus/release` needs an adapter that talks to a destination, and an authority decision that
  `@aldus/gate-engine` already owns.
- `@aldus/tts-ledger` needs an adapter that spends real money, guarded by §13.2 — the sharpest
  safety requirement in the contract, and the one where a mistake is irreversible.

ADR-0015's rule is that policy sits on Aldus's side of every injection point. That rule has an
obvious weak implementation — check a condition, then call the adapter — and it fails in a
specific way: the guarantee lives in the _order of two statements_, so any later edit that adds a
second call site, an early return, or a retry loop silently removes it, and nothing fails until
money has been spent on unapproved content.

## Decision

### 1. Artifact services are registry-backed, and pre-registry runs stay visible

`services.artifacts()` reads the registry, and reports lineage, archival state, and cleanup
planning that §7's `artifacts.json` cannot carry. `artifactLineage`, `planArtifactCleanup`, and
`archiveIrreplaceable` join it, so §8.1's ordering — archive irreplaceable bytes _before_ cleaning
working files — is reachable rather than theoretical.

§7's collection is still read, and entries the registry does not hold are reported in a separate
`unregistered` list rather than merged into `records`. Merging would present an entry as carrying
provenance and archival state nobody ever collected. §3.4 makes the durable record authoritative,
and two durable records that disagree is the worst available outcome — so they are shown as what
they are: two records, one of which the registry never saw.

`archiveIrreplaceable` is scoped to one Run rather than calling the registry's workspace-wide
sweep. The caller asked about a Run; archiving another Run's artifacts would be a side effect
nobody requested, however benign archiving is.

### 2. Release: adapters injected, authority consumed, reconciliation not optional

`AldusContextOptions.releaseAdapters` takes what an adopter supplies. Aldus owns the bundle
orchestration, the idempotency keys, and the refusals.

Authority comes from `@aldus/gate-engine` and is never re-decided. The executor is built **per
Run**, because `gateEngineAuthorizer` reads subjects through a zero-argument function and the Run
has to be captured — and reading subjects afresh on each check is what makes an approval that has
since drifted refuse at the moment of release rather than at planning (ADR-0009).

**There is no way to ask the services to skip reconciliation.** `@aldus/release` exposes a
`reconcile: false` switch so its own tests can demonstrate the duplicate publish that
reconciliation prevents. Surfacing that switch here would make double-publishing a caller's
option, which is precisely the policy-on-the-wrong-side error ADR-0015 forbids. An operation whose
outcome was never confirmed and whose destination cannot be queried is refused, not retried.

A required operation without authority and an unconfirmable outcome both arrive as thrown
`AldusError`s from `@aldus/release`, and both are mapped to `refused` rather than propagated.
§18's contract is that "not permitted right now" is an ordinary answer; letting these surface as
exceptions would force every adapter into try/catch to learn something it needs to _display_
(ADR-0011's three-way result exists for exactly this).

### 3. Synthesis: the adapter is unreachable, not merely guarded

This is the decision the rest of the ADR exists for.

- The synthesis adapter is held **only** inside `SynthesisGateway`, in a private field. Nothing on
  `AldusContext` or `AldusServices` exposes it; `hasSynthesisAdapter` answers whether one exists
  and `adapterId` answers which, and neither hands it over.
- `SynthesisGateway` has exactly **one** method that reaches the adapter, and that method performs
  §13.2's authorization itself. There is no public "call the adapter" entry point to forget to
  guard, so the guarantee is not a property of statement order.
- The permit handed to the adapter is branded with a `unique symbol` that is declared and never
  exported, so the type cannot be named outside the module without a cast. The brand is a phantom,
  present only in the type — following the pattern `@aldus/release` uses for operation
  criticality. The **runtime** proof is membership of a module-scoped `WeakSet` that only a
  successful authorization adds to, which a cast cannot manufacture.

The `WeakSet` is module-scoped rather than per-gateway because a gateway is built per plan and an
adapter has no way to know which instance called it. Membership still means exactly one thing:
this object was minted after a §13.2 authorization succeeded.

### 4. The authorizer verifies that the approval actually bound the plan

`gateEngineSpendAuthorizer` runs two checks. The first is `GateEngine.authorizeSpend` — gate
satisfied, decision matching the grant, amount within the ceiling. That is §13's machinery,
consumed rather than re-decided.

The second is enforcement Aldus adds. The approved decision's `subjectHashes` must contain every
digest `planSubjectDigests` says §13.2 requires bound for _this_ plan. Without it, a caller who
wired `subjects` to something unrelated would get a satisfied gate that had approved nothing about
the plan, and §13.2's binding would exist only as a naming convention. Aldus cannot force a caller
to wire `subjects` correctly — but it can refuse to spend money when they did not, and name which
digest is missing.

### 5. Ledger state is file-backed under `.aldus/tts/`, not a new §7 collection

`@aldus/tts-ledger` ships only in-memory stores, correctly: §7 keeps core models independent of
physical storage. Wiring it to something durable is composition, so the file-backed stores live
here.

They are **not** §7 run collections. `RunCollectionName` is closed over §7's four files, and takes,
plans, and scripts are none of them. Widening a Core-side type — which every store implementation
would then have to satisfy — to fit one package is a larger claim than a sibling directory, and
`@aldus/artifact-registry` already set the precedent with `.aldus/artifacts/`. §7 calls its layout
"recommended".

Each file has its **own** lock resource, never the Run lock. `FileEventStore.append` takes the Run
lock to assign an event sequence and locks are not re-entrant (ADR-0005), so a store holding the
Run lock while the ledger emitted an event would be refused outright. Appends write back the raw
parsed array with one element added, so ADR-0004's preservation rule holds with no merge to get
wrong.

### 6. `recordUnauthorizedCharge` is exposed, and is not a synthesis path

ADR-0012 added it so §20 can answer what something cost when §13.2 was not satisfied. It is
reachable through the services because a record nobody can write is not a record — but it performs
no synthesis, cannot reach an adapter, and reports `adapterId: "none"`. Recording that a charge
happened is not the same as being allowed to incur one, and a test asserts the adapter is untouched.

## Consequences

- `@aldus/services` now depends on seven workspace packages and is the widest in the repository.
  That is the intended shape of a composition root (ADR-0015).
- Every injection point is a place policy could be enforced on the wrong side, so each has tests
  written as **bypass attempts** rather than happy paths with an assertion appended: no gate, an
  unapproved gate, an approval over the wrong subjects, a missing ceiling, a superseded decision,
  a drifted plan, and a forged permit. Each asserts `adapter.calls.length === 0`, because that is
  what "no money was spent" means.
- The synthesis design costs an indirection: a caller cannot hold the adapter and call it directly
  even when that would be convenient. That is the point.
- Building the release executor and the ledger per call rather than once is a small allocation per
  operation, accepted so that authority and plan binding are re-read every time instead of cached
  into staleness.
- An adopter must still wire `subjects` to the plan's digests for synthesis to be permitted. Aldus
  cannot do it for them — what a gate binds is adopter process (§4.3) — but decision 4 makes the
  consequence of getting it wrong a refusal rather than an unapproved charge.

## Alternatives considered

- **Check authorization, then call the adapter.** Rejected: see Context. The guarantee would live
  in statement order, and the failure mode is spending money on unapproved content.
- **Expose the adapter and let callers authorize.** Rejected outright — it moves §13.2's
  enforcement into caller code, which is the inversion ADR-0015 exists to prevent.
- **Trust `subjects` wiring for plan binding.** Rejected: it makes §13.2's most important
  requirement depend on a convention Aldus never checks. Decision 4 costs one set comparison.
- **Add takes, plans, and scripts to `RunCollectionName`.** Rejected: it widens a Core-side closed
  type that every store must implement, to serve one package's storage need.
- **Surface `reconcile: false` for parity with `@aldus/release`.** Rejected: parity is not a
  goal, and the switch exists there to demonstrate a failure, not to offer it.
- **Merge unregistered collection entries into `records`.** Rejected: it would fabricate
  provenance and archival state, and the whole value of the registry is that those are collected
  rather than assumed.
