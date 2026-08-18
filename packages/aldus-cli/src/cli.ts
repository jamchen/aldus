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

import type { ActorRef } from "@aldus-runtime/core";
import { AldusError, toStructuredError } from "@aldus-runtime/core";
import { FileWorkspace } from "@aldus-runtime/file-store";
import { GateRegistry, type GateDefinition } from "@aldus-runtime/gate-engine";
import { StageRegistry } from "@aldus-runtime/stage-runner";
import {
  AldusContext,
  AldusServices,
  parseActor,
  type ServiceResult,
  type SubjectsProvider,
} from "@aldus-runtime/services";

import { ExitCodes, type ExitCode } from "./exit.js";
import {
  renderArtifacts,
  renderCosts,
  renderGateDecision,
  renderInit,
  renderInspection,
  renderRelease,
  renderStageRun,
  renderStartRun,
  renderStatus,
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
  help: { type: "boolean" as const, default: false },
} as const;

/**
 * Run the CLI once and return its exit code.
 *
 * Never throws: an uncaught exception from a CLI is a stack trace where an operator expected a
 * message, so everything is mapped to an exit code and a rendered explanation.
 */
export async function run(environment: CliEnvironment): Promise<ExitCode> {
  const [command, ...rest] = environment.argv;

  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    environment.stdout(USAGE);
    return ExitCodes.success;
  }

  try {
    return await dispatch(command, rest, environment);
  } catch (error) {
    return reportError(error, environment);
  }
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
    case "artifacts":
      return await runArtifacts(argv, environment);
    case "costs":
      return await runCosts(argv, environment);
    case "release":
      return await runRelease(argv, environment);
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

/** Turn a thrown value into a rendered message and an exit code. */
function reportError(error: unknown, environment: CliEnvironment): ExitCode {
  const structured = toStructuredError(error);
  const isRefusal = error instanceof AldusError && error.category === "policy";
  environment.stderr(`${structured.code}: ${structured.message}`);
  return isRefusal ? ExitCodes.refused : ExitCodes.error;
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

  const services = servicesFor(options, environment);
  const request = {
    runId: requireRunId(options, command),
    stageId,
    ...(typeof values["input"] === "string"
      ? { input: JSON.parse(values["input"]) as unknown }
      : {}),
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

async function runArtifacts(
  argv: readonly string[],
  environment: CliEnvironment,
): Promise<ExitCode> {
  const { options } = parseCommon(argv, environment);
  const services = servicesFor(options, environment);
  const result = await services.artifacts(requireRunId(options, "artifacts"));
  return emit(result, options, environment, renderArtifacts);
}

async function runCosts(argv: readonly string[], environment: CliEnvironment): Promise<ExitCode> {
  const { options } = parseCommon(argv, environment);
  const services = servicesFor(options, environment);
  const result = await services.costs(requireRunId(options, "costs"));
  return emit(result, options, environment, renderCosts);
}

async function runRelease(argv: readonly string[], environment: CliEnvironment): Promise<ExitCode> {
  const { options, positionals } = parseCommon(argv, environment);
  const subcommand = positionals[0] ?? "status";
  if (subcommand !== "status") {
    throw new AldusError(
      "ALDUS_INVALID_REQUEST",
      `"release ${subcommand}" is not a command. Only "release status" exists — performing a ` +
        "release is WP-12's, and this build has no release adapters.",
      { category: "validation", details: { subcommand } },
    );
  }
  const services = servicesFor(options, environment);
  const result = await services.releaseStatus(requireRunId(options, "release status"));
  return emit(result, options, environment, renderRelease);
}
