# ADR-0011: Application services and the CLI

- Status: Accepted
- Date: 2026-08-18
- Closes: —
- Relates to: §18 CLI and Production MCP, §18.1 Data MCP vs Production MCP, §24 V1 definition of done, §19.2 Security, ADR-0005, ADR-0009

## Context

§18 opens with a requirement that reads as a note about layering and is actually a constraint on
what may be built:

> Core behavior MUST be available through a programmatic API. CLI and MCP are adapters over the
> same application services.

WP-08 delivers the CLI, and WP-11 delivers the Production MCP. If WP-08 puts its behaviour in
command handlers, WP-11 has three options, all bad: import the CLI and parse its output,
reimplement the behaviour, or reach past it into the stores. The second is the likely one, and it
produces two implementations of the approval path — the divergence §3.6 exists to prevent, since
an approval recorded by one path and not understood by the other is worse than no approval at all.

§24 adds a requirement that is easy to mistake for a rendering concern:

> an operator can see current state and the next safe action without reading chat history

A list of stage and gate statuses is not that. It reports what is true and leaves the operator to
work out what to do — which is exactly the reasoning §3.4 says must not live in a session's
memory.

## Decision

### 1. Two packages, with the CLI as the thin one

`@aldus-runtime/services` holds every decision. `@aldus-runtime/cli` parses argv, resolves the actor and
workspace, calls **one** service method, renders or serialises the result, and returns an exit
code. WP-11 builds the same context and calls the same methods.

The discipline that keeps the split honest, and that a reviewer can check mechanically: no
service method returns a string meant for a human, and no service method reads `process.argv`,
`process.env`, or a terminal.

A single package with an internal boundary was the alternative. Rejected because an internal
boundary is one convenience import away from not existing, and the failure is silent — nothing
breaks when a command handler starts deciding something, it just quietly becomes a decision WP-11
does not inherit.

### 2. Services return a three-way result, and errors throw

```
ok            the operation completed
refused       understood, and not permitted right now
unsuccessful  it ran, and reached a terminal state that is not success
```

Anything genuinely broken throws an `AldusError`.

`refused` and `unsuccessful` are separate because they are different situations for an operator:
a gate that is not satisfied (§13) has not attempted anything, while a stage that halted at a
gate did exactly what §11 requires and stopped. Collapsing them would make "not allowed yet" and
"tried and stopped" indistinguishable to a script.

### 3. Exit codes: four, not two

| Code | Meaning                                       |
| ---- | --------------------------------------------- |
| `0`  | completed                                     |
| `1`  | refused — understood, not permitted right now |
| `2`  | error — bad invocation or environment         |
| `3`  | ran, did not succeed                          |

Two codes is the common choice and it makes a CLI unscriptable:
`aldus approve … \|\| echo "broken"` would report a breakage every time a gate was legitimately
not ready. §13 and §19.3 make refusals _ordinary answers_, so they need a code of their own.

`3` cannot be `0` even though nothing is broken: a script chaining stages has to stop when one
halts at a gate.

### 4. The next-action policy is a pure function, and reports what it withholds

`decideActions` takes the Run's status, stage snapshots, and gate statuses, and returns
`{ next, blocked, summary }`. It reads no file and no clock, so every branch is reachable in a
test without constructing a workspace.

Two decisions inside it are worth naming:

**Blocked actions are first-class output, not an omission.** An operator who expected to publish
and sees no publish action cannot otherwise tell whether the runtime forgot, whether they missed
a step, or whether something is blocking them. Every withheld action carries a reason.

**A gate in `blocked_upstream` is never offered.** Deciding it would record an approval that
§13.1's cascade immediately voids, which teaches an operator that approvals do not stick.

Ordering is: stale approvals, then gates a stage is halted on, then retryable failures, then
unrun stages. Stale is first because §13.1 and §13.2 make a drifted approval void while it still
_reads_ as approved to anyone skimming — the most dangerous state to leave unresolved.

