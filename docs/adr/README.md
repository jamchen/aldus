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

| ADR                                                    | Title                                                   | Status   | Closes            |
| ------------------------------------------------------ | ------------------------------------------------------- | -------- | ----------------- |
| [0001](0001-package-placement.md)                      | Package placement during incubation                     | Accepted | §25.1 (partial)   |
| [0002](0002-schema-authoring-and-validation.md)        | Schema authoring and validation stack                   | Accepted | §25.2 (validator) |
| [0003](0003-schema-version-policy.md)                  | Schema version and compatibility policy                 | Accepted | §25.2 (migration) |
| [0004](0004-event-envelope-and-forward-writes.md)      | Event envelope placement and forward-record writes      | Accepted | —                 |
| [0005](0005-file-store-locking-and-event-ordering.md)  | File-store locking and event ordering                   | Accepted | §25.3             |
| [0006](0006-knowledge-pack-manifest-and-precedence.md) | Knowledge Pack manifest, precedence, and conflict model | Accepted | —                 |
