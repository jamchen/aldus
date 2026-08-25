/**
 * The Aldus CLI (architecture contract §18).
 *
 * A **thin adapter** over `@aldus-runtime/services`, and thin is the design requirement rather than an
 * aspiration. §18 makes the CLI and the Production MCP two adapters over one service layer, so
 * anything decided here is a decision WP-11 would have to reimplement — and two implementations
 * of an approval path is the divergence §3.6 warns about.
 *
 * What this file is therefore allowed to do: parse argv, resolve the actor and workspace, call
 * exactly one service method, render or serialise the result, and choose an exit code. What it
 * must not do: interpret a gate, decide whether something is safe, or reach into a store.
 *
 * `run` is written against an injected environment rather than the globals, so the whole surface
 * is testable in-process — a CLI tested only by spawning subprocesses tends to end up with the
 * interesting branches untested because they are awkward to reach.
 */

import { parseArgs } from "node:util";

import type { ArtifactArchive } from "@aldus-runtime/artifact-registry";
import type { ActorRef } from "@aldus-runtime/core";
import { AldusError, toStructuredError } from "@aldus-runtime/core";
import { FileWorkspace } from "@aldus-runtime/file-store";
import { GateRegistry, type GateDefinition } from "@aldus-runtime/gate-engine";
import type { ReleaseAdapter, ReleaseBundle } from "@aldus-runtime/release";
import {
  AldusContext,
  AldusServices,
  parseActor,
  ServiceErrorCodes,
  type ServiceResult,
  type SpendGrantProvider,
  type DispatchSpendGrantProvider,
  type SubjectsProvider,
  type SynthesisAdapter,
  type WorkflowGraph,
} from "@aldus-runtime/services";
import { StageRegistry, type AgentBackend, type WorkerRegistry } from "@aldus-runtime/stage-runner";
import type {
  PerformanceScript,
  RecordTakeInput,
  TakeDecision,
  TakeDecisionValue,
  TtsRequestPlan,
} from "@aldus-runtime/tts-ledger";

import { loadConfig, stageRegistryOf, type AldusConfig } from "./config.js";
import { readJsonDocument, requireFlag } from "./documents.js";
import { ExitCodes, type ExitCode } from "./exit.js";
import {
  renderArchive,
  renderArtifactLineage,
  renderArtifacts,
  renderCancelRun,
  renderCleanupPlan,
  renderCosts,
  renderGateDecision,
  renderInit,
  renderInspection,
  renderPlan,
  renderRelease,
  renderReleaseBundle,
  renderReleaseExecution,
  renderReleaseReconciliation,
  renderScript,
  renderStageRun,
  renderStartRun,
  renderStatus,
  renderSynthesis,
  renderTakeDecision,
  renderTakes,
} from "./render.js";
import { USAGE } from "./usage.js";

/** Everything the CLI touches outside itself, injected so tests need no subprocess. */
export interface CliEnvironment {
  /** Argument vector, excluding the node binary and script path. */
  argv: readonly string[];
  /** Environment variables. */
  env: Readonly<Record<string, string | undefined>>;
  /** Working directory, used as the default workspace root. */
  cwd: string;
  /** Where normal output goes. */
  stdout: (text: string) => void;
  /** Where errors and diagnostics go. */
  stderr: (text: string) => void;
  /**
   * Stage definitions available to `run` and `retry`.
   *
   * Supplied by the host rather than discovered: §4.2 keeps adopter stages out of the runtime,
   * and a CLI that scanned for them would be deciding an adopter's workflow.
   */
  stages?: StageRegistry;
  /** Gate definitions in force (contract §13). Same reasoning as `stages`. */
  gates?: readonly GateDefinition[];
  /** Current digests of what gates bind (contract §13.2). */
  subjects?: SubjectsProvider;
  /**
   * Adapters that perform release operations (contract §17, §4.3, ADR-0015).
   *
   * Supplied by the host — in the `aldus` binary, by the operator's config module. Aldus owns
   * the orchestration and the refusal; an adapter talks to one destination.
   */
  releaseAdapters?: readonly ReleaseAdapter[];
  /** The adapter that performs synthesis (contract §14, §15, §4.3). */
  synthesisAdapter?: SynthesisAdapter;
  /** Spend grants in force, per plan (contract §13.2, §19.3). */
  spendGrants?: SpendGrantProvider;
  /** Where irreplaceable artifact bytes are kept (contract §8.1). */
  archive?: ArtifactArchive;
  /**
   * Which gates gate which stages, for this workflow (contract §11, ADR-0021).
   *
   * Supplied by the host, or by the operator's config module in the `aldus` binary. Without it
   * a stage's own `requiredGates` still applies and behaviour is unchanged.
   */
  workflow?: WorkflowGraph;
  /** Workers a stage may invoke, from the config or injected by a test (§4.1, ADR-0035). */
  workers?: WorkerRegistry;
  /** The agent backend stage executions run through (§10). */
  agentBackend?: AgentBackend;
  /** Spend grants in force for a Worker operation (§13.2, §19.3; #107). */
  dispatchSpendGrants?: DispatchSpendGrantProvider;
  /** Clock, injectable for deterministic tests. */
  now?: () => Date;
}

/** Options parsed from the command line, shared by every command. */
interface CommonOptions {
  json: boolean;
  workspace: string;
  runId?: string;
  actor?: ActorRef;
}

