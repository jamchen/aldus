# Contract enforcement matrix

Where each normative clause of §§12, 13 and 19 is enforced, and where it deliberately is not.

## Why this exists

Four gaps in one day had one shape: a contract clause implemented at one enforcement point while
the neighbouring point — the one adopters actually use — had nothing.

| gap                                      | enforced for | absent for                |
| ---------------------------------------- | ------------ | ------------------------- |
| §3.2 Worker seam (#111)                  | agents       | workers                   |
| §13.3 human ownership (#64)              | gates        | takes                     |
| §12.1 calibration before blocking (#115) | gates        | evaluator stages          |
| composition reachability (#121, #123)    | some options | `workers`, `agentBackend` |

None was found by review. Each was found by an adopter trying to use a finished feature, and in
each case the implementing package's own tests passed — because a test inside a package constructs
the object directly, and that is precisely the composition an adopter never writes.

A review catches this once. The table below is checked by
`packages/aldus-core/test/contract-enforcement.test.ts`, which fails when a row claims an
enforcement point that does not exist or names a test file that is not there. It cannot prove the
semantics are right; it makes a one-sided implementation visible during review rather than after
release.

## How to read a row

- **Contract** — the public type or function representing the clause.
- **Enforced at** — `package:symbol`, the point that refuses.
- **Proven by** — the test file. A claim with no test is a claim.
- **Not applicable to** — neighbouring execution shapes the clause does not reach, **with the
  reason**. An empty reason is an omission wearing a decision's clothes, and the test refuses one.

## §12 Quality model

| Clause                                            | Contract                                  | Enforced at                          | Proven by                                             |
| ------------------------------------------------- | ----------------------------------------- | ------------------------------------ | ----------------------------------------------------- |
| Four levels, and their pairing with enforcement   | `core:QUALITY_LEVELS`                     | `core:validateQualityClaim`          | `packages/aldus-stage-runner/test/evaluation.test.ts` |
| §12.1 an evaluator may block only once calibrated | `core:PromotionEvidence`                  | `gate-engine:validateGateDefinition` | `packages/aldus-gate-engine/test/definition.test.ts`  |
| §12.1, for a Stage that runs an evaluator         | `stage-runner:StageEvaluationDeclaration` | `stage-runner:StageRegistry`         | `packages/aldus-stage-runner/test/evaluation.test.ts` |
| §12 a finding is distinguishable from a crash     | `stage-runner:EvaluationFinding`          | `stage-runner:StageRunner`           | `packages/aldus-stage-runner/test/evaluation.test.ts` |

**Not applicable to:** Workers. A Worker performs a declared operation and reports a result; it
makes no quality claim, and a Worker whose output is judged is judged by the Stage that invoked it
(ADR-0035).

**Deliberate asymmetry:** `human_oracle` is available to a gate and not to an evaluator Stage. A
human-owned judgement is a Gate Decision, not an automatic Stage execution — a Stage that appears
to perform one is evidence the judgement should be a gate.

## §13 Gates and authorization

| Clause                                                       | Contract                           | Enforced at                 | Proven by                                               |
| ------------------------------------------------------------ | ---------------------------------- | --------------------------- | ------------------------------------------------------- |
| §13.1 a content change invalidates approvals                 | `gate-engine:detectDrift`          | `gate-engine:GateEngine`    | `packages/aldus-gate-engine/test/cascade.test.ts`       |
| §13.2 paid TTS needs an authorization                        | `tts-ledger:SpendAuthorizer`       | `tts-ledger:TtsLedger`      | `packages/aldus-tts-ledger/test/authorization.test.ts`  |
| §13.3 performance approval is human-owned, for gates         | `gate-engine:GateDefinition`       | `gate-engine:GateEngine`    | `packages/aldus-gate-engine/test/authorization.test.ts` |
| §13.3 the same, for take decisions                           | `tts-ledger:TtsLedgerOptions`      | `tts-ledger:TtsLedger`      | `packages/aldus-tts-ledger/test/retention.test.ts`      |
| §13.4 release approval binds to what is released             | `release:deriveIdempotencyKey`     | `release:ReleaseExecutor`   | `packages/aldus-release/test/resume.test.ts`            |
| §13.2 what was sent is distinguishable from what was planned | `tts-ledger:takeObservationSchema` | `services:SynthesisGateway` | `packages/aldus-services/test/synthesis.test.ts`        |

**Not applicable to:** generic Stages and release operations, for `permittedActorKinds`. A Stage
actor records who performed work; it does not grant authority. A Stage requiring human
authorization must be gated, and if a Stage appears to perform the human judgement itself, that is
evidence the judgement should be a Gate rather than evidence every Stage needs an authorization
list.

## §19 Reliability, security, governance

| Clause                                           | Contract                        | Enforced at                  | Proven by                                           |
| ------------------------------------------------ | ------------------------------- | ---------------------------- | --------------------------------------------------- |
| §19.1 idempotency keys for external effects      | `stage-runner:StageIdempotency` | `stage-runner:StageRegistry` | `packages/aldus-stage-runner/test/retry.test.ts`    |
| §19.1 the same, for release operations           | `release:deriveIdempotencyKey`  | `release:ReleaseExecutor`    | `packages/aldus-release/test/resume.test.ts`        |
| §19.1 cancellation reaches a running operation   | `stage-runner:WorkerRequest`    | `stage-runner:StageRunner`   | `packages/aldus-stage-runner/test/doubles.test.ts`  |
| §19.2 mutating actions record actor identity     | `core:actorRefSchema`           | `services:requireActor`      | `packages/aldus-services/test/services.test.ts`     |
| §19.2 logs redact credentials                    | `core:redact`                   | `core:redact`                | `packages/aldus-core/test/redaction.test.ts`        |
| §19.2 validation errors carry no received value  | `core:StructuredError`          | `core:validate`              | `packages/aldus-core/test/validate.test.ts`         |
| §19.2 private packs never required by Core tests | `core:knowledge`                | boundary test                | `packages/aldus-e2e/test/boundary.test.ts`          |
| §19.3 a backend can report what it was charged   | `core:costObservationSchema`    | `core:costObservationSchema` | `packages/aldus-core/test/cost-observation.test.ts` |

**Not yet enforced:** §19.3's composed path — nothing dispatches `AgentBackend.execute()`, so no
cost observation is persisted as a `CostRecord` yet (#107). The contract exists and the composition
does not, which is the state this table is designed to make visible rather than hide.

## Composition reachability

Not a §-clause, but the shape that produced two of the four gaps.

| Property                                                       | Proven by                                                                 |
| -------------------------------------------------------------- | ------------------------------------------------------------------------- |
| every adopter-supplied capability has an `AldusConfig` field   | `packages/aldus-cli/test/config-reach.test.ts`                            |
| `loadConfig` accepts every key `AldusConfig` declares          | compile-time, plus `packages/aldus-cli/test/operator-entry-point.test.ts` |
| every seam is reachable from the published package entry point | `packages/aldus-e2e/test/public-surface.test.ts`                          |
| the operator's actual command reaches the composition          | `packages/aldus-cli/test/operator-entry-point.test.ts`                    |
