# ADR-0012: PerformanceScript origin, take lineage, and repair scoping

- Status: Accepted
- Date: 2026-08-18
- Closes: §25 item 6 (whether PerformanceScript remains derived or becomes authored)
- Relates to: §8.1, §12.4, §13.2, §13.3, §14, §15, §19.3, ADR-0004, ADR-0006, ADR-0007, ADR-0009

## Context

§14 places a representation between approved narration and a provider request, and §15 wraps a
quality loop and a ledger around the paid call. Between them they state a great deal about what
must be recorded and very little about how.

Four questions had no stated answer.

**§25 item 6 is open by name:** "Whether PerformanceScript remains derived or becomes an authored
artifact after V1." §14.2 leans one way — an adopter "MAY continue authoring Audio Tags inside its
current format initially", an adapter "SHOULD parse the legacy format into a derived
PerformanceScript", and the source format "SHOULD change only after the structured representation
has proven stable" — but explicitly does not settle it.

**§15 requires lineage without defining it.** A record must carry "fallback or regeneration
lineage", and §15.1 requires rejected paid takes to be "retained with unique identity". Neither
says what connects one take to the next.

**§12.4 requires a repair to identify "the smallest safe layer"** and lists five, but nothing says
how a repair is recorded or how a caller knows which ones change approved content.

**§15.2 lists seven lexicon scope dimensions**, three of which — provider, voice, model — are
exactly what §4.2 forbids the runtime from naming.

Underneath all four sits the constraint that makes this package's shape unusual: §15.1 states
"Aldus MUST NOT silently retry paid requests without policy and cost authorization", and §13.2
forbids paid synthesis before an operator has approved five specific things. The package that
records synthesis is the one best placed to accidentally cause it.

## Decision

### 1. The package cannot perform synthesis, and that is enforced

There is no method that calls anything. The package imports no network module, declares no
dependency outside `zod` and the `@aldus/*` workspace, and exposes no hook that takes a
caller-supplied performer and invokes it. A Worker supplied by an integration performs the call
(§3.2, §4.3) and reports the outcome back.

This is a structural claim, so tests read the package's own source and assert it: no `node:http`,
no `fetch(`, no `child_process`, no dependency outside the allowed set, and no
`synthesize`/`callProvider`-shaped method. §15.1 asks that Aldus never silently retry a paid
request, and the strongest available form of that is a component with no way to make one.

Those checks scan **code with comments stripped**, while the §4.2 provider-name checks scan the
whole file. The distinction is not fussiness: the first draft matched the prose "a plan will
synthesise (contract §13.2)" and reported a clean file as suspicious. A guard that fires on its
own documentation gets deleted, and then nothing is guarding.

### 2. `origin` is a discriminator, defaulting to derived — closing §25 item 6

A `PerformanceScript` records `origin: "derived" | "authored" | "tagged"`, and a derived script
must carry the adapter, source format, and source digest that produced it.

This closes §25 item 6 in the direction §14.2 points, without foreclosing the other. Both states
are representable from the first release, so promoting an adopter from derived to authored is a
change of _data_, not a schema migration — which is what makes it the smaller reversible option
under §25's own instruction. Recording the source digest means a later change in _parsing_ is
attributable to the adapter rather than appearing as a change in the _content_, which is the
failure mode that would otherwise make derivation untrustworthy.

`tagged` is separate from `derived` because §14.3 subjects generated tags to Performance Freeze.
An operator approving a performance needs to see that a machine proposed it and whether anyone has
edited it since; collapsing that into `derived` would hide it.

### 3. Lineage is a chain, and a superseding take must state its repair

A take supersedes at most one earlier take. A graph would let two takes claim one predecessor, and
then "what replaced this?" has two answers and neither is wrong.

A take carrying `supersedes` must also carry a `repair` naming its rung on §12.4's ladder. A retry
that records no rung says something was tried again but not what changed — precisely what §12.4
asks a repair to identify. The rungs are stored in §12.4's own order, smallest first, so "prefer
the smallest safe layer" is readable from the data rather than being advice in a comment.

Only `narration_rewrite` is marked as changing approved content. The **gate engine performs the
invalidation**, derived from subject digests moving (ADR-0009); this package only says which
repairs are expected to trigger it, so a caller can warn an operator before they take one.
Duplicating the invalidation logic would give two answers to one question.

Ordering follows the `supersedes` chain, never timestamps. A timestamp says when a record was
written; the chain says what replaced what, and after an out-of-order write those disagree.

