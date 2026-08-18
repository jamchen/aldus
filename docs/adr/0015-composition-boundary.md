# ADR-0015: Aldus composes its own packages; adopters supply adapters

- Status: Accepted
- Date: 2026-08-18
- Closes: the composition half of the question raised on issue #27
- Relates to: §4.1 Aldus Core owns, §4.2 Aldus Core does not own, §4.3 Integration owns, §18 CLI
  and Production MCP, §21 Repository and open-source boundary

## Context

Contract §22's twelve work packages each produced a focused package, and each was correct in
isolation. Assessing them against §24 surfaced a gap nobody's tests could see: `@aldus/services`
— the programmatic API §18 requires, and the layer the CLI and Production MCP adapt — reached
only three of the packages built. `@aldus/artifact-registry`, `@aldus/tts-ledger`, and
`@aldus/release` were unreachable from any operator surface. An operator could not execute a
release or record a synthesis take.

Two readings of §4.3 were available, and they lead to very different products.

The first: §4.3 places "current production scripts wrapped as Workers", "provider and release
configuration", and "private artifacts and credentials" in Integration, so composing the runtime
is an adopter concern and Aldus ships libraries.

The second: §4.1 places "CLI and Production MCP semantics" in Core, and §18 states that core
behaviour MUST be available through a programmatic API with the CLI and MCP as adapters over the
same application services. Composition is therefore Core's job, and only the concrete adapters
are the adopter's.

Left undecided, the first reading wins by default — not because it is better, but because
nobody has to do anything for it to happen.

## Decision

**Aldus composes its own packages. Adopters supply adapters, not orchestration.**

Concretely, the boundary is:

| Aldus owns                                        | The adopter supplies          |
| ------------------------------------------------- | ----------------------------- |
| Wiring the packages together                      | Concrete synthesis adapters   |
| Defining the injection points                     | Concrete release adapters     |
| Enforcing policy at those points                  | Knowledge Packs               |
| The operator-facing contract (services, CLI, MCP) | Workers                       |
| Orchestration, sequencing, and refusal            | Configuration and credentials |

Three consequences follow directly, and they are the operative content of this ADR:

1. **`@aldus/services` reaches every package an operator needs.** A package that exists but is
   unreachable from the service layer is an unfinished package, not a library.
2. **Injection points are Core's, and are typed.** `AldusContext` already takes a caller-supplied
   `GateRegistry` and `StageRegistry`; `ReleaseAdapter` and a synthesis adapter are the same
   shape. Aldus never imports a concrete adapter — §4.2 forbids it — but it defines the interface,
   decides when the adapter is called, and refuses when policy is unmet.
3. **Policy is enforced on Aldus's side of the injection point, never delegated to the adapter.**
   An adapter that could reach a provider without a valid `permitSynthesis` authorization would
   move §13.2's enforcement into adopter code, where Aldus cannot guarantee it. The adapter
   performs the call; Aldus decides whether it may.

**An adopter must not have to reconstruct Aldus's service orchestration.** That is the test to
apply to any future package: if using it correctly requires an adopter to re-derive a sequence
Aldus already knows, the wiring belongs here.

## Consequences

- The five items on issue #27 are in scope for this repository: registry-backed artifact
  services, release execution and reconciliation services, TTS ledger services with an injected
  synthesis boundary, the CLI and MCP surfaces for all three, and an end-to-end composed-stack
  test using fake adapters.
- `@aldus/services` becomes the widest package in the workspace by dependency count. That is the
  intended shape: it is the composition root, and a composition root that depended on little
  would not be composing much.
- Every new injection point is a new place policy can be bypassed if it is enforced on the wrong
  side. Each one needs a test proving the refusal, not merely proving the happy path.
- Aldus's own tests must exercise the composed stack with fake adapters. Without that, the
  composition is only asserted by the type checker, and the first adopter discovers whatever the
  types did not catch.
- This ADR does **not** license Aldus to acquire adopter-shaped knowledge. §4.2 is unchanged: no
  provider, platform, cloud, show, host, or adopter name enters this repository, and the CI
  boundary job continues to enforce it.

## Alternatives considered

- **Ship libraries; let adopters compose.** Rejected. It contradicts §4.1's placement of CLI and
  MCP semantics in Core and §18's requirement that core behaviour be available programmatically.
  It also guarantees that every adopter re-derives the same sequencing, and that each gets the
  §13.2 and §17 refusal logic subtly wrong in a different way — the single most expensive class
  of error this runtime exists to prevent.
- **Compose in a separate `aldus-app` package above services.** Rejected as a rename: it would
  make `@aldus/services` a partial API and move the composition root one level up without
  changing who owns it. §18 names one programmatic API, not two.
- **Import concrete adapters into Aldus behind feature flags.** Rejected outright — §4.2 forbids
  it, and a flag does not change what the dependency graph contains.
