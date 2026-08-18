/**
 * Gate definitions (architecture contract §12, §13).
 *
 * A definition is **configuration**: what a gate binds to, what it depends on, how strongly it
 * blocks, and who may decide it. A {@link GateDecision} is a **record**: what someone decided,
 * when, and against which exact inputs. Keeping them apart is what lets a decision stay a
 * faithful historical fact while the configuration around it evolves.
 *
 * Contract §13 names four gates — Content Freeze (§13.1), Performance Freeze (§13.2), Human Ear
 * (§13.3), Final Release (§13.4). None of them is hardcoded here. §4.2 keeps show-specific
 * process out of Core's reach and §4.3 gives adopters their own gates, so `gateId` and the
 * subject keys are open strings and the contract's four gates are simply the definitions an
 * adopter is most likely to write. The tests construct them to show the model expresses §13, not
 * because the engine knows their names.
 */

import type { ActorKind } from "@aldus/core";

import { GateEngineErrorCodes, gateEngineError } from "./errors.js";

/**
 * The four quality levels of contract §12.
 *
 * These describe *what kind of judgement* a gate represents, which is independent of how
 * strongly it blocks. §12's own table pairs them freely: a hard gate blocks, an advisory signal
 * does not, and a model-assisted review may do either depending on whether it has been
 * calibrated (§12.1).
 */
export const GATE_LEVELS = [
  /** Blocks on an objectively testable failure (§12 level 1). */
  "hard_gate",
  /** Reports a possible issue without blocking (§12 level 2). */
  "advisory_signal",
  /** Evaluates meaning, stance, style, or claims under uncertainty (§12 level 3). */
  "model_assisted",
  /** A human owns the judgement, because it is subjective or asymmetric-risk (§12 level 4). */
  "human_oracle",
] as const;

/** @see GATE_LEVELS */
export type GateLevel = (typeof GATE_LEVELS)[number];

/**
 * Whether a gate stops work or merely reports.
 *
 * Deliberately a two-state enumeration rather than a boolean. Contract §12.1 permits an
 * evaluator to *become* blocking only after calibration, which makes this a promotion with
 * evidence behind it — and a field named `blocking: boolean` invites someone to flip it in a
 * config file without producing any.
 */
export const GATE_ENFORCEMENTS = ["blocking", "advisory"] as const;

/** @see GATE_ENFORCEMENTS */
export type GateEnforcement = (typeof GATE_ENFORCEMENTS)[number];

/**
 * Evidence that a model-assisted evaluator was calibrated before it was allowed to block.
 *
 * Contract §12.1: "An evaluator MAY become blocking only after it is calibrated against
 * human-labeled examples." The metrics themselves belong to WP-10; this is the reference a
 * definition must carry to claim they exist, and {@link validateGateDefinition} refuses a
 * blocking model-assisted gate without one.
 *
 * `scope` matters as much as the numbers. §12.1 lists show, host, voice, model, and script-form
 * scope among what promotion must consider, because an evaluator calibrated on one host says
 * nothing about another. Dimensions are caller-supplied (§4.2), consistent with WP-09's packs.
 */
export interface PromotionEvidence {
  /** Identifier of the calibration report that justified promotion (WP-10). */
  reportRef: string;
  /** Scope the calibration covers, e.g. `{ host: "example-host", voice: "voice-a" }`. */
  scope: Record<string, string>;
  /** Known blind spots recorded at promotion time (§12.1, §9.3). */
  knownBlindSpots?: string[];
}

/**
 * One configured gate.
 *
 * @see GateDecision for the record a decision on this gate produces.
 */
export interface GateDefinition {
  /**
   * Identity of the gate.
   *
   * An OPEN string. Contract §13's four gates are examples an adopter configures, not a set Core
   * fixes (§4.2). Do not narrow this to a union.
   */
  gateId: string;
  /** Operator-facing name. */
  title?: string;
  /** What kind of judgement this gate represents (§12). */
  level: GateLevel;
  /** Whether it stops work or merely reports (§12). */
  enforcement: GateEnforcement;
  /**
   * Named subjects a decision on this gate must bind.
   *
   * For a Performance Freeze these are §13.2's list — spoken-text hash, PerformanceScript hash,
   * voice/model/settings, request plan or segment scope, maximum authorized cost — but the keys
   * are caller-supplied strings, because what a gate binds is adopter process (§4.3).
   *
   * A decision that does not cover every key here is refused: §13.2 requires the operator to
   * approve *all* of the listed values, and an authorization missing one of them binds less than
   * the contract requires.
   */
  binds: readonly string[];
  /**
   * Gates whose invalidation invalidates this one (contract §13.1).
   *
   * §13.1 requires a content-changing edit to invalidate the Content Freeze "and downstream
   * approvals". This edge is what "downstream" means, stated per gate rather than inferred, so
   * an adopter's own gates participate in the cascade without the engine guessing an order.
   */
  dependsOn?: readonly string[];
  /**
   * Actor kinds permitted to decide this gate.
   *
   * Defaults to human-only for `human_oracle`, and to any actor otherwise. §13.3 keeps final
   * performance approval human-owned "until a scoped evaluator is demonstrably reliable", and
   * §12 forbids presenting a machine pass as semantic correctness.
   */
  permittedActorKinds?: readonly ActorKind[];
  /**
   * Default for {@link GateDecision.expiresOnChange} on this gate.
   *
   * Defaults to `true`. §13.1 and §13.2 both require invalidation on change, and a gate that
   * silently defaulted to carrying a stale approval forward would be the failure those sections
   * exist to prevent.
   */
  expiresOnChange?: boolean;
  /** Calibration evidence, required when a model-assisted gate is blocking (§12.1). */
  promotionEvidence?: PromotionEvidence;
  /**
   * Operations this gate authorizes, if any.
   *
   * Contract §13.4: "Uploading and making public SHOULD be separate operations." Naming the
   * operations a gate grants is how that separation is expressed — an approval on one gate
   * authorizes exactly the operations it names and nothing else, so a single decision cannot
   * quietly cover both upload and publication.
   */
  grants?: readonly string[];
}