const COMMON_OPTION_SPEC = {
  json: { type: "boolean" as const, default: false },
  workspace: { type: "string" as const },
  run: { type: "string" as const },
  actor: { type: "string" as const },
  "actor-name": { type: "string" as const },
  // Consumed before dispatch by `withConfig`, and declared here so `strict: true` does not
  // reject it on every command.
  config: { type: "string" as const },
  help: { type: "boolean" as const, default: false },
} as const;

/**
 * Run the CLI once and return its exit code.
 *
 * Never throws: an uncaught exception from a CLI is a stack trace where an operator expected a
 * message, so everything is mapped to an exit code and a rendered explanation.
 */
export async function run(environment: CliEnvironment): Promise<ExitCode> {
  // Kept outside the try so a failure that happens *after* the workspace is known can still say
  // which workspace it was. An error raised before then has nothing to report and says nothing.
  let invocation: Invocation = {};

  try {
    const {
      argv,
      workspace: workspaceFlag,
      config: configFlag,
    } = takeLeadingGlobals(environment.argv);
    const [command, ...rest] = argv;

    if (command === undefined || command === "--help" || command === "-h" || command === "help") {
      environment.stdout(USAGE);
      return ExitCodes.success;
    }

    const workspace = workspaceFlag ?? environment.env["ALDUS_WORKSPACE"] ?? environment.cwd;
    const specifier = configFlag ?? environment.env["ALDUS_CONFIG"];
    invocation = { workspace, ...(specifier !== undefined ? { config: specifier } : {}) };

    const bound = bindWorkspace(environment, workspace);
    return await dispatch(command, rest, await withConfig(bound, specifier, workspace));
  } catch (error) {
    return reportError(error, environment, invocation);
  }
}

/** What the CLI resolved for this invocation, for use in diagnostics. */
interface Invocation {
  workspace?: string;
  config?: string;
}

/** Global flags that take a value and are meaningful before a subcommand is chosen. */
const LEADING_GLOBALS = ["--workspace", "--config"] as const;

/**
 * Resolve `--workspace` and `--config` before a subcommand is chosen, wherever they were written.
 *
 * Both decide things that happen before per-command parsing — the workspace decides which state
 * the command acts on, and the config decides what is registered — so both have to be readable
 * from the raw argv. That is two jobs, and conflating them is what made the first attempt at this
 * wrong:
 *
 * - **Finding the value** scans the whole vector, because the common position is *after* the
 *   subcommand (`aldus run stage --workspace X`) and that is where the defect lived.
 * - **Stripping** removes only *leading* occurrences, because those would otherwise land in the
 *   command position and fail as an unknown command. One written after the subcommand is left
 *   in place so {@link parseCommon} keeps parsing it exactly as before — the common invocation
 *   is untouched, and both positions produce the same answer.
 *
 * @throws {AldusError} `ALDUS_INVALID_REQUEST` when a flag is given without a value.
 */
function takeLeadingGlobals(argv: readonly string[]): {
  argv: readonly string[];
  workspace?: string;
  config?: string;
} {
  let index = 0;
  while (index < argv.length && LEADING_GLOBALS.some((flag) => flag === argv[index])) {
    // The value is validated by `flagValue` below; here we only need to know it consumed a pair.
    index += 2;
  }
  const remaining = argv.slice(index);

  const workspace = flagValue(argv, "--workspace", "a path");
  const config = flagValue(argv, "--config", "a module path");
  return {
    argv: remaining,
    ...(workspace !== undefined ? { workspace } : {}),
    ...(config !== undefined ? { config } : {}),
  };
}

/**
 * The value of a flag anywhere in argv, refusing one that swallowed the next flag.
 *
 * `--workspace --json` is a missing value rather than a workspace literally named `--json`, and
 * treating it as the latter produces a confusing failure much later — a directory that does not
 * exist, reported by whatever tried to read it.
 *
 * @throws {AldusError} `ALDUS_INVALID_REQUEST`
 */
function flagValue(argv: readonly string[], flag: string, needs: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new AldusError("ALDUS_INVALID_REQUEST", `${flag} needs ${needs}.`, {
      category: "validation",
      details: { flag },
    });
  }
  return value;
}

/**
 * Make the resolved workspace visible to everything downstream, including a config module.
 *
 * Two things happen here, and the second is deliberately blunt.
 *
 * `env` gains the resolved value so {@link parseCommon} reaches the same answer whether the flag
 * was written before or after the subcommand — its `ALDUS_WORKSPACE` fallback now holds what
 * `--workspace` resolved to.
 *
 * `process.env` gains it too, because a config module is imported into *this* process and can
 * only read the real environment. A module that read `process.env.ALDUS_WORKSPACE` previously saw
 * the shell's value while the command acted on `--workspace`, and configured a different
 * workspace than the one being operated on. Mutating the process environment is unpleasant, and
 * still the right trade: `--workspace` and `ALDUS_WORKSPACE` disagreeing is a bug regardless of
 * how a config is written, and this makes every existing config correct without being rewritten.
 */
function bindWorkspace(environment: CliEnvironment, workspace: string): CliEnvironment {
  process.env["ALDUS_WORKSPACE"] = workspace;
  return { ...environment, env: { ...environment.env, ALDUS_WORKSPACE: workspace } };
}

/**
 * Fold an operator's config module into the environment (ADR-0015, ADR-0019).
 *
 * What the host injected always wins, so a test that supplies a fake adapter is not overridden
 * by whatever happens to be configured on the machine. In the `aldus` binary nothing is injected,
 * so the config module is the only source — which is the point.
 */
