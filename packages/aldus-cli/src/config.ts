/**
 * Operator configuration (architecture contract §4.3, ADR-0015).
 *
 * ADR-0015 makes Aldus responsible for composing its own packages and the adopter responsible
 * for supplying the concrete adapters. That leaves a question no other file answers: **how does
 * an operator standing at a terminal hand a release adapter to the runtime?**
 *
 * A config module. The CLI imports a JavaScript module the operator points it at, and takes the
 * adapters, stages, and gates from what it exports. That keeps §4.2 intact — the runtime still
 * imports no adopter code, it imports a path the operator chose — while giving the `aldus`
 * binary a way to be genuinely useful rather than limited to the commands that need nothing
 * wired.
 *
 * The alternative was discovery: scanning for a conventional filename, or auto-registering
 * whatever happened to be installed. Both were rejected. A runtime that decides which stages
 * exist is deciding an adopter's workflow (§4.2), and an adapter that appears because it was on
 * disk is an adapter nobody chose — which for `synthesise` and `release execute` means money and
 * publication.
 */

import { pathToFileURL } from "node:url";

import type { ArtifactArchive } from "@aldus-runtime/artifact-registry";
import { AldusError } from "@aldus-runtime/core";
import type { GateDefinition } from "@aldus-runtime/gate-engine";
import type { ReleaseAdapter } from "@aldus-runtime/release";
import type {
  SpendGrantProvider,
  SubjectsProvider,
  SynthesisAdapter,
  WorkflowGraph,
  WorkflowStageNode,
} from "@aldus-runtime/services";
import {
  StageRegistry,
  type AgentBackend,
  type StageDefinition,
  type WorkerRegistry,
} from "@aldus-runtime/stage-runner";

/**
 * What the CLI knows about this invocation when it loads a config module.
 *
 * The reason this exists: `--workspace` is resolved by the CLI, and before this parameter
 * existed a config module could observe only `ALDUS_WORKSPACE` and the cwd. A config deriving
 * anything from the workspace — an archive path, a per-episode adapter, a spend grant that
 * varies by show — therefore configured a *different* workspace than the command acted on, and
 * the failure surfaced as an unrelated error two layers away.
 *
 * Deliberately an object rather than a positional argument, so the resolved actor or the
 * `--json` flag can join it later without breaking every config module that takes one.
 */
export interface ConfigContext {
  /**
   * The resolved workspace root: `--workspace`, then `ALDUS_WORKSPACE`, then the cwd.
   *
   * Absolute or relative exactly as the operator wrote it, because a config that derives a path
   * from it should produce the same path the command acts on rather than a normalised variant.
   */
  readonly workspace: string;
}

/**
 * A config module may export a function of the invocation instead of a fixed object.
 *
 * The object form remains the common case and is unchanged. The function form exists for a
 * config that needs to know the workspace before it can name its stages or adapters — which is
 * every config that serves more than one Episode from one module.
 *
 * May return a promise: deriving a config sometimes means reading a manifest, and forcing that
 * to be synchronous would push adopters toward top-level side effects at import time.
 */
export type AldusConfigFactory = (context: ConfigContext) => AldusConfig | Promise<AldusConfig>;

/**
 * What an operator's config module may export.
 *
 * Every field is optional. A workspace that only needs `status` and `inspect` needs no config at
 * all, which matters for §24: seeing the current state must not require configuring identities
 * and adapters first.
 */
