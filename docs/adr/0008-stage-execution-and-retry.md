# ADR-0008: Stage execution state, retry policy, and the gate boundary

- Status: Accepted
- Date: 2026-08-18
- Closes: —
- Relates to: §6.3 Stage Execution and Attempt, §6.4 Event log, §7 Storage contracts, §11 Workflow
  and stage contracts, §13 Human gates, §15.1, §19.1 Reliability, §19.3 Cost governance, ADR-0004,
  ADR-0005

## Context

Contract §11 states seven obligations for every stage and §22's WP-04 asks for the runner that
enforces them. Four questions had to be answered before any of that could be written, and each
constrains the others.

**Where does a `StageExecution` live?** §7 lists exactly six files in a run directory —
`run.json`, `events.jsonl`, `artifacts.json`, `approvals.json`, `costs.json`, `release.json` — and
none of them holds one. WP-02 implemented that layout faithfully, so the runner inherits a gap.

**What does `retryable` actually authorise?** §19.1 requires "retry classification and limits", and
`StructuredError.retryable` carries the classification. But a stage constructs its own errors, so
obeying the flag alone means a stage can authorise its own retries — including of a refusal.

**What happens at a gate?** §11 requires a stage to "stop at required gates" while §13 makes the
decision a human's. The runner has to model the stop without acquiring an opinion about the
decision.

**How is a stage that failed halfway recorded?** §19.1 requires "recovery from partial success",
and the expensive case is concrete: §15.1's paid synthesis, where losing the record of what was
already produced means paying for it again.

## Decision

### 1. `stages.json` is a cache, and the event log is the source of truth

A seventh file, `stages.json`, is added to the run directory. It holds each `StageExecution` plus
the per-attempt metadata Core's record has no field for.