async function withConfig(
  environment: CliEnvironment,
  specifier: string | undefined,
  workspace: string,
): Promise<CliEnvironment> {
  if (specifier === undefined) return environment;

  // The workspace is passed rather than left to the module to guess. `cwd` stays separate: it
  // resolves a relative `--config` path, and the module lives where the operator wrote it, which
  // is not necessarily inside the workspace.
  const config: AldusConfig = await loadConfig(specifier, environment.cwd, { workspace });
  const stages = stageRegistryOf(config.stages);

  return {
    ...environment,
    ...(environment.stages === undefined && stages !== undefined ? { stages } : {}),
    ...(environment.gates === undefined && config.gates !== undefined
      ? { gates: config.gates }
      : {}),
    ...(environment.subjects === undefined && config.subjects !== undefined
      ? { subjects: config.subjects }
      : {}),
    ...(environment.releaseAdapters === undefined && config.releaseAdapters !== undefined
      ? { releaseAdapters: config.releaseAdapters }
      : {}),
    ...(environment.synthesisAdapter === undefined && config.synthesisAdapter !== undefined
      ? { synthesisAdapter: config.synthesisAdapter }
      : {}),
    ...(environment.spendGrants === undefined && config.spendGrants !== undefined
      ? { spendGrants: config.spendGrants }
      : {}),
    ...(environment.archive === undefined && config.archive !== undefined
      ? { archive: config.archive }
      : {}),
    ...(environment.workflow === undefined && config.workflow !== undefined
      ? { workflow: config.workflow }
      : {}),
    ...(environment.workers === undefined && config.workers !== undefined
      ? { workers: config.workers }
      : {}),
    ...(environment.agentBackend === undefined && config.agentBackend !== undefined
      ? { agentBackend: config.agentBackend }
      : {}),
    ...(environment.dispatchSpendGrants === undefined && config.dispatchSpendGrants !== undefined
      ? { dispatchSpendGrants: config.dispatchSpendGrants }
      : {}),
  };
}

/** Route one command to one service call. */
async function dispatch(
  command: string,
  argv: readonly string[],
  environment: CliEnvironment,
): Promise<ExitCode> {
  switch (command) {
    case "init":
      return await runInit(argv, environment);
    case "start":
      return await runStart(argv, environment);
    case "status":
      return await runStatus(argv, environment);
    case "inspect":
      return await runInspect(argv, environment);
    case "run":
      return await runStage(argv, environment, "run");
    case "retry":
      return await runStage(argv, environment, "retry");
    case "approve":
      return await runDecision(argv, environment, "approve");
    case "reject":
      return await runDecision(argv, environment, "reject");
    case "waive":
      return await runWaive(argv, environment);
    case "cancel":
      return await runCancel(argv, environment);
    case "artifacts":
      return await runArtifacts(argv, environment);
    case "costs":
      return await runCosts(argv, environment);
    case "release":
      return await runRelease(argv, environment);
    case "script":
      return await runScript(argv, environment);
    case "synthesis":
      return await runSynthesis(argv, environment);
    case "takes":
      return await runTakes(argv, environment);
    default:
      environment.stderr(`Unknown command "${command}".\n\n${USAGE}`);
      return ExitCodes.error;
  }
}

/** Parse the options every command shares. */
function parseCommon(
  argv: readonly string[],
  environment: CliEnvironment,
  extra: Record<string, { type: "string" | "boolean"; default?: boolean }> = {},
): { options: CommonOptions; values: Record<string, unknown>; positionals: string[] } {
  const parsed = parseArgs({
    args: [...argv],
    options: { ...COMMON_OPTION_SPEC, ...extra },
    allowPositionals: true,
    strict: true,
  });

  const values = parsed.values as Record<string, unknown>;
  const workspaceFlag = typeof values["workspace"] === "string" ? values["workspace"] : undefined;
  const actorFlag = typeof values["actor"] === "string" ? values["actor"] : undefined;
  const actorName = typeof values["actor-name"] === "string" ? values["actor-name"] : undefined;
  const actorSource = actorFlag ?? environment.env["ALDUS_ACTOR"];

  return {
    options: {
      json: values["json"] === true,
      workspace: workspaceFlag ?? environment.env["ALDUS_WORKSPACE"] ?? environment.cwd,
      ...(typeof values["run"] === "string" ? { runId: values["run"] } : {}),
      ...(actorSource !== undefined ? { actor: parseActor(actorSource, actorName) } : {}),
    },
    values,
    positionals: parsed.positionals,
  };
}

/** Build the services for one invocation. */
function servicesFor(options: CommonOptions, environment: CliEnvironment): AldusServices {
  const context = new AldusContext({
    workspace: new FileWorkspace(options.workspace),
    gates: GateRegistry.from(environment.gates ?? []),
    stages: environment.stages ?? new StageRegistry(),
    ...(options.actor !== undefined ? { actor: options.actor } : {}),
    ...(environment.subjects !== undefined ? { subjects: environment.subjects } : {}),
    ...(environment.releaseAdapters !== undefined
      ? { releaseAdapters: environment.releaseAdapters }
      : {}),
    ...(environment.synthesisAdapter !== undefined
      ? { synthesisAdapter: environment.synthesisAdapter }
      : {}),
    ...(environment.spendGrants !== undefined ? { spendGrants: environment.spendGrants } : {}),
    ...(environment.archive !== undefined ? { archive: environment.archive } : {}),
    ...(environment.workflow !== undefined ? { workflow: environment.workflow } : {}),
    ...(environment.workers !== undefined ? { workers: environment.workers } : {}),
    ...(environment.agentBackend !== undefined ? { backend: environment.agentBackend } : {}),
    ...(environment.dispatchSpendGrants !== undefined
      ? { dispatchSpendGrants: environment.dispatchSpendGrants }
      : {}),
    ...(environment.now !== undefined ? { now: environment.now } : {}),
  });
  return new AldusServices(context);
}