export interface AldusConfig {
  /**
   * Stage definitions available to `run` and `retry` (contract §11).
   *
   * Supplied rather than discovered: §4.2 keeps adopter stages out of the runtime.
   */
  stages?: StageRegistry | readonly StageDefinition<never, unknown>[];
  /** Gate definitions in force (contract §13). */
  gates?: readonly GateDefinition[];
  /**
   * Current digests of what each gate binds (contract §13.2).
   *
   * Aldus cannot compute these — what a gate binds is adopter process (§4.3) — and a gate with
   * no subjects supplied reads as `pending` rather than as satisfied.
   */
  subjects?: SubjectsProvider;
  /**
   * Adapters that perform release operations (contract §17, §4.3).
   *
   * Aldus owns the orchestration, the idempotency, and the refusal; an adapter talks to one
   * destination. §4.2 forbids the runtime from naming a publishing platform, so these can only
   * come from here.
   */
  releaseAdapters?: readonly ReleaseAdapter[];
  /**
   * The adapter that performs synthesis (contract §14, §15, §4.3).
   *
   * Reachable only after §13.2's authorization succeeds. Supplying one is what makes
   * `aldus synthesis run` able to spend money, which is why it is an explicit act.
   */
  synthesisAdapter?: SynthesisAdapter;
  /** Spend grants in force, per plan (contract §13.2, §19.3). */
  spendGrants?: SpendGrantProvider;
  /** Where irreplaceable artifact bytes are kept (contract §8.1). */
  archive?: ArtifactArchive;
  /**
   * Which gates gate which stages, for this workflow (contract §11, ADR-0021).
   *
   * §11 calls a workflow "a versioned graph of stages and gates" and makes that graph
   * adopter-supplied, so it can only come from here. Without it a stage's own `requiredGates`
   * still applies, and a workflow declaring neither behaves as it did before ADR-0021.
   *
   * One graph per context. An adopter whose single config module serves several workflows
   * selects the graph itself — the context is constructed before a Run is known, so Aldus
   * cannot select by `workflowId` on its behalf.
   */
  workflow?: WorkflowGraph;
  /**
   * Workers a stage may invoke (§3.2, §4.1; ADR-0035).
   *
   * Present because a seam a composition cannot reach is not a seam. The Worker contract, its
   * registry and the `StageContext.runWorker` path all shipped before this field existed, and an
   * adopter could write a Worker that nothing in their pipeline could invoke — every path to a
   * Stage runs through this file (#121).
   */
  workers?: WorkerRegistry;
  /**
   * The agent backend a stage's executions run through (§10, §4.1).
   *
   * `AldusContext` has accepted a backend since it was written; nothing could supply one from a
   * config, so the option existed and no adopter could use it. Same gap as `workers`, older.
   */
  agentBackend?: AgentBackend;
}

/**
 * Every key {@link AldusConfig} recognises.
 *
 * Declared as data because {@link assertKnownKeys} compares against it at runtime. A key added
 * to the interface and forgotten here is rejected by the type checker at the point of use, which
 * is the intended direction: the list cannot silently fall behind the interface.
 */
const KNOWN_CONFIG_KEYS = [
  "agentBackend",
  "archive",
  "gates",
  "releaseAdapters",
  "spendGrants",
  "stages",
  "subjects",
  "synthesisAdapter",
  "workers",
  "workflow",
] as const satisfies readonly (keyof AldusConfig)[];

/**
 * Every key of {@link AldusConfig} must appear in the list above, or this does not compile.
 *
 * `satisfies` above catches a listed key that is **not** on the interface. It does not catch the
 * opposite, and the opposite is the direction that bites: a field is declared on the interface,
 * the CLI reads it and passes it to the composition, and `loadConfig` refuses the key before that
 * code can run. An adopter then writes a field they can see in the type, typechecks clean, and is
 * told at runtime that it does not exist (#123).
 *
 * A test would catch this too, and a compile error catches it earlier and cannot be skipped. The
 * failure names the missing key, because `MissingConfigKey` resolves to it.
 */
type MissingConfigKey = Exclude<keyof AldusConfig, (typeof KNOWN_CONFIG_KEYS)[number]>;
const _everyConfigKeyIsRecognised: MissingConfigKey extends never ? true : MissingConfigKey = true;
void _everyConfigKeyIsRecognised;

