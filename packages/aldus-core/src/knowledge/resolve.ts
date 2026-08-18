/**
 * Pack resolution, conflict detection, and Run snapshots (architecture contract §9.2, §9.3,
 * §6.2).
 *
 * The load-bearing requirement is §9.2: "Conflicts MUST be detectable. Silent last-write-wins
 * behavior SHOULD be avoided for normative rules." So resolution returns a *report* — winners,
 * conflicts, and integrity problems — rather than a merged blob. A resolver that silently
 * produced one answer would satisfy the letter of "resolve precedence" while defeating its
 * purpose.
 *
 * Core indexes knowledge; it does not interpret it (§1.2 non-goal). Conflicts are therefore
 * detected between *declared claims* (`KnowledgePackManifest.provides`), never by reading the
 * Markdown behind them.
 */

import type { KnowledgePackRef, PackAuthority } from "../schema/common.js";
import { KnowledgeErrorCodes } from "./errors.js";
import type { KnowledgePackManifest } from "./manifest.js";
import {
  comparePackStrength,
  DEFAULT_PRECEDENCE_LADDER,
  effectivePrecedence,
  isResolvable,
  packApplies,
  placeOnLadder,
  type PrecedenceTier,
} from "./precedence.js";

/** Resolves whether a declared resource path exists. */
export type ResourceResolver = (packId: string, path: string) => boolean;

/** A pack as placed by the ladder, with its effective precedence. */
export interface PlacedPack {
  /** The pack's manifest. */
  manifest: KnowledgePackManifest;
  /** Effective precedence; higher is stronger. */
  precedence: number;
  /** Ladder tier the pack was placed in. */
  tierName: string;
  /** Whether the pack applies in the resolution context. */
  applies: boolean;
  /** Scope dimensions the ladder had no rung for (contract §9.2). */
  unknownDimensions: readonly string[];
}

/** One claim key and the pack that holds it after resolution. */
export interface ResolvedClaim {
  /** The claim key, opaque to Core. */
  key: string;
  /** Pack that holds the key. */
  packId: string;
  /** Effective precedence of the holder. */
  precedence: number;
  /** Authority of the holder. */
  authority: PackAuthority;
  /** Packs that claimed the key but lost, strongest first. */
  overridden: readonly string[];
}

/**
 * Two or more `normative` packs claiming one key at the same effective precedence.
 *
 * Contract §9.2 makes this an error to report, not a merge to perform.
 */
export interface PackConflict {
  /** Always `ALDUS_KNOWLEDGE_PACK_CONFLICT`. */
  code: typeof KnowledgeErrorCodes.PACK_CONFLICT;
  /** The contested claim key. */
  key: string;
  /** Effective precedence at which the tie occurred. */
  precedence: number;
  /** Packs tied for the key, sorted so the report is deterministic. */
  packIds: readonly string[];
  /** Operator-facing explanation. */
  message: string;
}

/** A structural problem with the supplied pack set, independent of any one claim. */
export interface PackIntegrityIssue {
  /** Which class of problem. */
  code:
    | typeof KnowledgeErrorCodes.PACK_DUPLICATE
    | typeof KnowledgeErrorCodes.DEPENDENCY_MISSING
    | typeof KnowledgeErrorCodes.DEPENDENCY_CYCLE
    | typeof KnowledgeErrorCodes.RESOURCE_MISSING;
  /** Packs involved. */
  packIds: readonly string[];
  /** Operator-facing explanation. */
  message: string;
  /** Resource path, present only for `RESOURCE_MISSING`. */
  path?: string;
}

/** Options for {@link resolveKnowledgePacks}. */
export interface ResolveOptions {
  /**
   * Resolution context: the scope dimensions in force.
   *
   * Caller-supplied keys, e.g. `{ show: "example-show", host: "example-host" }`. Core defines
   * no dimension names (contract §4.2).
   */
  context?: Readonly<Record<string, string>>;
  /** Precedence ladder. Defaults to {@link DEFAULT_PRECEDENCE_LADDER}. */
  ladder?: readonly PrecedenceTier[];
  /**
   * Existence check for declared resource paths.
   *
   * Optional and injected. Core performs no filesystem access here: contract §7 keeps core
   * models independent of physical storage, and packs may live in a working tree, a Git object
   * store, or an archive. Omit it and resource paths are recorded without being checked.
   */
  resourceExists?: ResourceResolver;
}

/** The outcome of resolving a set of packs (contract §9.2). */
export interface PackResolution {
  /** Every supplied pack, placed and marked with whether it applies. Strongest first. */
  packs: readonly PlacedPack[];
  /** Packs that apply and participate in resolution, strongest first. */
  applicable: readonly PlacedPack[];
  /** Claim keys and their holders, ordered by key. */
  claims: readonly ResolvedClaim[];
  /** Normative ties (contract §9.2). Empty means resolution is unambiguous. */
  conflicts: readonly PackConflict[];
  /** Structural problems with the pack set. */
  issues: readonly PackIntegrityIssue[];
  /** Scope dimensions the ladder did not recognise, across all supplied packs. */
  unknownDimensions: readonly string[];
}

