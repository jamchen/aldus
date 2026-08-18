# ADR-0014: Production MCP trust boundary

- Status: Accepted
- Date: 2026-08-18
- Closes: architecture contract §25 item 8 (Production MCP authentication and local permission model) — partially; see "What this does not settle"
- Relates to: §18 CLI and Production MCP, §18.1 Data MCP vs Production MCP, §10.1 Claude Code Backend, §10.2 Remote Control, §19.2 Security, §3.6 Human review, §13.3 Human Ear Gate, ADR-0002, ADR-0011

## Context

WP-08 established that the CLI and the Production MCP are two adapters over one service layer
(ADR-0011), which settles most of what this package would otherwise have to decide. What it does
not settle is why an MCP adapter is more than a second renderer.

§18.1 is the reason:

> Data-source MCP servers and production-control MCP servers MUST remain separate trust
> boundaries.
>
> - Read-oriented data tools MAY be broadly available.
> - Mutating production tools MUST validate workspace, Episode, Run, actor, permissions,
>   idempotency, and relevant approvals.
> - Paid synthesis and publishing operations MUST require explicit scoped authority.

A CLI needs none of this. Whoever holds the shell already holds the machine, and the actor comes
from a flag the person typed. An agent holding an MCP session holds neither, and §10.1 spells out
what it must not become:

> Claude Code MUST NOT be: the only state store; the sole audit trail; implicitly authorized to
> incur paid TTS cost; implicitly authorized to publish; relied on to remember approvals across
> sessions.

The word doing the work is _implicitly_. Authority that arrives with the session is implicit
authority, and so is authority that arrives in a tool argument, because the agent composes the
arguments.

Underneath sits a constraint that shapes everything else: **an MCP server cannot verify that a
human decided anything.** It receives a tool call. It does not see the conversation, cannot tell
whether the operator read what they were approving, and must not take the agent's word for it.

## Decision

### 1. Read and mutating tools are two types, not one list with a flag

`ReadTool` and `MutationTool` are separate types with separate constructors. A read tool cannot
be placed in the mutation list or the reverse — the compiler refuses — and a phantom brand keeps
a hand-written literal from bypassing the constructors, which is where capabilities are attached.

WP-12 reached the same conclusion for hard-gate versus best-effort release operations, for the
same reason: a boolean field is set at a call site far from its consequence, and setting it
wrongly makes a mutation look broadly grantable. Two `@ts-expect-error` tests, live under
`typecheck:test`, pin the separation.

A `MutationTool` cannot be declared without capabilities: the field is required and non-empty by
type. A mutation with no declared authority would be broadly grantable by accident.

### 2. Capabilities name runtime operations, and are granted only by host configuration

`aldus:read`, `aldus:workspace:init`, `aldus:run:start`, `aldus:stage:run`, `aldus:stage:force`,
`aldus:gate:decide`, `aldus:spend`, `aldus:publish`.

These name **Aldus operations**, not adopter concepts, which is why Core-side code may enumerate
them at all (§4.2). "May this caller start a Run" is a question about the runtime. "May this
caller publish to a particular destination" would be a question about an adopter's platforms, and
is deliberately not asked here.

A `CapabilityGrant` is constructed once, from host configuration, and copies its input. Nothing
reachable from a tool call can widen it — a grant that could grow at runtime would let a tool
call escalate the session it arrived on.

`aldus:stage:force` is separate from `aldus:stage:run` because ADR-0008 refuses auto-takeover
precisely so two runners cannot execute one side-effecting stage at once. Deciding another holder
is dead is a judgement §19.1 places with an operator, not with whoever wanted the stage to run.

### 3. Scoped authority for cost-incurring work is derived per call

A stage that declares `CostPolicy.requiresAuthorization` additionally requires `aldus:spend`.
The requirement follows from _what is being asked_, not from which tool was called, so it is
computed per call from the registered definition.

An unresolvable stage is treated as **requiring** the capability. Guessing "free" for a stage
nobody can identify is the wrong default when the question is whether money can be spent.

This layer is **additional to, never instead of**, the gate engine. Holding `aldus:spend` does
not authorize spend: §13.2 still requires a hash-bound `GateDecision` and WP-05 still evaluates
it. The capability decides only whether this caller may reach the attempt. Two independent
checks is what "separate trust boundaries" means.

### 4. The recorded actor is the agent unless the host attests otherwise

This is the sharpest decision here, and it is deliberately stricter than convenient.

An operator identity is supplied at construction with a `confirmation`:

- `ambient_configuration` — the host has an operator in config. That names who is accountable for
  the session. It does not attest they saw this call. **The recorded actor is the agent**, with
  the operator carried in `displayName` as the party it acted for.
- `per_call_confirmed` — the host has out-of-band evidence that this human confirmed this
  specific call. Only then is the operator the actor, and the agent session is still recorded in
  `sessionRef` so the channel stays visible.

