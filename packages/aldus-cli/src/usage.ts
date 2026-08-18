/**
 * Usage text (architecture contract §18).
 *
 * Deliberately names no show, host, provider, or platform: §4.2 keeps adopter identities out of
 * the runtime, and help text is part of the runtime's surface.
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
  artifacts                 Artifacts recorded against a Run
  costs                     Cost records and totals
  release status            Release operations and their outcomes

Common options
  --workspace <path>        Workspace root. Defaults to ALDUS_WORKSPACE, then the cwd.
  --run <run-id>            The Run to act on. Required by most commands.
  --actor <kind:id>         Who is acting, e.g. human:operator-a. Defaults to ALDUS_ACTOR.
                            Required for anything that changes durable state.
  --actor-name <name>       Display name for the actor.
  --json                    Machine-readable output.
  --help                    This text.

Command options
  init      --show <id> --slug <slug> | --episode-id <id>
            --title <text> --legacy-ref <ref> --force
  start     --workflow <id> --workflow-version <version> --code-revision <rev>
  run       --stage-version <version> --input <json> --force
  retry     --stage-version <version> --input <json> --force
  approve   --comment <text>
  reject    --comment <text>

Exit codes
  0  the operation completed
  1  refused — understood, and not permitted right now
  2  error — bad invocation or environment
  3  ran, but did not succeed (a stage failed, was cancelled, or halted at a gate)
`;