/** A definition with every default resolved. */
export interface ResolvedGateDefinition extends GateDefinition {
  dependsOn: readonly string[];
  permittedActorKinds: readonly ActorKind[];
  expiresOnChange: boolean;
  grants: readonly string[];
}

/** Actor kinds a gate accepts when the definition does not say. */
function defaultPermittedActorKinds(level: GateLevel): readonly ActorKind[] {
  // §12 level 4 is "human oracle — owns subjective judgment or asymmetric-risk decisions", and
  // §13.3 keeps final performance approval human-owned. Defaulting these to any actor would let
  // an agent satisfy the one gate the contract most insists a person owns.
  return level === "human_oracle" ? ["human"] : ["human", "agent", "worker", "system"];
}

/**
 * Resolve defaults and refuse an internally inconsistent definition.
 *
 * @throws {AldusError} `ALDUS_GATE_DEFINITION_INVALID`
 */
export function validateGateDefinition(definition: GateDefinition): ResolvedGateDefinition {
  const fail = (message: string, details: Record<string, unknown> = {}): never => {
    throw gateEngineError(GateEngineErrorCodes.GATE_DEFINITION_INVALID, message, {
      category: "validation",
      details: { gateId: definition.gateId, ...details },
    });
  };

  if (definition.gateId.trim().length === 0) fail("A gate definition needs a non-empty gateId.");

  if (definition.binds.length === 0) {
    // A gate binding nothing cannot be invalidated by anything, which makes its approval
    // permanent — the precise failure §13.1 and §13.2 exist to prevent.
    fail(
      "A gate must bind at least one subject. A gate that binds nothing can never be " +
        "invalidated by a change, so its approval would outlive the content it approved " +
        "(contract §13.1, §13.2).",
    );
  }

  const duplicates = definition.binds.filter(
    (key, index) => definition.binds.indexOf(key) !== index,
  );
  if (duplicates.length > 0) {
    fail(`A gate cannot bind the same subject twice: ${[...new Set(duplicates)].join(", ")}.`, {
      duplicates: [...new Set(duplicates)],
    });
  }

  if (definition.dependsOn?.includes(definition.gateId) === true) {
    fail("A gate cannot depend on itself.");
  }

  if (definition.level === "model_assisted" && definition.enforcement === "blocking") {
    if (definition.promotionEvidence === undefined) {
      fail(
        "A model-assisted gate may only block once it has been calibrated against human-labeled " +
          "examples (contract §12.1). Set `promotionEvidence`, or leave the gate advisory. " +
          "Contract §12 forbids presenting a machine pass as semantic correctness.",
        { level: definition.level, enforcement: definition.enforcement },
      );
    }
  }

  const permittedActorKinds =
    definition.permittedActorKinds ?? defaultPermittedActorKinds(definition.level);
  if (permittedActorKinds.length === 0) {
    fail("A gate that permits no actor kind can never be decided.");
  }
  if (definition.level === "human_oracle" && !permittedActorKinds.includes("human")) {
    fail("A human-oracle gate must permit a human actor (contract §12 level 4, §13.3).", {
      permittedActorKinds: [...permittedActorKinds],
    });
  }

  return {
    ...definition,
    dependsOn: definition.dependsOn ?? [],
    permittedActorKinds,
    expiresOnChange: definition.expiresOnChange ?? true,
    grants: definition.grants ?? [],
  };
}

/**
 * A validated set of gates and the dependency graph between them.
 *
 * Built once and reused: cycle detection and unknown-dependency checks run at construction, so a
 * misconfiguration surfaces when the registry is assembled rather than when an operator is
 * waiting on an approval.
 */
