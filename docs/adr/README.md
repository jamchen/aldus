# Architecture Decision Records

Each ADR records one decision, its context, and its consequences.

`docs/ALDUS-ARCHITECTURE.md` is the architecture **contract**. ADRs resolve items the
contract leaves open (see §25 "Architecture decisions still open") or record an
implementation choice the contract permits but does not prescribe.

Rules:

- One decision per file, numbered `NNNN-kebab-title.md`.
- Status is one of `Proposed`, `Accepted`, `Superseded by ADR-NNNN`, `Deprecated`.
- An ADR is never edited to change its decision. Write a new ADR that supersedes it.
- Every ADR that closes an open item MUST name the §25 item it closes.
- Until an item is decided, implementations choose the smallest reversible option and
  record the assumption (architecture contract §25).

| ADR                                                                                         | Title                                                                                      | Status   | Closes            |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | -------- | ----------------- |
| [0001](0001-package-placement.md)                                                           | Package placement during incubation                                                        | Accepted | §25.1 (partial)   |
| [0002](0002-schema-authoring-and-validation.md)                                             | Schema authoring and validation stack                                                      | Accepted | §25.2 (validator) |
| [0003](0003-schema-version-policy.md)                                                       | Schema version and compatibility policy                                                    | Accepted | §25.2 (migration) |
| [0004](0004-event-envelope-and-forward-writes.md)                                           | Event envelope placement and forward-record writes                                         | Accepted | —                 |
| [0005](0005-file-store-locking-and-event-ordering.md)                                       | File-store locking and event ordering                                                      | Accepted | §25.3             |
| [0006](0006-knowledge-pack-manifest-and-precedence.md)                                      | Knowledge Pack manifest, precedence, and conflict model                                    | Accepted | —                 |
| [0007](0007-artifact-archive-and-collision-safety.md)                                       | Artifact archive target, collision safety, and provenance placement                        | Accepted | §25.4             |
| [0008](0008-stage-execution-and-retry.md)                                                   | Stage execution, attempt lifecycle, and retry policy                                       | Accepted | —                 |
| [0009](0009-gate-binding-and-invalidation.md)                                               | Gate binding, cascading invalidation, and spend grants                                     | Accepted | —                 |
| [0010](0010-evaluator-promotion-evidence.md)                                                | Evaluator promotion evidence                                                               | Accepted | §25.9             |
| [0011](0011-application-services-and-cli.md)                                                | Application services and the CLI adapter                                                   | Accepted | —                 |
| [0012](0012-performance-script-and-take-lineage.md)                                         | PerformanceScript origin, take lineage, and repair scope                                   | Accepted | §25.6             |
| [0013](0013-release-bundles-and-reconciliation.md)                                          | Release bundles, adapter contract, and reconciliation                                      | Accepted | —                 |
| [0014](0014-production-mcp-trust-boundary.md)                                               | Production MCP trust boundary                                                              | Accepted | §25.8 (partial)   |
| [0015](0015-composition-boundary.md)                                                        | Aldus composes its own packages; adopters supply adapters                                  | Accepted | —                 |
| [0016](0016-service-composition-and-injection.md)                                           | Service composition and injection points                                                   | Accepted | —                 |
| [0017](0017-npm-scope.md)                                                                   | The published npm scope is `@aldus-runtime`                                                | Accepted | §25.10 (partial)  |
| [0018](0018-licensing.md)                                                                   | Apache-2.0 for the runtime; adopter content stays privately licensed                       | Accepted | #29 (license)     |
| [0019](0019-cli-configuration-and-verbs.md)                                                 | How the CLI receives adapters, and how its verb list grew                                  | Accepted | —                 |
| [0020](0020-versioning-and-release-policy.md)                                               | Lockstep versioning, exact internal pins, and `next` before `latest`                       | Accepted | #29 (item 3)      |
| [0021](0021-stage-gate-association.md)                                                      | A workflow declares which gates gate which stages                                          | Accepted | #38               |
| [0022](0022-release-pipeline-and-trusted-publishing.md)                                     | Release pipeline, the clean-consumer gate, and trusted publishing                          | Accepted | #29 items 4–6     |
| [0023](0023-bootstrap-release-exception.md)                                                 | The bootstrap release carries `latest`; later unvalidated releases use prerelease versions | Accepted | —                 |
| [0024](0024-gate-enforcement-at-the-service-layer.md)                                       | A declared gate refuses a stage; the conservative default does not                         | Accepted | #45               |
| [0025](0025-config-strictness.md)                                                           | An operator's config module rejects keys Aldus does not recognise                          | Accepted | #46 (strictness)  |
| [0026](0026-derived-run-status.md)                                                          | A Run's status is derived; its completion is declared intent                               | Accepted | —                 |
| [0027](0027-stage-artifact-registration.md)                                                 | A stage registers artifacts through a port, and never states its own provenance            | Accepted | —                 |
| [0028](0028-workflow-stage-ordering.md)                                                     | A workflow graph declares stage ordering, separately from gating                           | Accepted | #55               |
| [0029](0029-config-sees-the-invocation.md)                                                  | A config module is given the invocation it is configuring                                  | Accepted | —                 |
| [0030](0030-diagnostic-distance.md)                                                         | Rank diagnostic work by distance from symptom to cause                                     | Accepted | —                 |
| [0031](0031-derive-prose-from-the-program.md)                                               | Derive prose about the program from the program                                            | Accepted | —                 |
| [0032](0032-absent-cli-input-is-empty.md)                                                   | An absent `--input` is an empty input, not a missing one                                   | Accepted | #80               |
| [0033](0033-idempotency-keys-identify-the-effect.md)                                        | A release idempotency key identifies the effect, not the bundle                            | Accepted | #40               |
| [0034](0034-who-may-decide-a-take-is-declared.md)                                           | Who may decide a take is declared, not assumed                                             | Accepted | #64               |
| [0035](0035-workers-are-invoked-by-stages.md)                                               | A Worker performs an operation; the Stage owns everything else                             | Accepted | #111              |
| [0036](0036-invocation-key-and-effect-key-are-different-contracts.md)                       | An invocation fingerprint and an external-effect key are different contracts               | Accepted | #113              |
| [0037](0037-an-evaluator-failing-and-an-evaluator-finding-a-defect-are-different-events.md) | An evaluator failing and an evaluator finding a defect are different events                | Accepted | #115              |
| [0038](0038-a-take-records-what-was-planned-and-what-was-observed.md)                       | A take records what was requested and what produced the bytes, side by side                | Accepted | #133              |
| [0039](0039-delivery-is-a-third-fact-and-paidness-comes-from-charge-evidence.md)            | Delivery is a third fact, and paidness comes from charge evidence                          | Accepted | #136              |