### 4. A decision is recorded once

§13.3 keeps final performance approval human-owned. A decision that could be overwritten would
make "who approved this, and when" unanswerable — the exact question §20's production trace
exists to answer. Changing one's mind is a **new take superseding the old**, which is also what
preserves the rejected take §15.1 requires kept.

A rejection must carry a reason; an acceptance need not. A rejection without a reason cannot
become a repair strategy (§15.1) or a regression case (WP-10), whereas an unelaborated acceptance
loses nothing.

### 5. A paid take is refused unless its authorization currently holds

`recordTake` refuses when a take carrying a cost cites no authorization, cites a superseded
decision, or cites one that covered a different request plan. The ledger asks a `SpendAuthorizer`
port — satisfied directly by `GateEngine.authorizeSpend` — and never grants authorization itself.

The refusal is deliberately at _recording_, and it needs stating plainly: this does **not** stop
money being spent, because the spend already happened before anyone called this method. What it
stops is the ledger asserting that spend was authorized when it was not. §13.2's real enforcement
point is `permitSynthesis`, before the Worker runs.

That leaves a gap: a Worker that calls a provider without checking, then reports back, produces
real spend the ledger would refuse to record. **The trace is then missing a charge that
happened** — and §20 requires production trace to answer "what it cost". A charge that occurred
yet appears nowhere is a larger harm than an ugly record.

`recordUnauthorizedCharge` closes it. The take is admitted and marked with
`TakeRecord.unauthorizedCharge` — the reason, the rejected authorization if one was cited, and
who acknowledged it — and a distinct `tts.charge.unauthorized` event is emitted so it is
greppable rather than hidden among ordinary recordings. The ordinary `recordTake` path still
refuses, so this is an explicit escape hatch and not a bypass.

It deliberately carries **no policy**. Whether such a take may be accepted, whether it must be
escalated, and what it means for a budget are decisions this package does not own; capturing
reality is not the same as condoning it. Separating the two is what allows the record to exist
before anyone has decided what to do about it.

### 6. Lexicon scope stays caller-supplied, and normative conflicts are reported

Scope is `Record<string, string>` throughout, and resolution mirrors WP-09's model: most specific
wins, **authority outranks specificity**, and a tie between normative entries is reported rather
than resolved (§9.2: "Silent last-write-wins behavior SHOULD be avoided for normative rules").

Specificity counts dimensions rather than ranking them. §15.2 lists seven without ordering them,
and any ordering invented here would silently decide which of two rules wins — the class of
failure §9.2 asks to be made detectable.

## Consequences

- The `SpendAuthorizer` port means an adopter can wire any authority model without this package
  taking a position on gate composition (§4.3), and the ledger stays testable without the gate
  engine.
- `PerformanceSegment.pronunciationRefs` points at lexicon entries rather than inlining a spoken
  form. Copying the form in would freeze one revision of a rule meant to be revisable — but it
  also means a take's audio cannot be fully explained from the take alone; the lexicon as it stood
  at synthesis time is needed too. Recording the resolved lexicon snapshot on a take would fix
  that and is not done here.
- Cost lives on a referenced `CostRecord`, not copied onto the take. One number, in the place
  budgets are actually computed from (§19.3).
- The structural source-scanning tests are unusual and will need updating if the package ever
  legitimately needs a `node:` module. That cost is accepted: the alternative is a property nobody
  checks.

## Alternatives considered

- **Let the ledger call a provider adapter.** Rejected: it would put the ability to spend money in
  the component whose job is to be the honest record of spending, and §15.1's prohibition on silent
  retries becomes a matter of discipline rather than structure.
- **Make PerformanceScript authored-only, treating derivation as migration tooling.** Rejected:
  §14.2 explicitly expects adopters to keep their authoring format initially, so authored-only
  would block the adoption path the contract describes.
- **Store an `invalidatesContentFreeze` flag on the take.** Rejected: invalidation is derived from
  subject drift (ADR-0009), and a stored flag is exactly the stale-marker failure that ADR forbids.
- **Rank lexicon scope dimensions (voice beats show beats global).** Rejected: §15.2 gives no
  ordering, and inventing one would silently resolve conflicts §9.2 requires be surfaced.
- **Allow a decision to be amended.** Rejected: §13.3 and §20 both depend on a decision being a
  fixed point. Superseding costs one extra record and keeps the history §15.1 requires anyway.
