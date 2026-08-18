# `@aldus-runtime/e2e`

End-to-end tests over the **composed** Aldus stack.

## Why this package exists

Every other package tests itself. Each one is correct in isolation, and per-package test counts
say nothing at all about whether they work **together** — which is precisely how issue #27 was
found: three packages were fully tested and completely unreachable from the operator surface.

So this package drives one Episode through the whole stack the way an operator would, via
`@aldus-runtime/services`, and asserts the things that only exist between packages:

- an artifact a **stage** registered is the artifact the **gate** binds and the **archive** holds;
- an approval the **gate engine** recorded is the approval the **synthesis authorizer** reads;
- a take the **ledger** kept is still there after the process that recorded it is gone;
- a receipt the **release executor** wrote is what stops the next execution publishing twice.

## Why it is private, permanently

It is a test harness, not a product. Nothing here belongs in a consumer's `node_modules`, and
`private: true` is not a placeholder awaiting a version — it is the decision. The fake adapters
are deliberately _fake_: they exist so the stack can be driven without a provider or a platform,
and shipping them would invite someone to depend on them.

## What each suite covers

| Suite                | What only it can prove                                                                                                                                                              |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `journey.test.ts`    | One Episode from `init` to release receipts, in order. Sequence across nine steps.                                                                                                  |
| `resumption.test.ts` | **The most valuable one.** Discards the services mid-flow and rebuilds them over the same directory. Anything that still works was on disk, which is §3.4's claim stated as a test. |
| `collision.test.ts`  | The `req-00.wav` cross-Episode overwrite (§8.1, §1.1) still cannot happen when the registry is reached through a stage and the services rather than directly.                       |
| `findings.test.ts`   | Behaviours composition exposed. **Current behaviour, not endorsed behaviour** — see below.                                                                                          |
| `boundary.test.ts`   | §4.2 locally, so a violation fails where it was written.                                                                                                                            |

## `findings.test.ts` is not an endorsement

Cases there are pinned so a future change is a deliberate decision with a failing test attached,
rather than an accident nobody notices. Where a case describes something that looks wrong, the
comment says so plainly. **A test that quietly encodes a bug as an expectation is worse than no
test**, because it makes the bug load-bearing — so read the comments before treating any of it as
desired behaviour.

The headline one: `decideActions` treats _any_ unsatisfied blocking gate as blocking _every_ unrun
stage, because the model has no stage↔gate association. In a realistic workflow that declares its
gates up front, `status` therefore offers no next action from the very first moment.

## Adding to it

When you add a package to the operator surface, add a scenario here — not a happy path, which
your own package already has, but the thing that can only go wrong once it is composed:

1. **Does its state survive a restart?** Add a case to `resumption.test.ts`. This is the one that
   catches state living only in memory, and nothing else in the repository catches it.
2. **Does a refusal still refuse through the service layer?** A guarantee proven inside a package
   is not proven through two layers of wiring. Assert the adapter was never reached — a call
   count, not a spy on the thing that decides.
3. **Does the trace still answer §20's questions** once your events are interleaved with everyone
   else's?

Prefer reproducing the real failure over asserting a mock was called. The `req-00.wav` suite is
the model: show the overwrite happening, then show it cannot.

## Running

```bash
npm test --workspace @aldus-runtime/e2e
```

Every scenario uses a real temporary directory under the system temp dir and removes it
afterwards. Nothing is mocked at the filesystem layer, deliberately: a mocked store would leave
exactly the durability and crash behaviour this package exists to prove untested.
