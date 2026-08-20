# ADR-0045: Reconciliation authority must originate at a boundary Aldus does not yet have

- Status: Accepted
- Date: 2026-08-21
- Relates to: §13.3 Human ownership, §19.2 Actor identity, §19.3 Spend, ADR-0044, #152, #155

## Context

`SpendService.reconcile` releases authorization for money whose amount nobody could measure. §13.3
makes that a human-owned decision, so the runtime has to establish that a human decided it.

Three attempts, and the first two failed the same way.

**A public constructor.** `new OperatorSpendConsole({ actor })` took an arbitrary `ActorRef`,
checked `kind === "human"`, and added the resulting token to a `WeakSet` that `reconcile` then
tested for membership. The membership test is real — a caller cannot forge it with an object
literal — but it proves the token came from the constructor, which proves nothing about who was at
the keyboard. It was described as the `SynthesisPermit` pattern and was not: a permit is minted
*after* the ledger establishes authorization, whereas this minted from the caller's own assertion.

**A public factory.** `openOperatorConsole({ spend, actor })` moved the same parameter one function
outward. Any consumer could still call it with `{ kind: "human", id: "whoever" }`.

The composed path did not repair either, and the reason is the substance of this ADR:

> `AldusContextOptions.actor` is public, and the CLI populates it by parsing the user-controlled
> `--actor` flag or `ALDUS_ACTOR` environment value. This may be an attribution convention for
> ordinary commands, but it is not evidence that a human performed the money-releasing act.

That is correct, and it generalises past this feature. **Aldus has no boundary that authenticates
an operator.** Every actor in the system is self-declared. For recording *who did what* that is
adequate and honest — an audit trail records claims, and §19.2 asks for attribution. For deciding
*whether an act is permitted* it is not evidence at all.

The distinction was invisible because both uses read the same field.

## Decision

**Authority to reconcile originates at a boundary that establishes operator identity or human
presence. Until such a boundary exists, no published surface mints it, and reconciliation is
unreachable rather than weakly guarded.**

Concretely, for as long as the boundary is absent:

- `OperatorAuthority` stays a phantom-branded type whose runtime proof is `WeakSet` membership.
- `OperatorSpendConsole` and `openOperatorConsole` are package-internal. Neither is exported from
  `@aldus-runtime/services`.
- `AldusContext` exposes `spendStatus()` and **no** `operatorConsole()`. Status is read-only and
  answers what is unresolved, which an operator needs and which no authority is required to see.
- `SpendService.reconcile` remains implemented and tested against the internal mint, so the
  protocol is finished and ready for the boundary rather than deferred along with it.
- **No API describes reconciliation as human-enforced**, because today nothing enforces it.

When a boundary arrives — an authenticated session, a signed operator credential, an interactive
confirmation the runtime itself conducts — that boundary becomes the mint, and `OperatorAuthority`
is what it hands over. Nothing else changes.

## Consequences

- An adopter cannot reconcile an unresolved charge through Aldus today. That is the honest state
  and it is visible: `spendStatus` reports the reservation, why it is unresolved, which charges are
  durable and which are pending, so the work can be done against the provider directly.
- The alternative was worse. A reachable `reconcile` guarded by a self-declared actor would have
  been a control that reports success, and an operator would reasonably believe a human decision
  was on the record when the record says only that a caller typed `--actor`.
- `packages/aldus-e2e/test/no-spend-bypass.test.ts` asserts the absence: no exported name yields an
  authority, `AldusContext.prototype.operatorConsole` is undefined, and an assembled authority is
  refused. Absence is the property, so a test is the only thing that keeps it.
- The general rule is the durable part: **a self-declared actor may attribute an act and may never
  authorize one.** Every future permission check has to name where its evidence comes from.

## Alternatives considered

- **Ship the console wired to the CLI actor and document the limitation.** Rejected. A caveat in
  prose does not travel with the call site, and the failure mode is a false record of a human
  decision — the exact class §19.2 exists to prevent.
- **Require a confirmation prompt in the CLI.** Rejected as the answer, though it may be part of a
  future boundary. A prompt in one entry point is not a property of the runtime: the MCP surface,
  a script, and a test harness all reach the same service and none of them prompt. Authority that
  depends on which caller you came through is not authority.
- **Drop `OperatorAuthority` and let `reconcile` take an `ActorRef`.** Rejected: it removes the
  seam the boundary will plug into, and leaves nothing recording that the question was asked.
- **Defer the whole reconciliation protocol until the boundary exists.** Rejected: #152's
  unresolved charges exist now, the protocol is what makes them describable, and `status` — the
  half that needs no authority — is the half an operator needs first.
