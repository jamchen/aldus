# Changelog

Every published version, and what changes for someone already using the previous one.

Aldus versions in lockstep: all `@aldus-runtime/*` packages share a version (ADR-0020). Entries
below apply to the whole set unless a package is named.

**Behaviour changes are listed before features.** An adopter should learn that something they
rely on now behaves differently by reading this file, not by watching a test go red.

## Unreleased

Targeted at `0.2.0-next.0` — a prerelease published to the `next` dist-tag only, per ADR-0023.
Not yet published; the release gate is the owner's.

### Behaviour changes

**`aldus run` now refuses a stage whose declared gate is unsatisfied** ([#45]). Previously
`aldus status` reported such a stage as blocked and `aldus run` executed it anyway, side effects
included. §11 requires a stage to stop at required gates; recording `waiting_for_gate` afterwards
is not stopping.

_What you will see:_ a stage declaring `requiredGates` that currently runs regardless will now be
refused, with exit code 1 and the same explanation `status` already prints. **On first upgrade a
workflow whose gates are unsatisfied early by design — a synthesis stage gated on a performance
freeze, a release stage gated on its upload gate — will present as a wall of refusals.** That is
the fix working, not a regression, but it is worth telling operators before they meet it.

_What has not changed:_ a stage that declares nothing keeps running as it did. Enforcement
applies only to gates a stage actually declares. `status` output is byte-identical apart from a
new `enforcement` field, so anything parsing it keeps working.

**`aldus retry` obeys the same rule** ([#45]). It previously offered and performed a retry for a
retryable failed stage regardless of gates.

**A config module exporting an unrecognised key now fails at startup** ([#46]). Previously the
key was silently dropped, which is how a config supplying a workflow graph appeared to be
ignored — the symptom surfaced as a wrong next action, two layers from the cause. Unknown keys
are now refused by name, listing the recognised ones. A config using only documented keys is
unaffected.

**`aldus init` refuses Episode flags without `--show`** ([#46]). Previously it created the
workspace, silently created no Episode, and printed success output differing only by an absent
line.

### Added

- **`AldusConfig.workflow`** ([#46]) — a workflow graph is now reachable from the CLI, so the
  stage↔gate association of ADR-0021 can actually be used from the binary.

### Fixed

- The release workflow was unparseable to GitHub after a duplicate `inputs:` key, which made it
  fire a failing run on every push to every branch ([#50]). CI now validates workflow files.

[#45]: https://github.com/jamchen/aldus/issues/45
[#46]: https://github.com/jamchen/aldus/issues/46
[#50]: https://github.com/jamchen/aldus/pull/50

## 0.1.0 — 2026-08-18

Bootstrap public preview. Twelve packages published to npm under `@aldus-runtime`.

**Not validated by a real adopter at the time of release.** See
[`docs/releases/0.1.0.md`](docs/releases/0.1.0.md) for the full release report, integrity table,
and source commit.

Both `latest` and `next` point at `0.1.0`. That was not intended — npm assigns `latest` on a
package's first publish regardless of `--tag` — and is documented as a bootstrap exception in
ADR-0023. Later unvalidated releases use prerelease versions instead, which npm will not move
`latest` to.
