/**
 * Usage text (architecture contract §18).
 *
 * Deliberately names no show, host, provider, or platform: §4.2 keeps adopter identities out of
 * the runtime, and help text is part of the runtime's surface.
 *
 * The two commands that can spend money or publish are marked in the list itself rather than
 * only in prose further down. An operator scanning for the command they want should not have to
 * read a paragraph to learn which ones are irreversible.
 */

/** The CLI's help output. */
export const USAGE = `aldus — the Aldus production runtime

Usage
  aldus <command> [options]

Commands
  init                      Create the workspace, and optionally its Episode
  start                     Create a Run
  status                    Current state and the next safe action
  inspect <episode|run>     Everything recorded about one Episode or Run
  run <stage>               Run a stage
  retry <stage>             Re-attempt a stage
  approve <gate>            Record an approval
  reject <gate>             Record a rejection
  costs                     Cost records and totals

  artifacts                 Artifacts recorded against a Run, with archival state
  artifacts lineage <id>    Where an artifact came from and what came of it
  artifacts cleanup-plan    What a cleanup would remove — decides nothing, removes nothing
  artifacts archive         Archive irreplaceable artifacts, as §8.1 requires before cleanup

  release status            Release operations and their outcomes
  release plan              A bundle's derived state and what remains
  release reconcile         Repair the local record against the destinations
  release execute           Perform a release        [publishes — see below]

  script record             Record a PerformanceScript
  synthesis plan            Record a request plan. Authorizes nothing.
  synthesis run             Synthesise one segment   [spends money — see below]
  synthesis charge          Record a charge incurred without authorization
  takes                     Takes recorded for a Run, with their lineage
  takes decide <take-id>    Accept or reject a take

Common options
  --workspace <path>        Workspace root. Defaults to ALDUS_WORKSPACE, then the cwd.
  --run <run-id>            The Run to act on. Required by most commands.
  --actor <kind:id>         Who is acting, e.g. human:operator-a. Defaults to ALDUS_ACTOR.
                            Required for anything that changes durable state.
  --actor-name <name>       Display name for the actor.
  --config <module>         Module supplying stages, gates, subjects, and adapters.
                            Defaults to ALDUS_CONFIG. See "Configuration".
  --json                    Machine-readable output.
  --help                    This text.

Command options
  init          --show <id>                 required to create an Episode; without it only
                                            the workspace is created
                --slug <slug>               with --show: derives the Episode id
                --episode-id <id>           with --show: sets the Episode id instead
                --title <text> --legacy-ref <ref> --force
  start         --workflow <id> --workflow-version <version> --code-revision <rev>
  run           --stage-version <version> --input <json> --force
  retry         --stage-version <version> --input <json> --force
  approve       --comment <text>
  reject        --comment <text>
  release       --bundle <path>            plan, reconcile, and execute
                --dry-run                  execute only: show what remains, perform nothing
  script        --file <path>
  synthesis     --file <path>              plan
                --plan <path> --segment <id>   run
                --take <path> --reason <text> --rejected-authorization <id>   charge
  takes         --decision accepted|rejected --reason <text>

Operations that are not reversible
  synthesis run     calls a synthesis provider and incurs cost. It requires an approved gate
                    binding the exact plan, and a spend grant (contract §13.2). Aldus refuses
                    and calls nothing when that authorization does not currently hold.
  release execute   performs release operations at their destinations. Uploading and making
                    public are separate gates (§13.4); approving one does not authorize the
                    other. Use --dry-run first to see what remains to be done.

Configuration
  Stages, gates, subject digests, and the release and synthesis adapters are supplied by the
  adopter, never discovered (contract §4.2, §4.3). Point --config at a module exporting them
  as its default export:

    export default {
      stages: [...], gates: [...], subjects: async (runId) => ({}),
      releaseAdapters: [...], synthesisAdapter: ..., spendGrants: ..., archive: ...,
    }

  Without one, the commands that need nothing wired still work.

Exit codes
  0  the operation completed
  1  refused — understood, and not permitted right now
  2  error — bad invocation or environment, including a missing adapter
  3  ran, but did not succeed (a stage failed, was cancelled, or halted at a gate)
`;