/** A config module may export its config as `default` or as `config`, as an object or a factory. */
interface ConfigModule {
  default?: AldusConfig | AldusConfigFactory;
  config?: AldusConfig | AldusConfigFactory;
}

/**
 * Load an operator's config module.
 *
 * `context` carries what the CLI resolved for this invocation, so a config exported as a function
 * can see the workspace the command will actually act on. `cwd` is separate and is used only to
 * resolve a relative `--config` path: the module lives where the operator wrote it, which is not
 * necessarily inside the workspace.
 *
 * @throws {AldusError} `ALDUS_CONFIG_UNREADABLE` when the module cannot be imported,
 * `ALDUS_CONFIG_INVALID` when it exports nothing usable or a malformed workflow graph, and
 * `ALDUS_CONFIG_UNKNOWN_KEY` when it sets a key Aldus does not recognise. All are environment
 * problems rather than refusals: no approval makes a missing file appear.
 */
export async function loadConfig(
  specifier: string,
  cwd: string,
  context: ConfigContext,
): Promise<AldusConfig> {
  const url = resolveSpecifier(specifier, cwd);

  let module: ConfigModule;
  try {
    module = (await import(url)) as ConfigModule;
  } catch (cause) {
    throw new AldusError(
      "ALDUS_CONFIG_UNREADABLE",
      `Could not load the Aldus config module at "${specifier}": ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { category: "io", retryable: false, details: { specifier } },
    );
  }

  const exported = module.default ?? module.config;
  const config =
    typeof exported === "function" ? await callFactory(exported, context, specifier) : exported;

  if (config === undefined || typeof config !== "object") {
    throw new AldusError(
      "ALDUS_CONFIG_INVALID",
      `The Aldus config module at "${specifier}" exports no configuration. Export it as the ` +
        'default export, or as a named export called "config" — either an object, or a ' +
        "function of the invocation returning one.",
      { category: "validation", retryable: false, details: { specifier } },
    );
  }

  assertKnownKeys(config, specifier);
  if (config.workflow !== undefined) assertWorkflowGraph(config.workflow, specifier);
  return config;
}

/**
 * Invoke a config factory, attributing what it throws to the module rather than to Aldus.
 *
 * A factory runs adopter code, so a failure inside it is an adopter's bug — and a bare stack
 * trace from an imported module is close to the least useful thing a CLI can print. Naming the
 * module and the workspace it was building for keeps the fault findable, since the usual cause
 * is a workspace that does not hold what the config assumed.
 *
 * @throws {AldusError} `ALDUS_CONFIG_UNREADABLE`
 */
async function callFactory(
  factory: AldusConfigFactory,
  context: ConfigContext,
  specifier: string,
): Promise<AldusConfig> {
  try {
    return await factory(context);
  } catch (cause) {
    throw new AldusError(
      "ALDUS_CONFIG_UNREADABLE",
      `The Aldus config module at "${specifier}" threw while building its configuration for ` +
        `workspace "${context.workspace}": ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      { category: "io", retryable: false, details: { specifier, workspace: context.workspace } },
    );
  }
}

/**
 * Refuse a config that sets a key Aldus does not recognise.
 *
 * An unrecognised key is a mistake every time — a typo, or a field from a newer version — and
 * ignoring it silently makes the symptom appear somewhere other than the cause. A config that
 * set `workflow` before that field existed loaded cleanly and did nothing, and what an operator
 * then saw was `status` naming the wrong next action: a wiring problem wearing a gate problem's
 * clothes.
 *
 * This is an **error, not a warning**. A config is authored deliberately and read once at
 * startup, so there is no cost to being told immediately, and a warning on a stream nobody reads
 * is the silent drop with extra steps.
 *
 * Note this is the opposite of how Aldus treats *persisted records*, which ignore unknown
 * properties so a record written by a newer build stays readable (ADR-0002, ADR-0003). The two
 * are different problems: a stored record is read by builds it was not written for, while a
 * config is authored against the version installed beside it.
 *
 * @throws {AldusError} `ALDUS_CONFIG_UNKNOWN_KEY`
 */
