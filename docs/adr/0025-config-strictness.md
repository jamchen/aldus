# ADR-0025: An operator's config module rejects keys Aldus does not recognise

- Status: Accepted
- Date: 2026-08-18
- Closes: the strictness half of issue #46
- Relates to: §3.4 Files and Runtime state are authoritative, §4.3 Integration owns, ADR-0002,
  ADR-0003, ADR-0015, ADR-0019

## Context

ADR-0019 gave the `aldus` binary a config module: the operator names a JavaScript module, and the
CLI takes stages, gates, and adapters from what it exports. `AldusConfig` describes the shape,
and nothing checked that a module stayed inside it.

The first external adopter found what that costs. `AldusContextOptions` accepts a `WorkflowGraph`
— the stage↔gate association ADR-0021 added — but `AldusConfig` had no field for one. A config
exporting `workflow:` therefore **loaded cleanly and the field was dropped**. What the operator
then saw was `aldus status` naming the wrong next action, which reads as a gate bug. The cause
was in the config; the symptom was three layers away.

The missing field is fixed separately, and on its own it would leave the mechanism intact: the
next unrecognised key — a typo, a field from a newer version, a field from a different tool —
does exactly the same thing again.

## Decision

**A config module that sets a key `AldusConfig` does not declare is refused**, with an error
naming the offending keys and listing the recognised ones (`ALDUS_CONFIG_UNKNOWN_KEY`).

The workflow graph is validated too, when present: `stages` must be an array, each node must
carry a non-empty `stageId`, `requiredGates` must be an array of non-empty strings, and a stage
declared twice is refused rather than resolved to whichever node comes first. Each message names
the offending node, because a graph decides which gates stand in the way of which stages — so a
malformed one produces a _wrong answer_ rather than an obvious failure, and a generic parse error
would send an operator through the whole graph looking for it.

### Error, not warning

A warning would preserve the failure this ADR exists to remove. Warnings go to a stream that
scrolls past, and the operator most likely to typo a key is the one least likely to be watching
for one. A config is authored deliberately and read once at startup, so there is no cost to
being told immediately, and no partially-completed work to unwind.

### Why this is the opposite of how records are treated

ADR-0002 and ADR-0003 make persisted records **ignore** unknown properties, so a record written
by a newer build stays readable by an older one. Doing the reverse here looks inconsistent, and
is not:

|                   | Persisted record              | Config module                 |
| ----------------- | ----------------------------- | ----------------------------- |
| Written by        | any build, past or future     | the operator, now             |
| Read by           | builds it was not written for | the build installed beside it |
| Unknown key means | a newer version added a field | a mistake                     |
| Right response    | ignore, stay readable         | refuse, say so                |

A stored record crosses versions and must survive them. A config does not travel; it is authored
against the version it sits next to. §3.4's principle — that durable records are authoritative —
argues for honouring what an operator wrote, and silently discarding half of it is the opposite
of honouring it.

## Consequences

- **This is a behaviour change for `0.1.0` adopters.** A config that loaded before may now fail
  at startup, and the fix is to remove or correct the key the error names. It needs a release
  note; an adopter has asked explicitly to learn about behaviour changes from a changelog rather
  than from a failing test.
- The recognised-key list is `satisfies readonly (keyof AldusConfig)[]`, so a key removed from
  the interface fails to compile. A key _added_ to the interface and forgotten in the list is
  caught the first time an operator sets it — the failure is loud rather than silent, which is
  the direction this ADR is about.
- An adopter cannot use a config module to carry its own unrelated settings. That is intended:
  §4.3 puts adopter configuration in the adopter's own code, and a shared object with a
  half-understood shape is how the original problem arose.
- Validation is shallow by design. `stages`, `gates`, and the adapters are checked by the types
  and by the components that consume them; re-validating their internals here would duplicate
  those checks and drift from them.

## Alternatives considered

- **Warn and continue.** Rejected: it keeps the silent-drop failure and adds noise. A warning
  nobody reads is the drop with extra steps.
- **Accept unknown keys as forward compatibility**, mirroring ADR-0002. Rejected: that reasoning
  applies to a record read by a build that did not write it. A config is authored against the
  installed version, so an unknown key carries no information — only a mistake.
- **Validate deeply**, checking adapter and stage shapes at load time. Rejected as duplication:
  those are typed, and the components that use them already refuse what they cannot use.
- **Fix only the missing `workflow` field.** Rejected: it addresses this instance and leaves the
  mechanism, so the next unrecognised key fails the same way, just as invisibly.
