/**
 * The stage registry (architecture contract §11, §22 WP-04).
 *
 * A workflow is "a versioned graph of stages and gates" (§11), so a stage is identified by `id`
 * *and* `version`, never by `id` alone. Both are kept resolvable at once: §20 requires a
 * completed Run to stay explicable, and a Run that executed `v1` must still be readable after
 * `v2` is registered.
 */

import type { StageDefinition } from "./definition.js";
import { StageRunnerErrorCodes, stageRunnerError } from "./errors.js";

/** Key under which a definition is stored. */
function keyOf(id: string, version: string): string {
  return `${id}@${version}`;
}

/** A versioned collection of stage definitions (contract §11). */
export class StageRegistry {
  readonly #byKey = new Map<string, StageDefinition<never, unknown>>();
  readonly #versionsById = new Map<string, string[]>();

  /**
   * Register a definition.
   *
   * @throws {AldusError} `ALDUS_STAGE_ALREADY_REGISTERED` if the `id`/`version` pair is taken.
   * Re-registering silently would let two definitions of the same version exist across a process
   * restart depending on import order, and §20 could no longer say which one ran.
   */
  register<I, O>(definition: StageDefinition<I, O>): this {
    const key = keyOf(definition.id, definition.version);
    if (this.#byKey.has(key)) {
      throw stageRunnerError(
        StageRunnerErrorCodes.STAGE_ALREADY_REGISTERED,
        `Stage "${definition.id}" version "${definition.version}" is already registered. ` +
          "Registering a second definition under one version would make production trace " +
          "ambiguous about which one ran (contract §20).",
        {
          category: "conflict",
          retryable: false,
          details: { stageId: definition.id, stageVersion: definition.version },
        },
      );
    }
    // Refused at registration, before anything can run it (ADR-0036). The type already requires
    // `effectKey` on this arm, so this catches the definition that did not come through the type:
    // one built from configuration, or handed over by a JavaScript adopter. A stage that declares
    // a deduplicable external effect and supplies no derivation would otherwise silently receive
    // the invocation fingerprint, which is stable across content it read but did not declare.
    const idempotency = definition.idempotency as {
      kind: string;
      effectKey?: unknown;
    };
    if (
      idempotency.kind === "idempotent_external_effect" &&
      typeof idempotency.effectKey !== "function"
    ) {
      throw stageRunnerError(
        StageRunnerErrorCodes.STAGE_EFFECT_KEY_REQUIRED,
        `Stage "${definition.id}" declares an idempotent external effect but supplies no ` +
          "`effectKey` derivation. The runtime-derived invocation key is a fingerprint of " +
          "declared work and must never be offered to an external system as a deduplication " +
          "guarantee (contract §19.1, ADR-0036): it is stable across content a stage read but " +
          "did not declare as an input artifact.",
        {
          category: "validation",
          retryable: false,
          details: { stageId: definition.id, stageVersion: definition.version },
        },
      );
    }

    this.#byKey.set(key, definition as unknown as StageDefinition<never, unknown>);
    const versions = this.#versionsById.get(definition.id) ?? [];
    versions.push(definition.version);
    versions.sort();
    this.#versionsById.set(definition.id, versions);
    return this;
  }

  /** True if the `id`/`version` pair is registered. */
  has(id: string, version: string): boolean {
    return this.#byKey.has(keyOf(id, version));
  }

  /** Every registered stage id, sorted. */
  ids(): string[] {
    return [...this.#versionsById.keys()].sort();
  }

  /** Every registered version of one stage id, sorted. */
  versionsOf(id: string): string[] {
    return [...(this.#versionsById.get(id) ?? [])];
  }

  /**
   * Look up a definition.
   *
   * @throws {AldusError} `ALDUS_STAGE_NOT_REGISTERED` when the id or version is unknown. The
   * message names the versions that *are* registered, because the common cause is a workflow
   * pinned to a version that has since moved.
   */
  require<I = unknown, O = unknown>(id: string, version: string): StageDefinition<I, O> {
    const found = this.#byKey.get(keyOf(id, version));
    if (found === undefined) {
      const known = this.versionsOf(id);
      throw stageRunnerError(
        StageRunnerErrorCodes.STAGE_NOT_REGISTERED,
        known.length === 0
          ? `No stage is registered with id "${id}".`
          : `Stage "${id}" has no version "${version}". Registered versions: ${known.join(", ")}.`,
        {
          category: "not_found",
          retryable: false,
          details: { stageId: id, stageVersion: version, registeredVersions: known },
        },
      );
    }
    return found as unknown as StageDefinition<I, O>;
  }

  /** Look up a definition, or `undefined` if it is not registered. */
  get<I = unknown, O = unknown>(id: string, version: string): StageDefinition<I, O> | undefined {
    return this.#byKey.get(keyOf(id, version)) as unknown as StageDefinition<I, O> | undefined;
  }
}