function assertKnownKeys(config: AldusConfig, specifier: string): void {
  const known = new Set<string>(KNOWN_CONFIG_KEYS);
  const unknown = Object.keys(config).filter((key) => !known.has(key));
  if (unknown.length === 0) return;

  throw new AldusError(
    "ALDUS_CONFIG_UNKNOWN_KEY",
    `The Aldus config module at "${specifier}" sets ${unknown.map((key) => `"${key}"`).join(", ")}, ` +
      `which Aldus does not recognise. Recognised keys are: ${KNOWN_CONFIG_KEYS.join(", ")}.`,
    { category: "validation", retryable: false, details: { specifier, unknown } },
  );
}

/**
 * Refuse a malformed workflow graph, naming the stage at fault (contract §11, ADR-0021).
 *
 * The graph decides which gates stand in the way of which stages, so a malformed one produces a
 * wrong answer to "what is safe to do next" rather than an obvious failure. Naming the offending
 * node is what makes that debuggable — a generic parse error would send an operator through the
 * whole graph looking for it.
 *
 * @throws {AldusError} `ALDUS_CONFIG_INVALID`
 */
function assertWorkflowGraph(workflow: WorkflowGraph, specifier: string): void {
  const fail = (problem: string, details: Record<string, unknown>): never => {
    throw new AldusError(
      "ALDUS_CONFIG_INVALID",
      `The workflow graph in the Aldus config module at "${specifier}" is invalid: ${problem}`,
      { category: "validation", retryable: false, details: { specifier, ...details } },
    );
  };

  if (!Array.isArray(workflow.stages)) {
    fail('"workflow.stages" must be an array of stage nodes.', {});
    return;
  }

  const seen = new Set<string>();
  workflow.stages.forEach((node: WorkflowStageNode, index: number) => {
    const at = `workflow.stages[${index}]`;
    const stageId: unknown = node?.stageId;
    if (typeof stageId !== "string" || stageId.length === 0) {
      fail(`${at} has no "stageId".`, { index });
      return;
    }
    if (seen.has(stageId)) {
      // Two nodes for one stage make resolution order-dependent, and `resolveRequiredGates` takes
      // the first — so the second would be silently ignored, which is this issue over again.
      fail(`${at} repeats stage "${stageId}", which an earlier node already declares.`, {
        index,
        stageId,
      });
      return;
    }
    seen.add(stageId);

    if (node.requiredGates === undefined) return;
    if (!Array.isArray(node.requiredGates)) {
      fail(`${at} ("${stageId}") has a "requiredGates" that is not an array.`, { index, stageId });
      return;
    }
    for (const gate of node.requiredGates) {
      if (typeof gate !== "string" || gate.length === 0) {
        fail(`${at} ("${stageId}") lists a gate id that is not a non-empty string.`, {
          index,
          stageId,
        });
        return;
      }
    }
  });
}

/** Turn a path or bare specifier into something `import()` accepts. */
function resolveSpecifier(specifier: string, cwd: string): string {
  // A bare specifier stays one, so an adopter can ship its integration as a package rather than
  // as a loose file next to the workspace.
  if (!specifier.startsWith(".") && !specifier.startsWith("/")) return specifier;
  const absolute = specifier.startsWith("/")
    ? specifier
    : `${cwd.replace(/\/+$/, "")}/${specifier}`;
  return pathToFileURL(absolute).href;
}

/** Normalise the `stages` field, which accepts a registry or a plain list. */
export function stageRegistryOf(stages: AldusConfig["stages"]): StageRegistry | undefined {
  if (stages === undefined) return undefined;
  if (stages instanceof StageRegistry) return stages;
  const registry = new StageRegistry();
  for (const stage of stages) registry.register(stage);
  return registry;
}