/**
 * Emit a service result and map it to an exit code.
 *
 * The single place the JSON and human paths diverge, and they diverge only in formatting — both
 * are handed the same `result` object, so neither can show something the other cannot (§18).
 */
function emit<T>(
  result: ServiceResult<T>,
  options: CommonOptions,
  environment: CliEnvironment,
  render: (data: T) => string,
): ExitCode {
  if (options.json) {
    environment.stdout(JSON.stringify(result, null, 2));
  } else if (result.outcome === "refused") {
    environment.stderr(`Refused: ${result.refusal.explanation}`);
  } else {
    environment.stdout(render(result.data));
    if (result.outcome === "unsuccessful") environment.stderr(result.explanation);
  }

  if (result.outcome === "ok") return ExitCodes.success;
  if (result.outcome === "refused") return ExitCodes.refused;
  return ExitCodes.unsuccessful;
}

/**
 * Turn a thrown value into a rendered message and an exit code.
 *
 * A `policy` category maps to `refused`, because a policy answer is one a script may reasonably
 * wait on and retry — with one exception. `ALDUS_ADAPTER_NOT_WIRED` is thrown with that category
 * but is documented in `@aldus-runtime/services` as "a wiring error, not a policy refusal:
 * nothing an operator can approve will make it appear". Retrying it unchanged can never help,
 * which is exit 2's definition, so it is mapped there. Reported upstream rather than fixed in
 * services, since the mapping from an error to an exit code is this adapter's business anyway.
 */
function reportError(
  error: unknown,
  environment: CliEnvironment,
  invocation: Invocation = {},
): ExitCode {
  const structured = toStructuredError(error);
  const isWiringError = structured.code === ServiceErrorCodes.ADAPTER_NOT_WIRED;
  const isRefusal = !isWiringError && error instanceof AldusError && error.category === "policy";
  const outcome = isRefusal ? "refused" : "error";
  const context = misconfigurationContext(structured.code, invocation);

  // `--json` is read from argv rather than from parsed options, because the failure being
  // reported may be the parse itself. A caller that asked for machine-readable output and got an
  // empty stdout would have to fall back to scraping stderr, which is the opposite of §18's
  // intent — so the error is emitted in the same shape a refusal takes.
  if (environment.argv.includes("--json")) {
    const detailed =
      context === undefined
        ? structured
        : { ...structured, details: { ...structured.details, ...invocation } };
    environment.stdout(JSON.stringify({ outcome, error: detailed }, null, 2));
  }

  environment.stderr(`${structured.code}: ${structured.message}${context ?? ""}`);
  return isRefusal ? ExitCodes.refused : ExitCodes.error;
}

/**
 * Errors whose usual cause is a workspace or config other than the one the reader assumes.
 *
 * `ALDUS_STAGE_NOT_REGISTERED` is the one that cost an adopter real time: it sends you to audit
 * a stage list that is correct and complete, while the fault is two layers away in workspace
 * resolution. The stage runner cannot say this — it knows nothing of `--workspace` or `--config`,
 * and should not — so the adapter that resolved them names them here.
 */
const MISCONFIGURATION_PRONE_CODES: readonly string[] = [
  "ALDUS_STAGE_NOT_REGISTERED",
  "ALDUS_NO_STAGES_CONFIGURED",
  "ALDUS_EPISODE_NOT_FOUND",
  "ALDUS_RUN_NOT_FOUND",
];

/** A trailing line naming the workspace and config in effect, when that is likely to be the fault. */
function misconfigurationContext(code: string, invocation: Invocation): string | undefined {
  if (!MISCONFIGURATION_PRONE_CODES.includes(code)) return undefined;
  if (invocation.workspace === undefined) return undefined;
  const config =
    invocation.config === undefined ? "no config module" : `config "${invocation.config}"`;
  return `\n  Workspace: ${invocation.workspace} (${config})`;
}

/**
 * Refuse before the service call when *nothing* is registered.
 *
 * An empty registry and a missing stage are different problems wearing the same error. "No stage
 * is registered with id X" reads as a typo when the list is populated, and as a mystery when the
 * list is empty — and an empty list almost always means no config was loaded, or one was loaded
 * against a workspace other than the one being operated on. Saying so here costs one lookup and
 * removes the misdirection.
 *
 * @throws {AldusError} `ALDUS_NO_STAGES_CONFIGURED`
 */
function assertStagesConfigured(environment: CliEnvironment, stageId: string): void {
  if ((environment.stages?.ids().length ?? 0) > 0) return;
  throw new AldusError(
    "ALDUS_NO_STAGES_CONFIGURED",
    `No stages are registered at all, so "${stageId}" cannot be run. Stages come from a config ` +
      "module (§4.2 keeps them out of the runtime), so either none was loaded, or the one that " +
      "was loaded registered nothing for this workspace.",
    { category: "validation", retryable: false, details: { stageId } },
  );
}