/** Detect two manifests declaring the same `packId`. */
function findDuplicates(manifests: readonly KnowledgePackManifest[]): PackIntegrityIssue[] {
  const counts = new Map<string, number>();
  for (const manifest of manifests) {
    counts.set(manifest.packId, (counts.get(manifest.packId) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([packId, count]) => ({
      code: KnowledgeErrorCodes.PACK_DUPLICATE,
      packIds: [packId],
      message: `Pack "${packId}" was supplied ${count} times; pack identity must be unique.`,
    }));
}

/**
 * Find the dependency cycles reachable in a pack set.
 *
 * Iterative depth-first search with an explicit stack rather than recursion: the input is
 * authored data, and a deeply nested or malformed pack set should not be able to decide how
 * deep the call stack goes.
 */
function findCycles(byId: ReadonlyMap<string, KnowledgePackManifest>): string[][] {
  const cycles: string[][] = [];
  const reported = new Set<string>();
  // Tri-colour marking: absent = unvisited, "open" = on the current path, "done" = fully
  // explored. Marking "done" is what stops a shared dependency from being re-walked once per
  // path through it, which on a dense graph is the difference between linear and exponential.
  const state = new Map<string, "open" | "done">();

  // Roots are walked in sorted order so the reported cycles are deterministic.
  for (const root of [...byId.keys()].sort()) {
    if (state.get(root) === "done") continue;

    const path: string[] = [];
    const stack: Array<{ packId: string; dependencies: readonly string[]; next: number }> = [];

    const open = (packId: string): void => {
      state.set(packId, "open");
      path.push(packId);
      stack.push({
        packId,
        dependencies: (byId.get(packId)?.dependencies ?? [])
          .map((dependency) => dependency.packId)
          .filter((id) => byId.has(id)),
        next: 0,
      });
    };

    open(root);

    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (frame === undefined) break;

      if (frame.next >= frame.dependencies.length) {
        state.set(frame.packId, "done");
        path.pop();
        stack.pop();
        continue;
      }

      const dependency = frame.dependencies[frame.next];
      frame.next += 1;
      if (dependency === undefined) continue;

      const dependencyState = state.get(dependency);
      if (dependencyState === "done") continue;

      if (dependencyState === "open") {
        // A back edge to a node still on the path. The path from that node onwards is the cycle.
        const start = path.indexOf(dependency);
        const cycle = start === -1 ? [dependency] : path.slice(start);
        const signature = [...cycle].sort().join("|");
        if (!reported.has(signature)) {
          reported.add(signature);
          cycles.push(cycle);
        }
        continue;
      }

      open(dependency);
    }
  }

  return cycles;
}

/** Detect missing dependencies and dependency cycles (contract §9.1). */
function findDependencyIssues(manifests: readonly KnowledgePackManifest[]): PackIntegrityIssue[] {
  const byId = new Map(manifests.map((manifest) => [manifest.packId, manifest]));
  const issues: PackIntegrityIssue[] = [];

  for (const manifest of manifests) {
    for (const dependency of manifest.dependencies ?? []) {
      if (byId.has(dependency.packId)) continue;
      issues.push({
        code: KnowledgeErrorCodes.DEPENDENCY_MISSING,
        packIds: [manifest.packId, dependency.packId],
        message:
          `Pack "${manifest.packId}" depends on "${dependency.packId}", ` +
          "which was not supplied.",
      });
    }
  }

  for (const cycle of findCycles(byId)) {
    issues.push({
      code: KnowledgeErrorCodes.DEPENDENCY_CYCLE,
      packIds: cycle,
      message:
        "Pack dependencies form a cycle, so no consistent load order exists: " +
        `${[...cycle, cycle[0] ?? ""].join(" then ")}.`,
    });
  }

  return issues;
}

/** Check declared resource paths against an injected resolver. */
function findResourceIssues(
  manifests: readonly KnowledgePackManifest[],
  resourceExists: ResourceResolver,
): PackIntegrityIssue[] {
  const issues: PackIntegrityIssue[] = [];
  for (const manifest of manifests) {
    const declared = [
      ...(manifest.includes ?? []),
      ...(manifest.tests ?? []),
      ...(manifest.negativeKnowledge ?? []),
    ];
    for (const path of declared) {
      if (resourceExists(manifest.packId, path)) continue;
      issues.push({
        code: KnowledgeErrorCodes.RESOURCE_MISSING,
        packIds: [manifest.packId],
        path,
        message: `Pack "${manifest.packId}" declares resource "${path}", which could not be found.`,
      });
    }
  }
  return issues;
}

/**
 * Resolve a set of Knowledge Packs against a context (contract §9.2).
 *
 * Returns a report rather than a merged result: the winner of each claim, the normative ties
 * §9.2 requires to be detectable, and structural problems with the set. Nothing is thrown — an
 * ambiguous pack set is an operational condition an operator acts on, not an exception.
 */
export function resolveKnowledgePacks(
  manifests: readonly KnowledgePackManifest[],
  options: ResolveOptions = {},
): PackResolution {
  const ladder = options.ladder ?? DEFAULT_PRECEDENCE_LADDER;
  const context = options.context ?? {};

  const placed: PlacedPack[] = manifests.map((manifest) => {
    const placement = placeOnLadder(manifest, ladder);
    return {
      manifest,
      precedence: effectivePrecedence(manifest, ladder),
      tierName: placement.tierName,
      applies: packApplies(manifest, context),
      unknownDimensions: placement.unknownDimensions,
    };
  });
  placed.sort(comparePackStrength);

  // Deprecated packs stay in `packs` so contract §9.3 negative knowledge remains discoverable,
  // but they never hold a claim — see `isResolvable`.
  const applicable = placed.filter((pack) => pack.applies && isResolvable(pack.manifest));

  const claimants = new Map<string, PlacedPack[]>();
  for (const pack of applicable) {
    for (const key of pack.manifest.provides ?? []) {
      const existing = claimants.get(key);
      if (existing === undefined) claimants.set(key, [pack]);
      else existing.push(pack);
    }
  }

  const claims: ResolvedClaim[] = [];
  const conflicts: PackConflict[] = [];

  for (const [key, contenders] of [...claimants.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const ordered = [...contenders].sort(comparePackStrength);
    const winner = ordered[0];
    if (winner === undefined) continue;

    // A tie matters only at the top. Two normative packs tied *below* an outright winner are
    // resolved unambiguously and are not a conflict.
    const normativeTie = ordered.filter(
      (pack) =>
        pack.manifest.authority === "normative" &&
        winner.manifest.authority === "normative" &&
        pack.precedence === winner.precedence,
    );

    if (normativeTie.length > 1) {
      const packIds = normativeTie.map((pack) => pack.manifest.packId).sort();
      conflicts.push({
        code: KnowledgeErrorCodes.PACK_CONFLICT,
        key,
        precedence: winner.precedence,
        packIds,
        message:
          `Claim "${key}" is asserted by ${packIds.length} normative packs at the same effective ` +
          `precedence (${winner.precedence}): ${packIds.join(", ")}. Architecture contract §9.2 ` +
          "requires this to be reported rather than resolved by last-write-wins.",
      });
    }

    claims.push({
      key,
      packId: winner.manifest.packId,
      precedence: winner.precedence,
      authority: winner.manifest.authority,
      overridden: ordered.slice(1).map((pack) => pack.manifest.packId),
    });
  }

  const issues: PackIntegrityIssue[] = [
    ...findDuplicates(manifests),
    ...findDependencyIssues(manifests),
    ...(options.resourceExists === undefined
      ? []
      : findResourceIssues(manifests, options.resourceExists)),
  ];

  const unknownDimensions = [
    ...new Set(placed.flatMap((pack) => [...pack.unknownDimensions])),
  ].sort();

  return { packs: placed, applicable, claims, conflicts, issues, unknownDimensions };
}

/** True if a resolution is safe to act on: no normative ties and no structural problems. */
export function isResolutionClean(resolution: PackResolution): boolean {
  return resolution.conflicts.length === 0 && resolution.issues.length === 0;
}

/**
 * Snapshot the applicable packs as `KnowledgePackRef[]` for `RunManifest.knowledgePacks`
 * (contract §6.2, §22 WP-09 "pack snapshot in Run Manifest").
 *
 * The snapshot is self-sufficient by design. Contract §20 requires a completed Run to stay
 * explicable after its packs are revised, so the *effective* precedence is written out rather
 * than left to be recomputed from a ladder that may since have changed, and `contentHash` is
 * carried through wherever the manifest supplies one.
 *
 * Order is the resolution order — strongest first — and deterministic, because a Run manifest
 * is compared and hashed.
 */
export function toKnowledgePackRefs(resolution: PackResolution): KnowledgePackRef[] {
  return resolution.applicable.map((pack) => {
    const { manifest } = pack;
    const ref: KnowledgePackRef = {
      packId: manifest.packId,
      version: manifest.version,
      authority: manifest.authority,
      precedence: pack.precedence,
    };
    if (manifest.scope !== undefined) ref.scope = manifest.scope;
    if (manifest.sourceRevision !== undefined) ref.sourceRevision = manifest.sourceRevision;
    if (manifest.contentHash !== undefined) ref.contentHash = manifest.contentHash;
    return ref;
  });
}