The `summary` sentence exists because an empty `next` list is ambiguous: "the Run is complete" and
"everything is blocked" look identical, and an operator must not have to infer which.

### 5. Actor identity is required for mutations and refused for absence

§19.2 requires mutating actions to record actor identity. The services refuse an anonymous
mutation rather than attributing it to a placeholder — a decision recorded against "unknown" is
indistinguishable from one nobody made (§3.6).

Read-only operations need no actor. Requiring one for `status` would put configuration between an
operator and the answer §24 promises them.

The adapter supplies it: the CLI reads `--actor kind:id` or `ALDUS_ACTOR`; WP-11 will supply an
authenticated caller (§18.1). _Where_ it comes from is the adapter's business, which is what keeps
the services usable by both.

### 6. No interactive prompting for anything that mutates

§3.4 makes durable records authoritative and §19.2 requires a recorded actor. A y/n prompt records
nothing, and it makes every command unusable from a script or from Remote Control (§10.2). Missing
information is an error with a message naming the flag.

### 7. `aldus start` is added to §18's verb list

§18's V1 target has no verb that creates a Run, and every other verb needs one. Added as `start`,
and recorded here rather than left as an undocumented extra.

### 8. Gate ports are wired sequentially, never nested (ADR-0005)

`FileEventStore.append` takes the Run lock to assign an event sequence, and `RunStore.addRecord`
takes the same lock. File locks are not re-entrant, and `acquire` now refuses re-entry outright
with `ALDUS_LOCK_REENTRANT`.

So `GateEngine.decide` writes the decision and emits its event as two sequential locked
operations, and nothing in these services wraps that call in the Run lock. There is a test that
holds the Run lock, calls `approve`, and asserts the refusal — so the constraint is enforced
rather than merely documented.

A crash between the two leaves a decision with no event. **That gap is a trace gap, not a
correctness one**, and the reason is structural: ADR-0009 derives every gate's state from the
decision store and never from the event log, so a missing event cannot make a stale approval read
as valid. §20's trace is poorer for the missing line; §13's safety properties are untouched.
Making the pair atomic would require both files under one lock — exactly the nesting the guard
refuses — and buying a complete trace at the price of a deadlock is a bad trade.

## Consequences

- WP-11 is a genuinely thin adapter: build an `AldusContext`, call a method, serialise the result.
  If it ever needs behaviour that is not a service method, that is the signal something was put in
  the wrong package.
- The next-action policy is where §24 is satisfied or not. It is one pure function with its own
  test file, so a future disagreement about what an operator should be told next is a change to a
  reviewable policy rather than an archaeology exercise across command handlers.
- Four exit codes are more than most CLIs use, and callers who only check `!== 0` still work.
- The services take no dependency on `@aldus-runtime/artifact-registry`: `artifacts` reads the Run's
  `artifacts.json` collection (§7). Richer lineage queries are a registry concern and would be an
  additive service method.
- Gate subjects are supplied by the caller through a `SubjectsProvider`. The services cannot
  compute them — what a gate binds is adopter process (§4.3) — and a gate with no subjects
  supplied evaluates as `pending`, never as satisfied. Absence of evidence is not approval.

## Alternatives considered

- **One package with an internal `services/` directory.** Rejected: see decision 1.
- **Two exit codes (0 and 1).** Rejected: see decision 3.
- **Have the CLI render from its own store reads rather than from the service result.** Rejected:
  the human and JSON outputs could then disagree about the same moment, and §18 asks for both
  forms of one answer.
- **Prompt for a missing actor.** Rejected: see decision 6.
- **Make the decision and its event atomic under one lock.** Rejected: see decision 8.
- **Compute gate subjects inside the services.** Rejected: §4.2 keeps adopter concepts out of the
  runtime, and guessing a subject digest would produce approvals bound to the wrong thing.