/** Require a `--run` for commands that need one. */
function requireRunId(options: CommonOptions, command: string): string {
  if (options.runId !== undefined) return options.runId;
  throw new AldusError(
    "ALDUS_INVALID_REQUEST",
    `"${command}" needs a Run. Pass --run <run-id>, or see "aldus status" for the Runs in this workspace.`,
    { category: "validation", details: { command } },
  );
}

// -------------------------------------------------------------------------------------------
// Commands
// -------------------------------------------------------------------------------------------

/**
 * Flags that describe an Episode rather than the workspace.
 *
 * Every one of them is meaningless without `--show`, because `InitRequest.episode` requires a
 * `showId`. Listed here so the refusal can name exactly which of them the operator supplied.
 */
const EPISODE_FLAGS = ["episode-id", "slug", "title", "legacy-ref"] as const;

async function runInit(argv: readonly string[], environment: CliEnvironment): Promise<ExitCode> {
  const { options, values } = parseCommon(argv, environment, {
    show: { type: "string" },
    slug: { type: "string" },
    "episode-id": { type: "string" },
    title: { type: "string" },
    "legacy-ref": { type: "string" },
    force: { type: "boolean", default: false },
  });
  const services = servicesFor(options, environment);
  const show = typeof values["show"] === "string" ? values["show"] : undefined;

  // `InitRequest.episode` requires a `showId`, so without `--show` every other Episode flag is
  // dropped. Creating the workspace and quietly no Episode is the failure this refuses: the two
  // outcomes previously differed only by an absent line of output.
  if (show === undefined) {
    const supplied = EPISODE_FLAGS.filter((flag) => typeof values[flag] === "string");
    if (supplied.length > 0) {
      throw new AldusError(
        "ALDUS_INVALID_REQUEST",
        `${supplied.map((flag) => `--${flag}`).join(", ")} ${
          supplied.length === 1 ? "describes" : "describe"
        } an Episode, and an Episode needs --show <id>. ` +
          "Add --show to create one, or drop these flags to initialise the workspace alone.",
        { category: "validation", retryable: false, details: { supplied } },
      );
    }
  }

  const result = await services.init({
    ...(show !== undefined
      ? {
          episode: {
            showId: show,
            ...(typeof values["slug"] === "string" ? { slug: values["slug"] } : {}),
            ...(typeof values["episode-id"] === "string"
              ? { episodeId: values["episode-id"] }
              : {}),
            ...(typeof values["title"] === "string" ? { title: values["title"] } : {}),
            ...(typeof values["legacy-ref"] === "string"
              ? { legacyRef: values["legacy-ref"] }
              : {}),
          },
        }
      : {}),
    ...(values["force"] === true ? { force: true } : {}),
    ...(options.actor !== undefined ? { actor: options.actor } : {}),
  });

  return emit(result, options, environment, renderInit);
}

async function runStart(argv: readonly string[], environment: CliEnvironment): Promise<ExitCode> {
  const { options, values } = parseCommon(argv, environment, {
    workflow: { type: "string" },
    "workflow-version": { type: "string" },
    "code-revision": { type: "string" },
  });
  const workflow = typeof values["workflow"] === "string" ? values["workflow"] : undefined;
  if (workflow === undefined) {
    throw new AldusError("ALDUS_INVALID_REQUEST", '"start" needs --workflow <id>.', {
      category: "validation",
    });
  }

  const services = servicesFor(options, environment);
  const result = await services.startRun({
    workflowId: workflow,
    workflowVersion:
      typeof values["workflow-version"] === "string" ? values["workflow-version"] : "1",
    ...(typeof values["code-revision"] === "string"
      ? { codeRevision: values["code-revision"] }
      : {}),
    ...(options.actor !== undefined ? { actor: options.actor } : {}),
  });

  return emit(result, options, environment, renderStartRun);
}

async function runStatus(argv: readonly string[], environment: CliEnvironment): Promise<ExitCode> {
  const { options } = parseCommon(argv, environment);
  const services = servicesFor(options, environment);
  const result = await services.status(options.runId);
  return emit(result, options, environment, renderStatus);
}

async function runInspect(argv: readonly string[], environment: CliEnvironment): Promise<ExitCode> {
  const { options, positionals } = parseCommon(argv, environment);
  const subject = positionals[0] ?? options.runId;
  if (subject === undefined) {
    throw new AldusError("ALDUS_INVALID_REQUEST", '"inspect" needs an Episode or Run identifier.', {
      category: "validation",
    });
  }
  const services = servicesFor(options, environment);
  const result = await services.inspect(subject);
  return emit(result, options, environment, renderInspection);
}

async function runStage(
  argv: readonly string[],
  environment: CliEnvironment,
  command: "run" | "retry",
): Promise<ExitCode> {
  const { options, values, positionals } = parseCommon(argv, environment, {
    "stage-version": { type: "string" },
    force: { type: "boolean", default: false },
    input: { type: "string" },
  });
  const stageId = positionals[0];
  if (stageId === undefined) {
    throw new AldusError("ALDUS_INVALID_REQUEST", `"${command}" needs a stage id.`, {
      category: "validation",
    });
  }

  assertStagesConfigured(environment, stageId);

  const services = servicesFor(options, environment);
  const request = {
    runId: requireRunId(options, command),
    stageId,
    // An absent `--input` means "run this with no input", and `{}` is that in JSON. Omitting the
    // key sends `undefined` to the stage's schema, and every object-shaped schema rejects it — so
    // the command `status` prints, which never carries `--input`, refused for any stage with a
    // realistic input schema (#80). A stage that genuinely requires fields still refuses, with the
    // same message: `{}` is what the operator supplied, not a claim that it is valid.
    input: typeof values["input"] === "string" ? (JSON.parse(values["input"]) as unknown) : {},
    ...(typeof values["stage-version"] === "string"
      ? { stageVersion: values["stage-version"] }
      : {}),
    ...(values["force"] === true ? { force: true } : {}),
    ...(options.actor !== undefined ? { actor: options.actor } : {}),
  };

  const result =
    command === "run" ? await services.runStage(request) : await services.retryStage(request);
  return emit(result, options, environment, renderStageRun);
}

