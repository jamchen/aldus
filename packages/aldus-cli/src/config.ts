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
} from "@aldus-runtime/services";
import { StageRegistry, type StageDefinition } from "@aldus-runtime/stage-runner";

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
}

/** A config module may export its config as `default` or as `config`. */
interface ConfigModule {
  default?: AldusConfig;
  config?: AldusConfig;
}

/**
 * Load an operator's config module.
 *
 * @throws {AldusError} `ALDUS_CONFIG_UNREADABLE` when the module cannot be imported, and
 * `ALDUS_CONFIG_INVALID` when it exports nothing usable. Both are environment problems rather
 * than refusals: no approval makes a missing file appear.
 */
export async function loadConfig(specifier: string, cwd: string): Promise<AldusConfig> {
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

  const config = module.default ?? module.config;
  if (config === undefined || typeof config !== "object") {
    throw new AldusError(
      "ALDUS_CONFIG_INVALID",
      `The Aldus config module at "${specifier}" exports no configuration. Export it as the ` +
        'default export, or as a named export called "config".',
      { category: "validation", retryable: false, details: { specifier } },
    );
  }
  return config;
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