export class GateRegistry {
  readonly #gates: Map<string, ResolvedGateDefinition>;

  private constructor(gates: Map<string, ResolvedGateDefinition>) {
    this.#gates = gates;
  }

  /**
   * Validate a set of definitions and the graph they form.
   *
   * @throws {AldusError} `ALDUS_GATE_DEFINITION_INVALID` for an invalid or duplicate definition,
   * or an edge naming a gate that does not exist.
   * @throws {AldusError} `ALDUS_GATE_DEPENDENCY_CYCLE` if the dependency edges form a cycle.
   */
  static from(definitions: readonly GateDefinition[]): GateRegistry {
    const gates = new Map<string, ResolvedGateDefinition>();
    for (const definition of definitions) {
      const resolved = validateGateDefinition(definition);
      if (gates.has(resolved.gateId)) {
        throw gateEngineError(
          GateEngineErrorCodes.GATE_DEFINITION_INVALID,
          `Gate "${resolved.gateId}" is defined more than once.`,
          { category: "validation", details: { gateId: resolved.gateId } },
        );
      }
      gates.set(resolved.gateId, resolved);
    }

    for (const gate of gates.values()) {
      for (const dependency of gate.dependsOn) {
        if (!gates.has(dependency)) {
          throw gateEngineError(
            GateEngineErrorCodes.GATE_DEFINITION_INVALID,
            `Gate "${gate.gateId}" depends on "${dependency}", which is not defined. An edge to ` +
              "a missing gate would silently drop out of the invalidation cascade (§13.1).",
            { category: "validation", details: { gateId: gate.gateId, dependency } },
          );
        }
      }
    }

    const cycle = findCycle(gates);
    if (cycle !== undefined) {
      throw gateEngineError(
        GateEngineErrorCodes.GATE_DEPENDENCY_CYCLE,
        `Gate dependencies form a cycle: ${cycle.join(" → ")}. Contract §13.1's cascade is only ` +
          'meaningful over an acyclic graph; with a cycle, "what does this invalidate" has no answer.',
        { category: "validation", details: { cycle } },
      );
    }

    return new GateRegistry(gates);
  }

  /** Every gate, in definition order. */
  list(): ResolvedGateDefinition[] {
    return [...this.#gates.values()];
  }

  /** True if the gate is registered. */
  has(gateId: string): boolean {
    return this.#gates.has(gateId);
  }

  /** A gate definition, or `undefined` if it is not registered. */
  get(gateId: string): ResolvedGateDefinition | undefined {
    return this.#gates.get(gateId);
  }

  /**
   * A gate definition.
   *
   * @throws {AldusError} `ALDUS_GATE_NOT_FOUND`
   */
  require(gateId: string): ResolvedGateDefinition {
    const gate = this.#gates.get(gateId);
    if (gate === undefined) {
      throw gateEngineError(
        GateEngineErrorCodes.GATE_NOT_FOUND,
        `Gate "${gateId}" is not registered.`,
        { category: "not_found", details: { gateId } },
      );
    }
    return gate;
  }

  /** Gates that directly depend on `gateId`. */
  dependentsOf(gateId: string): ResolvedGateDefinition[] {
    return this.list().filter((gate) => gate.dependsOn.includes(gateId));
  }

  /**
   * Gates that transitively depend on `gateId`, nearest first, excluding `gateId` itself.
   *
   * This is the reach of contract §13.1's cascade: invalidating a Content Freeze invalidates
   * every approval downstream of it.
   */
  downstreamOf(gateId: string): string[] {
    const seen = new Set<string>();
    const ordered: string[] = [];
    let frontier = [gateId];
    while (frontier.length > 0) {
      const next: string[] = [];
      for (const current of frontier) {
        for (const dependent of this.dependentsOf(current)) {
          if (seen.has(dependent.gateId)) continue;
          seen.add(dependent.gateId);
          ordered.push(dependent.gateId);
          next.push(dependent.gateId);
        }
      }
      frontier = next;
    }
    return ordered;
  }
}

/** Depth-first cycle search, returning the offending path if there is one. */
function findCycle(gates: ReadonlyMap<string, ResolvedGateDefinition>): string[] | undefined {
  const visiting = new Set<string>();
  const done = new Set<string>();
  const path: string[] = [];

  const walk = (gateId: string): string[] | undefined => {
    if (done.has(gateId)) return undefined;
    if (visiting.has(gateId)) return [...path.slice(path.indexOf(gateId)), gateId];
    visiting.add(gateId);
    path.push(gateId);
    for (const dependency of gates.get(gateId)?.dependsOn ?? []) {
      const found = walk(dependency);
      if (found !== undefined) return found;
    }
    path.pop();
    visiting.delete(gateId);
    done.add(gateId);
    return undefined;
  };

  for (const gateId of gates.keys()) {
    const found = walk(gateId);
    if (found !== undefined) return found;
  }
  return undefined;
}