async function runDecision(
  argv: readonly string[],
  environment: CliEnvironment,
  command: "approve" | "reject",
): Promise<ExitCode> {
  const { options, values, positionals } = parseCommon(argv, environment, {
    comment: { type: "string" },
  });
  const gateId = positionals[0];
  if (gateId === undefined) {
    throw new AldusError("ALDUS_INVALID_REQUEST", `"${command}" needs a gate id.`, {
      category: "validation",
    });
  }

  const services = servicesFor(options, environment);
  const request = {
    runId: requireRunId(options, command),
    gateId,
    ...(typeof values["comment"] === "string" ? { comment: values["comment"] } : {}),
    ...(options.actor !== undefined ? { actor: options.actor } : {}),
  };

  const result =
    command === "approve" ? await services.approve(request) : await services.reject(request);
  return emit(result, options, environment, renderGateDecision);
}

/**
 * `waive <gate> --reason <why>` — record that a check was **bypassed**, not passed (§13).
 *
 * A separate verb rather than a flag on `approve`, because the two record different facts and the
 * approvals log is read by people deciding whether to trust what came before. An operator who
 * cannot honestly approve a gate previously had two shapes available — widen the gate's permitted
 * actors, or approve something they did not judge — and both write a decision that misdescribes
 * what happened.
 *
 * `--reason` is required by the **engine**, and deliberately not re-checked here. See the note in
 * the body: a second copy of the rule out here fired ahead of the actor check and told an agent it
 * needed a better reason when it may not decide the gate at all.
 *
 * There is deliberately no `--expires-on-change`: a waiver's is forced true and the engine refuses
 * an override. A non-expiring waiver is a disabled gate wearing a decision's clothes.
 */
async function runWaive(argv: readonly string[], environment: CliEnvironment): Promise<ExitCode> {
  const { options, values, positionals } = parseCommon(argv, environment, {
    reason: { type: "string" },
  });
  const gateId = positionals[0];
  if (gateId === undefined) {
    throw new AldusError("ALDUS_INVALID_REQUEST", '"waive" needs a gate id.', {
      category: "validation",
    });
  }
  // **The reason is not validated here**, deliberately, and the first version of this command got
  // it wrong. A check in front of the engine's is not a friendlier copy of it — it is a second
  // rule, and it fires first.
  //
  // Measured by an adopter through this door: an `agent:` actor waiving a `human_oracle` gate with
  // an empty reason got "needs --reason" rather than "not permitted", because this ran before the
  // engine saw the call. So an agent that may not decide the gate at all learned that it needed a
  // better reason. The ordering argument that justified putting the rules in the engine is the
  // same argument against keeping a copy out here.
  //
  // An absent `--reason` is passed through as empty and refused by the engine, which is the only
  // place that knows both rules and the order they belong in.
  const reason = values["reason"];

  const services = servicesFor(options, environment);
  const result = await services.waive({
    runId: requireRunId(options, "waive"),
    gateId,
    reason: typeof reason === "string" ? reason : "",
    ...(options.actor !== undefined ? { actor: options.actor } : {}),
  });
  return emit(result, options, environment, renderGateDecision);
}

/**
 * `cancel` — abandon a Run (contract §19.1, §19.2).
 *
 * The only Run state that cannot be derived: §5.1 makes long pauses ordinary, so an idle Run and
 * an abandoned one are indistinguishable until someone says which it is (ADR-0026).
 *
 * No confirmation prompt. §3.4 makes durable records authoritative and §19.2 requires a recorded
 * actor; a y/n prompt records nothing, and a second weaker approval beside the real one is what
 * people learn to pass by habit.
 */
async function runCancel(argv: readonly string[], environment: CliEnvironment): Promise<ExitCode> {
  const { options, values } = parseCommon(argv, environment, {
    reason: { type: "string" },
  });

  const services = servicesFor(options, environment);
  const result = await services.cancelRun({
    runId: requireRunId(options, "cancel"),
    ...(typeof values["reason"] === "string" ? { reason: values["reason"] } : {}),
    ...(options.actor !== undefined ? { actor: options.actor } : {}),
  });
  return emit(result, options, environment, renderCancelRun);
}

/**
 * `artifacts [list|lineage|cleanup-plan|archive]` (contract §8, §20).
 *
 * Subcommands rather than flags, matching `release status`'s existing shape. `list` stays the
 * default so the §18 verb keeps working unchanged.
 */
