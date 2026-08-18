# ADR-0029: A config module is given the invocation it is configuring

- Status: Accepted
- Date: 2026-08-18
- Relates to: §18 CLI and Production MCP, §4.2 Aldus Core does not own, §4.3 Integration owns,
  ADR-0019, ADR-0025

## Context

ADR-0019 made the CLI load an operator's config module before dispatching a command, because
what a command can do depends on what the config registers. The config was handed one thing: the
current working directory, used to resolve a relative `--config` path.

The workspace was resolved separately, and later. `--workspace` is a per-command flag, parsed
inside the command handler, while the config module was loaded before dispatch — so the chain
`--workspace` → `ALDUS_WORKSPACE` → cwd was visible to the command and only its last two links
were visible to the config.

For a config that derives nothing from the workspace, that is invisible. For one that does — and
the first real adopter's does, because deriving the workflow graph from the workspace was the
documented workaround while `AldusConfig.workflow` did not exist — **the config configured a
different workspace than the command acted on**:

```
$ aldus run script.lint --run run_… --workspace episodes/… --config ./aldus.config.mjs
ALDUS_STAGE_NOT_REGISTERED: No stage is registered with id "script.lint".

$ ALDUS_WORKSPACE=episodes/… aldus run script.lint --run run_… --config ./aldus.config.mjs
Stage script.lint — succeeded (attempt 1)
```

Same command, same config, same workspace on disk. The first silently configured the repository
root, found no Episode there, and registered nothing.

The error was the worse half. `ALDUS_STAGE_NOT_REGISTERED` sends a reader to audit a stage list
that is correct and complete, while the fault is two layers away in workspace resolution. The
adopter lost time having _written_ the config; someone inheriting it would lose considerably more.

This is the third instance of one shape: an input accepted and silently discarded, surfacing far
from its cause. The first was a config key that loaded and was dropped (ADR-0025); the second was
a constructor that rebuilt its options field by field and omitted a new one. The pattern is worth
naming, because the type system says nothing when a value is _narrowed_ on the way through.

## Decision

### 1. `loadConfig` receives a `ConfigContext`, and a config may be a function of it

```js
export default ({ workspace }) => ({ stages: stagesFor(workspace), gates: [...] });
export default { stages: [...], gates: [...] };   // unchanged
```

`ConfigContext` is an object rather than a positional argument specifically so the resolved actor
or the `--json` flag can join it later without breaking every config module that takes one. Only
`workspace` is on it now; nothing is added speculatively.

A factory may return a promise. Deriving a config sometimes means reading a manifest, and forcing
that to be synchronous pushes adopters toward top-level side effects at import time — which are
worse, because `import()` caches by URL and a side effect at import runs once for a process that
may serve several invocations. A factory is called per invocation, which is the property that
makes it correct under caching.

A throwing factory is reported as `ALDUS_CONFIG_UNREADABLE` naming the module _and the workspace
it was building for_. A bare stack trace from an imported module is close to the least useful
thing a CLI can print, and the usual cause is a workspace that does not hold what the config
assumed.

### 2. `--workspace` and `--config` are resolved before dispatch, wherever they were written

These are two jobs, and conflating them is what made the first attempt at this fix wrong:

- **Finding the value** scans the whole argument vector. The common position is _after_ the
  subcommand — `aldus run stage --workspace X` — and that is exactly where the defect lived. A
  scan that only looked at leading flags would have fixed the rare invocation and left the common
  one broken.
- **Stripping** removes only _leading_ occurrences, so `aldus --workspace X run stage` does not
  land a flag in the command position. A flag written after the subcommand is left in place and
  keeps flowing through `parseArgs` exactly as before, so the common invocation is untouched.

Both positions therefore produce the same answer, and the config sees it either way.

### 3. The CLI sets `ALDUS_WORKSPACE` in its own process environment

Deliberately blunt, and the part most likely to look wrong.

A config module is imported into the CLI's process and can only read the real environment. A
module reading `process.env.ALDUS_WORKSPACE` previously saw the shell's value while the command
acted on `--workspace`. Setting it makes both invocations above behave identically for **every
config that reads the variable, including ones written against `0.1.0` that nobody will
update**.

The alternative was to fix only the API and let existing configs stay wrong until rewritten. That
was rejected because `--workspace` and `ALDUS_WORKSPACE` disagreeing is a bug independent of how
a config is written: two ways of naming the same thing should not name different things.

### 4. An empty registry is reported differently from a missing stage

`ALDUS_NO_STAGES_CONFIGURED` when nothing is registered at all.

"No stage is registered with id X" reads as a typo when the list is populated and as a mystery
when the list is empty — and an empty list almost always means no config was loaded, or one was
loaded against a workspace other than the one being operated on. They are different problems and
deserve different messages.

### 5. Errors whose usual cause is the wrong workspace say which workspace

`ALDUS_STAGE_NOT_REGISTERED`, `ALDUS_NO_STAGES_CONFIGURED`, and the two not-found errors gain a
trailing line naming the resolved workspace and the config module in effect.

The stage runner cannot do this: it knows nothing of `--workspace` or `--config`, and should not.
The adapter that resolved them is the layer that can, which is where it now happens.

## Consequences

- A config module can derive from the workspace without the answer depending on how the operator
  spelled the invocation.
- `process.env` is mutated during `run()`. Harmless in the `aldus` binary, which serves one
  invocation per process, and visible to in-process tests — which save and restore it.
- The `ConfigContext` object is now a public API surface. Adding optional fields to it stays
  non-breaking; removing `workspace` would not be.
- Adding a global flag in future means adding it to `LEADING_GLOBALS` _and_ deciding whether it
  needs pre-dispatch resolution. Two places, which is a cost this design accepts in exchange for
  leaving per-command parsing unchanged.

## Alternatives considered

- **Load the config after dispatch, once flags are parsed.** Rejected: the config supplies the
  stage and gate registries the command needs to construct its services, so the ordering is not
  free to change. It would also mean every command handler repeating the load.
- **Pass the whole `CliEnvironment` to the config.** Rejected: it exposes `stdout`, `stderr`, and
  the injected clock, none of which a config has any business touching, and every one of which
  becomes a compatibility obligation the moment someone uses it.
- **Only set `ALDUS_WORKSPACE` and skip the API change.** Rejected: it makes the fix depend on a
  config reading an environment variable rather than receiving what it needs, and leaves a
  process-global as the sole channel for something the caller already knows.
- **Only add the API and skip `ALDUS_WORKSPACE`.** Rejected: see decision 3. It leaves existing
  configs silently wrong.
