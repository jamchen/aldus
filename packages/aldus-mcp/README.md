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

**Two tools spend real money or publish to the outside world.** `aldus_synthesise_segment`
incurs provider cost. `aldus_execute_release` publishes. Their descriptions say so in capitals.
Do not call either to "see what happens", and do not call either without saying first, in plain
words, what it will do. Everything else in this surface is recoverable; these two are not.

**You cannot name who decided anything.** `aldus_decide_take` takes no `decidedBy` — the decider
is you, unless the host attested a human confirmed the call. §13.3 keeps final performance
approval human-owned, and a take recorded as decided by a person who never heard it would be
undetectable to whoever reads the ledger later.

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

| Tool                          | What it does                                                      |
| ----------------------------- | ----------------------------------------------------------------- |
| `aldus_status`                | Current state and the next safe action (§24)                      |
| `aldus_inspect`               | Full detail for one Episode or Run                                |
| `aldus_artifacts`             | Artifacts a Run produced, with archival state                     |
| `aldus_artifact_lineage`      | Where one artifact came from, and what came of it                 |
| `aldus_plan_artifact_cleanup` | What a cleanup would remove, and what blocks it — removes nothing |
| `aldus_costs`                 | Recorded and estimated cost                                       |
| `aldus_release_status`        | Release receipts already recorded                                 |
| `aldus_release_bundle_status` | A bundle's derived state — contacts no destination                |
| `aldus_takes`                 | Synthesis takes, lineage, and what awaits a decision              |

None of these contacts an external destination or a provider. If you want to know what a release
has already done, `aldus_release_bundle_status` is the safe question; `aldus_reconcile_release`
is not, and needs publish authority.

### Mutating — each needs authority

| Tool                               | Capability                                                                                                                   | Consequence                    |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `aldus_init`                       | `aldus:workspace:init`                                                                                                       | Creates workspace state        |
| `aldus_start_run`                  | `aldus:run:start`                                                                                                            | Creates a Run                  |
| `aldus_run_stage`                  | `aldus:stage:run`, plus `aldus:spend` for a stage that can incur cost, plus `aldus:stage:force` to take over a claimed stage | Runs adopter code              |
| `aldus_retry_stage`                | same as `aldus_run_stage`                                                                                                    | Appends a new attempt          |
| `aldus_approve_gate`               | `aldus:gate:decide`                                                                                                          | Records a decision             |
| `aldus_reject_gate`                | `aldus:gate:decide`                                                                                                          | Records a decision             |
| `aldus_request_changes`            | `aldus:gate:decide`                                                                                                          | Records a decision             |
| `aldus_decide_take`                | `aldus:gate:decide`                                                                                                          | Records a judgement (§13.3)    |
| `aldus_archive_irreplaceable`      | `aldus:artifact:archive`                                                                                                     | Copies bytes into the archive  |
| `aldus_record_performance_script`  | `aldus:tts:record`                                                                                                           | Records intent. Spends nothing |
| `aldus_record_synthesis_plan`      | `aldus:tts:record`                                                                                                           | Records a plan. Spends nothing |
| `aldus_record_unauthorized_charge` | `aldus:spend`                                                                                                                | Records a charge already made  |
| **`aldus_synthesise_segment`**     | **`aldus:spend`**                                                                                                            | **Costs money**                |
| `aldus_reconcile_release`          | `aldus:publish`                                                                                                              | Contacts destinations          |
| **`aldus_execute_release`**        | **`aldus:publish`**                                                                                                          | **Publishes**                  |

Holding `aldus:spend` does **not** authorize spend, and holding `aldus:publish` does **not**
approve a release. §13.2 still requires a recorded, hash-bound approval for synthesis, and §13.4
still keeps uploading and making public separate. The capability only decides whether this
session may attempt the operation; the gate engine decides whether it may proceed.

A few things that are easy to get wrong:

- **Recording a plan is not authorizing it.** `aldus_record_synthesis_plan` costs nothing and
  approves nothing — it creates the thing an operator can then approve.
- **Reconciliation publishes nothing**, but it needs publish authority because it contacts
  destinations and rewrites the release record. It exists because a receipt can be lost while the
  remote operation succeeded, and retrying blindly would then publish twice. It always runs
  before an execution and cannot be skipped.
- **`aldus_record_unauthorized_charge` is an escape hatch, not a synthesis route.** It performs
  no synthesis and cannot reach a provider. It exists so a charge that already happened can be
  recorded rather than lost from the trace. Recording a charge is not permission to incur one.
- **Archival comes before cleanup.** §8.1 requires irreplaceable artifacts to be archived before
  disposable files are removed, so `aldus_plan_artifact_cleanup` will report unarchived
  irreplaceable artifacts as blocking until `aldus_archive_irreplaceable` has run.

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

  // Adapters are the adopter's to supply (§4.3, ADR-0015). Aldus decides when one is called and
  // refuses when policy is unmet; the adapter performs the call. With none wired, the release
  // and synthesis tools fail rather than appearing to work.
  releaseAdapters: hostReleaseAdapters,
  synthesisAdapter: hostSynthesisAdapter,
  spendGrants: hostSpendGrants,
  archive: hostArtifactArchive,
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
