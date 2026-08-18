# ADR-0019: How the CLI receives adapters, and how its verb list grew

- Status: Accepted
- Date: 2026-08-18
- Closes: the CLI half of issue #27 item 4
- Relates to: §4.2, §4.3, §18 CLI and Production MCP, §18.1, §13.2, §13.4, §17, ADR-0011, ADR-0015

## Context

Issue #27 items 1–3 made the artifact registry, the release executor, and the TTS ledger
reachable through `@aldus-runtime/services`. ADR-0015 settled who composes what: Aldus wires its
own packages and defines the injection points; an adopter supplies the concrete adapters.

That left a question no ADR had answered, because until now no command needed one. **How does an
operator standing at a terminal hand a release adapter to the runtime?** Every other input to the
CLI is a flag or an environment variable. An adapter is an object with methods.

The `aldus` binary made the gap visible: `bin.ts` injected no stages, no gates, and no subjects,
so the executable could only ever run the commands that need nothing wired. That was tolerable
while `run` and `approve` were the only commands affected. It is not tolerable now that
`synthesis run` and `release execute` exist and are the two operations that spend money and
publish.

## Decision

### 1. Adapters arrive through a config module named by `--config` or `ALDUS_CONFIG`

The CLI imports a JavaScript module the operator points it at and takes `stages`, `gates`,
`subjects`, `releaseAdapters`, `synthesisAdapter`, `spendGrants`, and `archive` from its default
export.

Discovery was rejected in both forms. Scanning for a conventional filename, or auto-registering
whatever happens to be installed, would make the runtime decide which stages exist — and §4.2
places an adopter's workflow outside the runtime. Worse, for the two irreversible commands it
would mean an adapter that spends money because it was on disk, which nobody chose and nobody
authorised.

The module is imported by path, so §4.2 still holds: Aldus imports a path the operator supplied,
never an adopter package by name.

**Anything the host injects directly wins over the config module.** Tests inject fakes, and a
test whose fake was silently replaced by whatever is configured on the machine would be worse
than no test. In the `aldus` binary nothing is injected, so the config module is the only source
— which is the intent.

### 2. The verb list grew, in the shape §18 already established

§18's V1 list predates WP-03, WP-07, and WP-12, so it is a floor. New operations became
subcommands of the noun they act on, matching `release status`, which was already the only
two-word verb:

| Command                          | Service                    |
| -------------------------------- | -------------------------- |
| `artifacts [list]`               | `artifacts`                |
| `artifacts lineage <id>`         | `artifactLineage`          |
| `artifacts cleanup-plan`         | `planArtifactCleanup`      |
| `artifacts archive`              | `archiveIrreplaceable`     |
| `release status`                 | `releaseStatus`            |
| `release plan --bundle`          | `releaseBundleStatus`      |
| `release reconcile --bundle`     | `reconcileRelease`         |
| `release execute --bundle`       | `executeRelease`           |
| `script record --file`           | `recordPerformanceScript`  |
| `synthesis plan --file`          | `recordSynthesisPlan`      |
| `synthesis run --plan --segment` | `synthesiseSegment`        |
| `synthesis charge …`             | `recordUnauthorizedCharge` |
| `takes [list]`                   | `takes`                    |
| `takes decide <take-id>`         | `decideTake`               |

`artifacts` and `takes` default to `list`, so §18's existing verbs keep working unchanged.

### 3. Whole documents arrive as files, not as flags

`release plan|reconcile|execute` take `--bundle <path>`; `script record` and `synthesis plan`
take `--file <path>`. A `ReleaseBundle` carries operation lists whose criticality is a branded
type — §17's hard-gate/best-effort distinction, which `@aldus-runtime/release` deliberately made
structural rather than a field. Flattening that into `--operation-1-kind` would be a worse
interface and a lossy one.

The CLI reads and parses; it does not validate the shape. The schema belongs to the package that
owns the type, and the service already refuses what it cannot use. A second opinion here would
be a second place for the two to disagree.

