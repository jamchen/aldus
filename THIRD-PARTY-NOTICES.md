# Third-party notices

Aldus is licensed under the Apache License 2.0. See [`LICENSE`](LICENSE).

## Nothing is bundled

**No third-party code is copied into, inlined in, or vendored by any published Aldus package.**
Every dependency is resolved by npm at install time and reaches the consumer under its own
license, from its own publisher. Apache-2.0 §4 obligations therefore attach to Aldus's own
source, not to redistributed third-party material.

This file exists to record the audit, not because a notice is contractually required.

## Runtime dependencies

These are declared by published packages and installed alongside them.

| Package                                    | License | Used by                                                        |
| ------------------------------------------ | ------- | -------------------------------------------------------------- |
| [`zod`](https://github.com/colinhacks/zod) | MIT     | `@aldus-runtime/core`, and packages defining their own schemas |

That is the complete list. Aldus Core deliberately carries a single runtime dependency
(ADR-0002), and architecture contract §4.2 forbids depending on a provider, platform, cloud, or
storage service — so the runtime surface stays this small by design rather than by accident.

MIT is a permissive license and imposes no condition Apache-2.0 does not already accommodate.

## Development dependencies

Not distributed. Present only when building or testing this repository.

At the time of audit the full development tree resolved to 57 third-party packages:

| License      | Count |
| ------------ | ----- |
| MIT          | 47    |
| Apache-2.0   | 4     |
| BSD-3-Clause | 2     |
| MPL-2.0      | 2     |
| ISC          | 2     |

No package declares a GPL, AGPL, LGPL, SSPL, BUSL, or non-commercial license, and none is
missing a license field.

The two MPL-2.0 packages are `lightningcss` and `lightningcss-darwin-arm64`, reached transitively
through the test runner. MPL-2.0 is file-level copyleft: its obligations attach to modified MPL
files, and neither package is modified or distributed here.

## Reproducing this audit

```bash
npm ls --omit=dev --all    # the distributed surface
npm ls --all               # the full tree, including development-only packages
```

Counts above describe the tree at the time of writing. Re-run before a release rather than
trusting this table.
