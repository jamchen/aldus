# ADR-0032: An absent `--input` is an empty input, not a missing one

- Status: Accepted
- Date: 2026-08-19
- Relates to: §11 Stages, §19.3 Refusals, ADR-0030

## Context

`status` recommends a runnable stage as:

```
aldus run <stageId> --run <runId>
```

That command never carries `--input`. The CLI omitted the key entirely when the flag was absent,
so the stage runner validated `undefined` against the stage's declared `inputSchema` — and every
object-shaped schema rejects `undefined`, `.strict()` or not. A stage declaring an ordinary input
schema therefore could not be run by the command the runtime had just printed. The operator had to
add `--input '{}'`, which supplies nothing and exists only to satisfy the shape of the check.

The refusal compounded it. `ALDUS_STAGE_INPUT_INVALID` cites §11 and names the stage's schema,
sending the reader to inspect a schema that is fine. The fault is that nothing supplied a value.

Nothing caught this because every stage in the repository's own tests declared a schema accepting
anything, `undefined` included. The realistic case — an object schema, which is what an adopter
writes — was the one case nothing exercised. Same shape as #67.

## Decision

**An absent `--input` is passed to the stage as `{}`.**

An operator who ran `aldus run <stage> --run <id>` and typed no `--input` has said "run this with
no input". `{}` is that statement in JSON. `undefined` is a different statement — "no value was
supplied at all" — and it is not what the invocation meant.

This is deliberately a CLI-layer decision. `AldusServices.runStage` still treats an omitted
`input` as `undefined`, because a programmatic caller omitting a field means exactly that and has
no command line to have left blank. The CLI is where "the operator typed nothing" is knowable.

## Consequences

- The command `status` prints now runs, which is the whole point. ADR-0030 consequence 3: a
  runtime that recommends an action it will then refuse has told the operator something false.
- A stage whose schema requires fields still refuses, with the same code and message. `{}` records
  what the operator supplied; it is not an assertion that the input is valid. A test pins this, so
  the fix cannot decay into "accept anything".
- A stage declaring `z.undefined()`, `z.void()`, or a primitive schema will now be refused where
  it previously ran. This is accepted and is the one real cost: such a schema is an unusual way to
  say "no input", `z.object({})` says it better, and the refusal is immediate and legible rather
  than silent.
- The CLI and the recommendation must keep agreeing. A test asserts both halves — that the
  recommendation contains no `--input`, and that the same invocation succeeds — so the pair cannot
  drift apart without failing.

## Alternatives considered

- **Make `status` emit `--input '{}'` when the schema requires it.** Rejected. It makes the
  recommendation accurate at the cost of putting ceremony in front of the operator forever, for a
  stage that takes no input. It also spreads schema knowledge into the recommendation layer, which
  would then need the stage registry to render a command string.
- **Default the input in the stage runner instead.** Rejected as too broad: it would change what
  every programmatic caller means by omitting the field, and the runner is the one place that
  should not be guessing what a caller intended.
- **Treat `undefined` as valid whenever the schema rejects it but accepts `{}`.** Rejected as
  magic. It makes behaviour depend on a schema probe rather than on what the operator typed, and
  the rule would be impossible to state in a help text.