### 4. `ALDUS_ADAPTER_NOT_WIRED` exits 2, not 1

`reportError` maps a `policy` category to `refused` (1), on the reasoning that a policy answer is
one a script may wait on and retry.

`ADAPTER_NOT_WIRED` is thrown with `category: "policy"` but its own documentation in
`@aldus-runtime/services` says it is "a wiring error, not a policy refusal: nothing an operator
can approve will make it appear". Retrying it unchanged can never help, which is exactly exit 2's
definition. So the CLI maps that one code to `error`.

This is reported upstream rather than fixed in the service, because mapping an error to an exit
code is this adapter's business either way — but the category and the doc comment disagree, and
one of them should change.

### 5. `--json` also carries thrown failures

`emit` serialised a `ServiceResult` for `--json`, but a _thrown_ `AldusError` went only to
stderr — so `aldus artifacts archive --json` with no actor produced an empty stdout and a caller
parsing it got a syntax error. Found by a test, not by review.

`reportError` now emits `{ outcome, error }` on stdout when `--json` is present, reading the flag
from argv rather than from parsed options, because the failure being reported may be the parse
itself.

### 6. `release execute --dry-run` reuses the read-only service

`--dry-run` calls `releaseBundleStatus` rather than a preview path of its own, so the preview
cannot drift from the thing being previewed. A test asserts the adapter was never reached.

There is deliberately **no equivalent for `synthesis run`**. No service reports whether a plan's
§13.2 authorization currently holds without also synthesising, and inventing one here would put
an authorization decision in the CLI, which ADR-0011 forbids. Instead the refusal path is made
legible: an unauthorized synthesis is refused with the adapter untouched, and rendered as an
explanation rather than a stack trace.

## Consequences

- The `aldus` binary is useful for the first time: stages, gates, and adapters can all reach it.
- An operator's config module is ordinary JavaScript with no imports required — an adapter only
  has to satisfy the interface. The tests write one from scratch rather than importing Aldus's
  own test double, which is what proves the injection point is a real contract.
- Two commands can now cause irreversible effects from a terminal. They are marked as such in the
  command list itself, not only in prose, and the exit-code table names the distinction an
  operator scripting them has to act on.
- **Everything `src/` imports is now a `dependency`.** The new commands added
  `@aldus-runtime/artifact-registry`, `release`, and `tts-ledger`; auditing that also caught
  `file-store`, `gate-engine`, and `stage-runner` sitting in `devDependencies` since WP-08 while
  `src/` constructs `FileWorkspace`, `GateRegistry`, and `StageRegistry` from them at runtime.

  In the monorepo this was invisible: npm workspaces symlinks every package into the root
  `node_modules`, so the build, the type checker, and every test resolved them anyway. A
  published tarball would have failed on the first import. The rule is now explicit —
  `devDependencies` are for what only `test/` and tooling touch — and the coordinator is landing
  a repo-wide test to enforce it, so this class of error stops being invisible.

- Every refusal for a paid or publishing operation is asserted by proving the **adapter was never
  called**. An exit code alone cannot establish that no money was spent.

## Alternatives considered

- **Discover a conventional `aldus.config.js`.** Rejected: implicit configuration for commands
  that spend money is the wrong default, and a runtime that discovers stages is choosing an
  adopter's workflow (§4.2).
- **Flags for every document field.** Rejected: lossy for `ReleaseBundle`'s branded criticality,
  and it would put §17's hard-gate/best-effort distinction in the hands of argv parsing.
- **A confirmation prompt before `synthesis run` and `release execute`.** Rejected: §3.4 makes
  durable records authoritative and §19.2 requires a recorded actor, and a `y/n` prompt records
  nothing. The authorization already exists as a `GateDecision`; a prompt would be ceremony that
  looks like a control.
- **A `--yes` flag for the irreversible commands.** Rejected for the same reason: it would be a
  second, weaker approval mechanism sitting beside §13's real one, and the weaker one is the one
  people would learn to pass by habit.
