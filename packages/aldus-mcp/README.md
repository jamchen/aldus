# `@aldus-runtime/mcp` — Production MCP

A capability-checked tool surface over [`@aldus-runtime/services`](../aldus-services), sibling to
[`@aldus-runtime/cli`](../aldus-cli). Architecture contract §18, §18.1.

This package decides nothing about production. It validates arguments, checks scoped authority,
resolves who a mutation is recorded against, and calls a service. Every rule about gates, spend,
retries, and invalidation lives in the packages that own them.

---

## For an agent using these tools

Read this part before calling anything. It is short because the rules are few and each one
matters.

### Start with `aldus_status`

It reports the current state **and the next safe action**, with reasons for anything blocked.
Use it instead of reconstructing state from earlier in the conversation. Your session's memory
is not authoritative and is not the audit trail (§3.4, §10.1) — the workspace is.

### What you must never assume

**You cannot approve anything.** There is no argument on any tool that says a human approved,
and there never will be — §18.1 forbids one. If a gate needs a human decision, the person has to
make it. Telling the user "I approved the content gate for you" would be false.

**You are recorded as yourself.** When you call a mutating tool, the decision is recorded against
an _agent_ actor, even when an operator is configured for the session. The operator appears as
the party you acted for, not as the decider. The only exception is a host that has attested it
confirmed a specific call with the human directly. Check `actorRationale` on the result if you
need to know which happened.

**Authority comes from configuration, not arguments.** If a call fails with
`ALDUS_MCP_CAPABILITY_REQUIRED`, retrying with different arguments cannot help. Tell the user
which capability is missing and that it is granted in the MCP server configuration.

**A refusal is not a bug.** `outcome: "refused"` means the operation is understood and not
permitted right now — a gate is unsatisfied, a budget is exhausted. Waiting or asking a human is
the response; retrying in a loop is not.

**`outcome: "unsuccessful"` means the work ran and stopped.** A stage that halted at a gate did
exactly what it was supposed to. It is not an error and does not want a retry.

### Reading a result

| Field            | Meaning                                                      |
| ---------------- | ------------------------------------------------------------ |
| `outcome`        | `ok`, `refused`, `unsuccessful`, or `error`                  |
| `isError`        | true for `refused` and `error`; a gate halt is not a failure |
| `workspaceRoot`  | which workspace this acted on — always present               |
| `actor`          | who the mutation was recorded against (absent for reads)     |
| `actorRationale` | why that actor and not another                               |
| `refusal`        | what is blocking, and what would unblock it                  |
| `error`          | structured, redacted failure detail                          |

---

## Tools

### Read — safe to call freely

Requires `aldus:read`, which a host can grant broadly (§18.1).

| Tool                   | What it does                                   |
| ---------------------- | ---------------------------------------------- |
| `aldus_status`         | Current state and the next safe action (§24)   |
| `aldus_inspect`        | Full detail for one Episode or Run             |
| `aldus_artifacts`      | Artifacts a Run produced, by identity and hash |
| `aldus_costs`          | Recorded and estimated cost                    |
| `aldus_release_status` | Release receipts — this publishes nothing      |

### Mutating — each needs authority

| Tool                    | Capability                                                                                                                   |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `aldus_init`            | `aldus:workspace:init`                                                                                                       |
| `aldus_start_run`       | `aldus:run:start`                                                                                                            |
| `aldus_run_stage`       | `aldus:stage:run`, plus `aldus:spend` for a stage that can incur cost, plus `aldus:stage:force` to take over a claimed stage |
| `aldus_retry_stage`     | same as `aldus_run_stage`                                                                                                    |
| `aldus_approve_gate`    | `aldus:gate:decide`                                                                                                          |
| `aldus_reject_gate`     | `aldus:gate:decide`                                                                                                          |
| `aldus_request_changes` | `aldus:gate:decide`                                                                                                          |

Holding `aldus:spend` does **not** authorize spend. §13.2 still requires a recorded, hash-bound
approval, and the gate engine still evaluates it. The capability only decides whether this
session may attempt the operation at all.

There is **no publishing tool**, because `@aldus-runtime/services` exposes no publishing mutation. The
`aldus:publish` capability is defined for the day one exists; until then MCP is not a route to
publishing at all.

---

## Wiring a transport

This package carries no MCP SDK dependency. `listTools()` returns exactly what a `tools/list`
response needs and `callTool()` what `tools/call` needs, so a host wires whichever transport it
already uses. §10.2 requires Aldus to stay operable if a particular interaction surface changes
or disappears; a hard-wired transport would work against that.

```ts
import { AldusToolSurface, CapabilityGrant, CAPABILITIES } from "@aldus-runtime/mcp";

const surface = new AldusToolSurface({
  // Required and never inferred from the working directory (§19.2).
  workspaceRoot: "/path/to/workspace",
  identity: {
    agent: { id: "agent-a", backendId: "backend-a", sessionRef: session.id },
    // Optional. "ambient_configuration" names who is accountable for the session; it does not
    // claim they saw any particular call.
    operator: {
      actor: { kind: "human", id: "operator-a" },
      confirmation: "ambient_configuration",
    },
  },
  capabilities: new CapabilityGrant([CAPABILITIES.read, CAPABILITIES.gateDecide]),
  stages: hostStageRegistry,
  gates: hostGateDefinitions,
  subjects: hostSubjectsProvider,
});

// tools/list
const tools = surface.listTools().map((tool) => ({
  name: tool.name,
  title: tool.title,
  description: tool.description,
  inputSchema: tool.inputSchema,
}));

// tools/call
const result = await surface.callTool(name, args);
```

Map `result.isError` onto the transport's error flag and `result` itself onto structured
content. `callTool` never throws.

---

## Design notes

- **Read and mutating tools are separate types**, not one list with a flag. A field gets set
  wrongly at a call site far from its consequence; a type cannot.
- **The actor default is the agent**, because the server cannot verify that a human decided. A
  `GateDecision` reading `kind: "human"` when an agent made the call is a forged approval, not a
  smaller problem than a missing one (§10.1, §13.3).
- **Unpermitted tools are listed, not hidden.** An agent that cannot see a tool concludes the
  capability does not exist and works around it. One that sees it is unauthorized asks.
- **Argument failures report path and code, never the received value** (§19.2).
- **Tool schemas reject unknown arguments**, unlike the stored-record schemas ADR-0002 strips
  `additionalProperties: false` from. That rule is about forward compatibility of persisted
  records; tool arguments are neither persisted nor versioned.

Decisions are recorded in [ADR-0014](../../docs/adr/0014-production-mcp-trust-boundary.md).