Ambient is the default because it is the common case and the safe one.

The failure being avoided is specific: a `GateDecision` that reads `kind: "human"` when an agent
made the call. That is not a smaller problem than an unrecorded approval — it is a **forged**
one, and nobody reviewing the record afterwards can tell. §13.3 keeps final performance approval
human-owned exactly so that cannot happen, and §3.6 counts a decision only when it is "translated
into a recorded decision tied to exact inputs".

An operator identity whose actor kind is not `human` is refused at construction. The slot names a
person; allowing an agent into it would recover the impersonation by another route.

### 5. No tool accepts an identity or approval argument

There is no `approved`, `approvedBy`, `actor`, `onBehalfOf`, or `confirmed` argument on any tool,
and a test asserts none appears. §18.1 forbids it, and the reasoning is simple: the agent composes
the arguments, so an approval an agent can assert is not an approval.

### 6. Workspace binding is fixed at construction

`workspaceRoot` is required, never defaulted to the working directory, and no tool takes a
workspace argument. §19.2 requires the binding to be explicit; a workspace argument would let one
session wander between workspaces, with the caller choosing per call which durable state to
change. Every result echoes the bound root so neither the agent nor an operator reading the
output has to infer what was touched.

### 7. Unpermitted tools are listed, not hidden

An agent that cannot see a tool concludes the capability does not exist and works around it — by
asking the user to run something manually, or by inventing a path. An agent that sees a tool
marked `permitted: false` asks the operator to grant it, which is the outcome the boundary is
meant to produce.

### 8. No transport dependency

The package ships no MCP SDK dependency. `listTools()` returns what a `tools/list` response
needs and `callTool()` what `tools/call` needs; the host wires its own transport, and the README
shows how.

`@modelcontextprotocol/sdk` resolves from npm at 1.30.0, so this is not a availability problem —
it is a weight one. It brings express, hono, cors, jose, eventsource, and a dozen more, into a
repository whose Core has exactly one runtime dependency. §10.2 requires Aldus to remain operable
if Remote Control "changes or disappears", and the tool contract plus the trust boundary is the
deliverable; a transport is replaceable and the host usually already has one.

### 9. Tool schemas reject unknown arguments

Unlike the stored-record schemas ADR-0002 strips `additionalProperties: false` from. That rule is
about forward compatibility of _persisted records_: a reader must not reject a record written by
a newer minor version. Tool arguments are neither persisted nor versioned, so an unrecognised
argument is a mistake the agent should hear about at once, not a field from the future.

## Consequences

- WP-11 stayed thin. Every service call is one line; nothing here re-decides a gate, a retry, or
  an invalidation, so a change to any of those reaches the CLI and MCP together.
- An agent operating with an ambient operator produces `GateDecision` records attributed to the
  agent. That is correct and it is also visible: production trace will show agent-decided gates,
  which is the honest picture of how the work happened. An adopter that wants human-attributed
  approvals has to build per-call confirmation, and that is the right price.
- The `aldus:publish` capability exists and no tool requires it, because `@aldus/services`
  exposes no publishing mutation. That absence is why MCP cannot be a publishing bypass today,
  and a test asserts it rather than leaving it to be noticed.
- Adding a service method does not automatically expose it. A tool has to be declared, with a
  category and capabilities — which is the point, but it does mean the surfaces can drift if
  nobody checks.

## What this does not settle

§25 item 8 asks for "Production MCP authentication and local permission model". This settles the
**permission model**: what authority exists, how it is scoped, how it is granted, and how an
actor is decided.

It does **not** settle authentication. There is no mechanism here for verifying that a host is
who it claims, no credential exchange, and no per-call attestation format — `per_call_confirmed`
is a claim the host makes, and this package takes it at face value because a local stdio
transport has no channel on which to challenge it. That is defensible while the runtime is
local-first and the host is a process the operator started. A networked MCP surface, or a
multi-operator workspace, needs a follow-up ADR before it is built.

## Alternatives considered

- **One tool list with an `isMutation` flag.** Rejected: §18.1 asks for separate trust
  boundaries, and a flag is set at a call site far from its consequence.
- **Record the configured operator as the actor.** Rejected as the default: it produces forged
  human approvals. Available only where the host attests to per-call confirmation.
- **Take the actor from a tool argument.** Rejected outright — §18.1 forbids it, and the agent
  composes the arguments.
- **Hide unpermitted tools.** Rejected: an agent that cannot see a capability routes around it.
- **Depend on the MCP SDK.** Rejected on weight, not availability. The tool contract is the
  deliverable and the SDK wires in a few lines on the host side.
- **Let a tool name the workspace.** Rejected: that is the ambient binding §19.2 rules out.
- **Expose the release and TTS packages as tools.** Rejected: `@aldus/services` exposes no such
  mutations, and adding them here would put decisions in the MCP adapter that the CLI would not
  inherit — the divergence ADR-0011 exists to prevent.