It is **rebuildable from the event log and safe to delete**. §6.4 requires every state mutation to
emit an immutable event and §6.3 makes the materialized summary optional ("a materialized manifest
MAY summarize the current state"), so the log is the audit record and this file is a projection of
it. Every stage lifecycle event therefore carries a complete snapshot of the attempt it describes,
which is what makes the log sufficient to reconstruct the cache exactly.

Both paths — the runner's incremental update and a full rebuild — go through one pure function,
`applyLifecycleEvent`. A cache built by replay cannot drift from one built incrementally, and a
test asserts the two agree.

Extending §7's layout is deliberate: §7 says "recommended", WP-03 already extended it with
`.aldus/artifacts/`, and adding a _derived_ file is a much smaller claim than adding a new source
of truth.

### 2. The event is written before the cache

Inside one lock: append the event, then write the cache.

A process killed between the two leaves the log complete and the cache one event behind. A
watermark (`lastEventSequence`) makes the gap detectable, and replaying past it closes the gap —
§19.1's "recovery from partial success" applied to the runner's own state.

The opposite order was rejected. It would leave a state change with no event, which §6.4 forbids
and which **nothing could repair, because nothing would know it had happened.** A cache that lags
is a performance problem; a missing audit record is a correctness one.

### 3. The cache uses its own lock resource, not the Run lock

`FileEventStore.append` takes the Run lock to assign a sequence (ADR-0005), and file locks are not
re-entrant. A runner holding the Run lock while calling `append` waits on itself until the
acquisition deadline expires.

This was found by writing the obvious code and watching every test time out, which is worth
recording: **a non-reentrant lock is a hazard at every call boundary, not just at the one where it
is taken.** The cache gets `stage-state-{runId}`, so cache writers serialise among themselves while
`append` keeps serialising the log.

Locks are held for writes only, never across `execute`. §5.1 makes long pauses normal and a stage
may run for minutes; holding the Run lock across execution would serialise a workspace on its
slowest stage.

### 4. Two overrides sit above `retryable`

Retry obeys `StructuredError.retryable`, then refuses in two further cases.

**Whole categories are never retried** — `validation`, `policy`, `not_found`, `cancelled` — whatever
the flag says. §19.3 makes the consequence concrete: retrying a refusal is how a spend limit gets
spent through. A refusal is a decision, and a decision does not become a different answer by being
asked again. A stage remains free to label such an error retryable; the runner does not act on it.

**A stage that declared itself non-idempotent is never retried automatically.** §15.1 states the
rule directly: "Aldus MUST NOT silently retry paid requests without policy and cost authorization."
An operator can still re-run explicitly, having read the recorded reason.

That reason is available because `StageDefinition.idempotency` is a required field whose
non-idempotent variant demands a string. §11 says a stage must "be idempotent or explicitly declare
why it is not"; a boolean would record that the answer is no while discarding the part an operator
needs.

### 5. `waiting_for_gate` is terminal for the attempt

A stage signals a gate by returning `{ kind: "gate_required" }` or throwing `GateRequiredSignal`.
The runner records `waiting_for_gate`, stores the `subjectHashes` the eventual decision will bind
to (§13), stops, and refuses to run the stage again until a decision exists.

Terminal for the _attempt_, not parked: a JavaScript call stack cannot be resumed after a process
restart, and §5.1 makes "long pauses between stages are normal" the ordinary case rather than the
exception. Modelling the halt as a parked continuation would work only while the process lived,
which is precisely the assumption §3.4 rejects. When the gate is decided, a new attempt runs.

The runner never decides a gate and never writes an approval. Deciding is WP-05's, and a runner
that recorded its own approval would make §3.6's durable `GateDecision` a formality.

### 6. Outputs are recorded as they are produced

`StageContext.recordOutput` is called during execution rather than collected from the return value,
and outputs are attached to the attempt whatever the outcome — success, failure, or cancellation.

This is what makes §19.1's "recovery from partial success" real. A stage that produced two
artifacts and then failed leaves both recorded and attributable; discarding them with the return
value would make the next attempt redo work whose results already exist, and for a paid stage,
pay for it twice.

It also serves §11's "avoid hidden mutation outside declared outputs": the declared path is the
convenient one.

### 7. Configuration is recorded with an order-independent digest

Every attempt records a redacted copy of its configuration and a digest of it, so §20 can answer
"which inputs, code, packs, and configuration were used".

The digest is taken over JSON with keys sorted at every depth. `JSON.stringify` preserves insertion
order, so two structurally identical configurations built in different orders would otherwise hash
differently — and §20 would answer differently for one configuration depending on how the object
happened to be constructed.

Configuration passes through `redact()` before storage: an attempt record is durable, and §19.2's
rule that a secret must never reach a log applies with more force to a file than to a stream.

### 8. A running stage is claimed, and takeover is explicit

Starting a stage whose latest attempt is `running` fails. `force` overrides it.

Rejected: treating a `running` stage as dead after a timeout. That would let two runners execute
one side-effecting stage at once — the failure §15.1 exists to prevent — and the runner cannot
distinguish a crashed process from a slow one. Stale-run detection is named in §19.1 and belongs
with the CLI or a supervisor that can ask the operator; the runner's job is to refuse by default.

## Consequences

- Deleting `stages.json` is safe and is tested. An operator with a corrupt cache has a one-command
  recovery, and a future store can drop the file entirely without losing information.
- Every attempt costs three durable writes (queued, started, terminal), because §6.4 admits no
  smaller number — those are three state mutations. Real-filesystem tests are slow enough under
  parallel workers to need a raised timeout; that cost is accepted rather than mocked away, since
  mocking the store would leave the crash behaviour this package exists to get right untested.
- `AttemptMetadata` lives beside the Core record rather than inside it. Core's `StageAttempt` is
  transcribed verbatim from §6.3 and has no field for configuration or an idempotency key, and
  smuggling them in as unknown properties would collide with a future Core minor version — ADR-0004's
  preservation rule would keep them alive precisely long enough to conflict.
- A stage cannot be resumed mid-execution across a gate. A stage that does expensive work before
  reaching a gate repeats it on the next attempt unless it records intermediate artifacts and skips
  what it can already see. That is the cost of resumability across process restarts, and the
  mitigation is `recordOutput`.
- The runner depends only on the §7 ports, so a database-backed store drives it unchanged.

## Alternatives considered

- **Derive stage state from the log on every read, with no cache.** Correct but O(n) in the event
  count on every status check, and §18's `aldus status` is meant to be cheap. The cache is the same
  answer computed once.
- **Store `StageExecution` inside `run.json`.** Rejected: it would make every stage transition a
  read-modify-write of the Run manifest, and §6 deliberately separates Episode, Run, and execution
  state.
- **Retry purely on `retryable`.** Rejected: it lets a stage authorise retries of its own refusals,
  which §19.3 and §15.1 both forbid in the case that matters.
- **A boolean `idempotent` flag.** Rejected: §11 asks for the reason, and the reason is what an
  operator deciding whether to re-run a paid stage actually needs.
- **Parking a gate as a suspended continuation.** Rejected: works only within one process lifetime,
  and §5.1 plus §3.4 make cross-restart resumption the ordinary case.
- **Automatic takeover of a stale `running` stage.** Rejected: see decision 8.