async function runArtifacts(
  argv: readonly string[],
  environment: CliEnvironment,
): Promise<ExitCode> {
  const { options, positionals } = parseCommon(argv, environment);
  const services = servicesFor(options, environment);
  const [subcommand = "list", ...rest] = positionals;

  switch (subcommand) {
    case "list":
      return emit(
        await services.artifacts(requireRunId(options, "artifacts")),
        options,
        environment,
        renderArtifacts,
      );

    case "lineage": {
      const artifactId = rest[0];
      if (artifactId === undefined) {
        throw new AldusError("ALDUS_INVALID_REQUEST", '"artifacts lineage" needs an artifact id.', {
          category: "validation",
        });
      }
      return emit(
        await services.artifactLineage(artifactId),
        options,
        environment,
        renderArtifactLineage,
      );
    }

    case "cleanup-plan":
      // Read-only, and deliberately separate from any command that removes anything: §8.1 wants
      // an operator able to see whether a cleanup is safe before performing one.
      return emit(
        await services.planArtifactCleanup(
          requireRunId(options, "artifacts cleanup-plan"),
          rest.length > 0 ? rest : undefined,
        ),
        options,
        environment,
        renderCleanupPlan,
      );

    case "archive":
      return emit(
        await services.archiveIrreplaceable({
          runId: requireRunId(options, "artifacts archive"),
          ...(options.actor !== undefined ? { actor: options.actor } : {}),
        }),
        options,
        environment,
        renderArchive,
      );

    default:
      throw new AldusError(
        "ALDUS_INVALID_REQUEST",
        `"artifacts ${subcommand}" is not a command. Use list, lineage, cleanup-plan, or archive.`,
        { category: "validation", details: { subcommand } },
      );
  }
}

async function runCosts(argv: readonly string[], environment: CliEnvironment): Promise<ExitCode> {
  const { options } = parseCommon(argv, environment);
  const services = servicesFor(options, environment);
  const result = await services.costs(requireRunId(options, "costs"));
  return emit(result, options, environment, renderCosts);
}

/**
 * `release [status|plan|reconcile|execute]` (contract §17, §13.4).
 *
 * `plan`, `reconcile`, and `execute` all take `--bundle <path>`: a `ReleaseBundle` carries
 * operation lists with branded criticality (§17's hard-gate/best-effort distinction), and
 * flattening that into flags would be both a worse interface and a lossy one.
 */
async function runRelease(argv: readonly string[], environment: CliEnvironment): Promise<ExitCode> {
  const { options, values, positionals } = parseCommon(argv, environment, {
    bundle: { type: "string" },
    "dry-run": { type: "boolean", default: false },
  });
  const services = servicesFor(options, environment);
  const subcommand = positionals[0] ?? "status";

  if (subcommand === "status") {
    const result = await services.releaseStatus(requireRunId(options, "release status"));
    return emit(result, options, environment, renderRelease);
  }

  if (subcommand !== "plan" && subcommand !== "reconcile" && subcommand !== "execute") {
    throw new AldusError(
      "ALDUS_INVALID_REQUEST",
      `"release ${subcommand}" is not a command. Use status, plan, reconcile, or execute.`,
      { category: "validation", details: { subcommand } },
    );
  }

  const path = requireFlag(values, "bundle", `release ${subcommand}`, "path to a bundle JSON file");
  const bundle = await readJsonDocument<ReleaseBundle>(path, "--bundle", environment.cwd);

  if (subcommand === "plan") {
    return emit(
      await services.releaseBundleStatus({ bundle }),
      options,
      environment,
      renderReleaseBundle,
    );
  }

  if (subcommand === "reconcile") {
    return emit(
      await services.reconcileRelease({
        bundle,
        ...(options.actor !== undefined ? { actor: options.actor } : {}),
      }),
      options,
      environment,
      renderReleaseReconciliation,
    );
  }

  // `execute` publishes. `--dry-run` answers "what would this do" using the read-only status
  // service rather than a second code path, so the preview cannot drift from the thing previewed.
  if (values["dry-run"] === true) {
    if (!options.json) {
      environment.stderr(
        "Dry run: showing the bundle's current state. Nothing was executed and nothing was published.",
      );
    }
    return emit(
      await services.releaseBundleStatus({ bundle }),
      options,
      environment,
      renderReleaseBundle,
    );
  }

  return emit(
    await services.executeRelease({
      bundle,
      ...(options.actor !== undefined ? { actor: options.actor } : {}),
    }),
    options,
    environment,
    renderReleaseExecution,
  );
}

/** `script record --file <path>` — record a PerformanceScript (contract §14.1). */
async function runScript(argv: readonly string[], environment: CliEnvironment): Promise<ExitCode> {
  const { options, values, positionals } = parseCommon(argv, environment, {
    file: { type: "string" },
  });
  const subcommand = positionals[0] ?? "record";
  if (subcommand !== "record") {
    throw new AldusError(
      "ALDUS_INVALID_REQUEST",
      `"script ${subcommand}" is not a command. Only "script record" exists.`,
      { category: "validation", details: { subcommand } },
    );
  }

  const path = requireFlag(
    values,
    "file",
    "script record",
    "path to a PerformanceScript JSON file",
  );
  const script = await readJsonDocument<PerformanceScript>(path, "--file", environment.cwd);
  const services = servicesFor(options, environment);

  return emit(
    await services.recordPerformanceScript({
      script,
      ...(options.actor !== undefined ? { actor: options.actor } : {}),
    }),
    options,
    environment,
    renderScript,
  );
}

