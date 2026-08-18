# ADR-0027: A stage registers artifacts through a port, and never states its own provenance

- Status: Accepted
- Date: 2026-08-18
- Closes: issue #39
- Relates to: §8 Artifact model, §8.1 Artifact rules, §7 Storage contracts, §11 Workflow and stage
  contracts, §20 Production trace, ADR-0015

## Context

`StageContext` offered `recordOutput(artifact)` and nothing else. A stage wanting content-addressed
identity, provenance, or archival custody had to obtain an `ArtifactRegistry` — which it could only
do by being closed over one, because the registry is constructed alongside the context the stage is
about to be handed. The end-to-end harness needed a `StageFactory` to break that loop, and the first
external adopter independently invented the same shape before finding the issue.

Two facts from that adopter settle what kind of problem this is.

The workaround **produces fully correct records** — registry and per-run view agree on id, digest,
size and provenance, with nothing in `ArtifactReport.unregistered`. So the correct path existed; it
simply was not the obvious one.

And the risk is not boilerplate. Their stages produce paid takes that must be registered
`irreplaceable`, because §8.1 makes that classification what stops a cleanup removing bytes a human
already accepted and paid for. Under the old shape, `reconstructability`, `producerRunId`,
`producerStageId` and `configHash` were all passed by the stage author by hand — and **three of
those four were already sitting on the `StageContext` the stage was handed**. A take mis-registered
as `reproducible` fails silently and surfaces the day something deletes it.

## Decision

### 1. A registering variant, not the registry itself

`StageContext.registerOutput(registration)` takes a produced file and returns the registered
`ArtifactRef`, also recording it as an output. The registry is **not** exposed on the context.

The difference matters. Handing a stage the registry keeps every wrong-provenance record
expressible; the stage would simply be trusted not to write one. A registering call lets the stage
state only what it knows.

### 2. The attempt's facts come from the attempt

`producerRunId`, `producerStageId`, `codeRevision`, and the configuration digest are supplied by the
runner. `StageOutputRegistration` has **no field for any of them**, so an artifact whose provenance
disagrees with the attempt that produced it is unrepresentable rather than merely discouraged. The
digest is likewise computed from the bytes: §8.1 makes it half of an artifact's identity and §13
binds approvals to it, so a caller-supplied digest could bind an approval to bytes nobody checked.

This is why the question "what happens when a stage contradicts the runtime — does the runtime win,
or is the attempt refused?" has no answer here. Neither, because the contradiction cannot be
written. Four compile-time assertions pin it, and `typecheck:test` enforces them in both directions:
an unused `@ts-expect-error` is itself an error, so if any of those fields ever becomes settable the
suite stops compiling.

What a stage _does_ state is what only it knows: the path, the kind, the media type, the input
hashes, and `reconstructability` — the one field nothing else can supply, and the one that decides
whether a cleanup may remove the bytes.

### 3. A port, not a dependency

`@aldus-runtime/stage-runner` declares an `ArtifactRecorder` interface. It does **not** depend on
`@aldus-runtime/artifact-registry`.

The registry is the lower layer. A runner importing it would invert the layering the same way #45's
defect did, and §7 requires core models to stay independent of physical storage. The registry
exports `stageArtifactRecorder(registry)`, which satisfies the port **structurally** without
importing it, and whoever composes the two wires them together — exactly the arrangement ADR-0015
describes.

Structural coupling with no import is invisible to the compiler at both definition sites, so it is
asserted where the two shapes meet: the registry takes a **type-only, test-only** dependency on the
runner and a test asserts the two request shapes stay assignable. A drift then fails to compile
rather than at runtime. `src/` never imports it, so the runtime layering holds and the
dependency-correctness test — which checks `src/` imports only — is unaffected.

### 4. An unwired recorder refuses

Calling `registerOutput` with no recorder throws `ALDUS_ARTIFACT_RECORDER_UNAVAILABLE`,
non-retryable. Not a silent no-op: a stage that believed it registered an irreplaceable take and did
not would discover the mistake the day a cleanup removed the bytes. It is classified `validation`
rather than `policy` for the same reason ADR-0024 gave for `ADAPTER_NOT_WIRED` — no approval an
operator could grant makes a recorder appear.

## Consequences

- The correct path is now the short one. An adopter registering an artifact writes four fields
  instead of eight, and the four it no longer writes are the four it could previously get wrong.
- `ArtifactReport.unregistered` stays, and stays meaningful: a stage may still call `recordOutput`
  alone, and surfacing that is still right.
- **Purely additive.** `recordOutput` is untouched, `artifacts` on the runner is optional, and a
  `0.1.0` adopter closing over their own registry keeps compiling and behaving identically. Pinned
  by tests that exercise the old shape with no recorder wired.
- The runner now has an optional collaborator it can be missing, which is a new failure mode. It
  fails loudly, and only for stages that actually use the new call.
- A stage still cannot _read_ the registry — it cannot ask what a previous stage produced. That has
  not been needed, and `inputArtifacts` already carries what a stage was given. Adding a read path
  would widen the port for a use case nobody has.

## Alternatives considered

- **Expose the `ArtifactRegistry` on `StageContext`** (option 1 in the issue). Simplest, and matches
  where the provenance facts live. Rejected: it keeps every wrong-provenance record expressible, and
  it would make the runner depend on the registry — the layering inversion above.
- **Leave it and document the `StageFactory` pattern** (option 3). Rejected on the adopter evidence:
  two independent parties invented the same workaround before finding the issue, which is what a
  missing affordance looks like.
- **Have the runner register every output automatically**, with no explicit call. Rejected: a stage
  producing a file it does not want registered — a scratch intermediate — has no way to say so, and
  §11's "avoid hidden mutation outside declared outputs" cuts both ways. Declaring an output should
  stay an act.
- **Put the adapter in the composition layer** rather than in the registry. Defensible, and it would
  avoid the test-only dependency. Rejected because it puts registry knowledge in a third package and
  leaves the registry unable to describe how it satisfies a port it exists to satisfy.
