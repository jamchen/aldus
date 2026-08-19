# ADR-0033: A release idempotency key identifies the effect, not the bundle

- Status: Accepted
- Date: 2026-08-19
- Relates to: §17 Release, §19.1 Idempotency, §20 Production trace, ADR-0003

## Context

`deriveIdempotencyKey` built its material from the bundle's identity as well as the operation:

```ts
{
  (bundleId, operationId, kind, destination, inputHashes);
}
```

Its own documentation said why the key is derived rather than supplied: _"so a resumed execution
computes the identical key without having to remember one"_. Including `bundleId` defeated exactly
that sentence, because **nothing stores a `ReleaseBundle`** (#40). §17 describes a bundle as
something a caller assembles, and §7's run directory holds receipts, not bundles. So a caller
resuming after a crash rebuilds one — and a rebuilt bundle carries a new id.

Measured before the change, with an otherwise identical bundle:

```
first execution:  3 operations performed
second execution: 3 more            ← same run, same destinations, same digests
```

Every operation re-ran, including the media upload and the visibility transition. The receipts
from the first execution existed and were correct; they simply could not be found, because
`latestByKey` is keyed on a value that had changed for reasons unrelated to what was being
released.

That is the §19.1 failure in full: idempotency keys exist for external side effects, and this one
was stable only for a caller who kept an object alive across a crash.

## Decision

**The key is derived from what the operation does — its kind, its destination, and the digests of
what it releases — and not from the identity of the bundle it happened to arrive in.**

Two bundles agreeing on those three are asking for the same external effect, and §19.1 requires
that effect to happen once. A bundle id is a convenience for a caller assembling work, not a fact
about the world; keying on it made a caller's bookkeeping determine whether a video gets uploaded
twice.

**`ReleaseReceipt` gains an optional `bundleId`, recorded and never keyed on.** Receipts named the
Run and the destination but never the release, so two releases of one Run were indistinguishable
afterwards — a §20 trace gap that only became visible while fixing the key. Optional, so this is a
MINOR schema change under ADR-0003 (`1.3` → `1.4`) and older receipts stay readable.

## Consequences

- Resumption works for a caller who reassembles a bundle, which is every caller, because there is
  nothing to reassemble it from. This is the whole point.
- **Existing stored receipts will not match keys computed by the new derivation.** The first
  execution after upgrading re-runs operations already performed. No adopter has released through
  Aldus yet, so the exposure is nil today, and it is stated here rather than discovered later.
- A deliberate second release of identical bytes to the same destination is now deduplicated
  rather than performed. That is the correct reading of idempotency for an external effect: to
  release something different, something must _be_ different — a new digest, or a new
  destination. If a genuine need for "publish these same bytes again" appears, it needs its own
  ADR and an explicit operation, not a new bundle id.
- Recording `bundleId` on the receipt makes "which release produced this" answerable for the first
  time, and keeps that question separate from "has this effect already happened".

## Alternatives considered

- **Persist the bundle** (#40's own recommendation). Rejected as larger than the problem: it
  requires a new Core schema, a store, and a service taking `(runId, bundleId)`, and it makes
  resumption depend on the runtime having successfully written a bundle before crashing. Deriving
  the key from content needs nothing to have been stored, which is a strictly weaker precondition.
  Persisting a bundle remains worth doing for the ergonomics of "release this Run", and this
  decision does not block it.
- **Keep `bundleId` in the key and require callers to reuse it.** Rejected: it is a rule with no
  mechanism, and the failure mode is a duplicate publish. The runtime cannot tell a reused id from
  a fresh one, so nothing would ever report the mistake.
- **Refuse a second execution when receipts exist under a different bundle.** Rejected as the
  wrong shape: it turns a correctness property into a policy prompt, and an operator who is told
  "this run was released under another bundle" has no way to know whether that matters.