/**
 * `synthesis [plan|run|charge]` (contract §13.2, §15).
 *
 * `run` is the only command in this CLI that can spend money, and the only path from Aldus to a
 * synthesis provider. It authorizes before it calls — see `synthesis.ts` in
 * `@aldus-runtime/services` — so a plan whose §13.2 authorization does not hold is refused with
 * the adapter untouched. Nothing here re-decides that; the refusal is rendered as it arrives.
 */
async function runSynthesis(
  argv: readonly string[],
  environment: CliEnvironment,
): Promise<ExitCode> {
  const { options, values, positionals } = parseCommon(argv, environment, {
    file: { type: "string" },
    plan: { type: "string" },
    segment: { type: "string" },
    take: { type: "string" },
    reason: { type: "string" },
    "rejected-authorization": { type: "string" },
  });
  const services = servicesFor(options, environment);
  const subcommand = positionals[0] ?? "plan";

  if (subcommand === "plan") {
    const path = requireFlag(values, "file", "synthesis plan", "path to a request plan JSON file");
    const plan = await readJsonDocument<TtsRequestPlan>(path, "--file", environment.cwd);
    return emit(
      await services.recordSynthesisPlan({
        plan,
        ...(options.actor !== undefined ? { actor: options.actor } : {}),
      }),
      options,
      environment,
      renderPlan,
    );
  }

  if (subcommand === "run") {
    const planPath = requireFlag(
      values,
      "plan",
      "synthesis run",
      "path to a request plan JSON file",
    );
    const plan = await readJsonDocument<TtsRequestPlan>(planPath, "--plan", environment.cwd);
    const segmentId = requireFlag(values, "segment", "synthesis run", "segment id");
    return emit(
      await services.synthesiseSegment({
        plan,
        segmentId,
        ...(options.actor !== undefined ? { actor: options.actor } : {}),
      }),
      options,
      environment,
      renderSynthesis,
    );
  }

  if (subcommand === "charge") {
    // The escape hatch of ADR-0012 §5: a charge that already happened without a valid
    // authorization. It performs no synthesis and cannot reach an adapter — recording a charge is
    // not the same as being allowed to incur one.
    const planPath = requireFlag(
      values,
      "plan",
      "synthesis charge",
      "path to a request plan JSON file",
    );
    const plan = await readJsonDocument<TtsRequestPlan>(planPath, "--plan", environment.cwd);
    const segmentId = requireFlag(values, "segment", "synthesis charge", "segment id");
    const takePath = requireFlag(values, "take", "synthesis charge", "path to a take JSON file");
    const take = await readJsonDocument<RecordTakeInput["take"]>(
      takePath,
      "--take",
      environment.cwd,
    );
    const reason = requireFlag(values, "reason", "synthesis charge", "why it was unauthorized");
    const rejected = values["rejected-authorization"];

    return emit(
      await services.recordUnauthorizedCharge({
        plan,
        segmentId,
        take,
        reason,
        ...(typeof rejected === "string" ? { rejectedAuthorizationId: rejected } : {}),
        ...(options.actor !== undefined ? { actor: options.actor } : {}),
      }),
      options,
      environment,
      renderSynthesis,
    );
  }

  throw new AldusError(
    "ALDUS_INVALID_REQUEST",
    `"synthesis ${subcommand}" is not a command. Use plan, run, or charge.`,
    { category: "validation", details: { subcommand } },
  );
}

/** `takes [list|decide]` (contract §13.3, §15, §15.1). */
async function runTakes(argv: readonly string[], environment: CliEnvironment): Promise<ExitCode> {
  const { options, values, positionals } = parseCommon(argv, environment, {
    decision: { type: "string" },
    reason: { type: "string" },
  });
  const services = servicesFor(options, environment);
  const [subcommand = "list", ...rest] = positionals;

  if (subcommand === "list") {
    return emit(
      await services.takes(requireRunId(options, "takes")),
      options,
      environment,
      renderTakes,
    );
  }

  if (subcommand !== "decide") {
    throw new AldusError(
      "ALDUS_INVALID_REQUEST",
      `"takes ${subcommand}" is not a command. Use list or decide.`,
      { category: "validation", details: { subcommand } },
    );
  }

  const takeId = rest[0];
  if (takeId === undefined) {
    throw new AldusError("ALDUS_INVALID_REQUEST", '"takes decide" needs a take id.', {
      category: "validation",
    });
  }

  const value = values["decision"];
  if (value !== "accepted" && value !== "rejected") {
    throw new AldusError(
      "ALDUS_INVALID_REQUEST",
      '"takes decide" needs --decision accepted|rejected.',
      { category: "validation", details: { decision: value } },
    );
  }

  const actor = options.actor;
  if (actor === undefined) {
    // Caught here as well as in the service, because a decision is built from the actor's
    // identity: constructing one from a placeholder would produce a record §3.6 says is worthless.
    throw new AldusError(
      "ALDUS_ACTOR_REQUIRED",
      "Deciding a take records who decided (contract §19.2, §13.3). Pass --actor human:<id>.",
      { category: "policy" },
    );
  }

  const reason = values["reason"];
  const decision: TakeDecision = {
    decision: value satisfies TakeDecisionValue,
    decidedBy: actor.id,
    decidedAt: (environment.now?.() ?? new Date()).toISOString(),
    ...(typeof reason === "string" ? { reason } : {}),
  };

  return emit(
    await services.decideTake({
      runId: requireRunId(options, "takes decide"),
      takeId,
      decision,
      actor,
    }),
    options,
    environment,
    renderTakeDecision,
  );
}
