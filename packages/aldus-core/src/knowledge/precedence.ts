/**
 * Scope matching and precedence (architecture contract §9.2).
 *
 * §9.2 gives a default precedence chain:
 *
 * ```text
 * global → show → host → provider / voice / model / script form → episode override
 * ```
 *
 * Two things about that chain shape this module. First, its middle tier is generic in the
 * contract's own wording — "provider / voice / model / script form" is a list of examples, not
 * a closed set, and §15.2 adds language to it. Second, §4.2 forbids Core from naming a
 * provider. So the ladder is **configurable data**, not a hardcoded enumeration, and scope
 * dimensions are caller-supplied strings throughout.
 */

import type { PackAuthority } from "../schema/common.js";
import type { KnowledgePackManifest } from "./manifest.js";

/**
 * One rung of a precedence ladder: a named tier and the scope dimensions that place a pack in
 * it.
 */
export interface PrecedenceTier {
  /** Name of the tier, for diagnostics. */
  name: string;
  /** Scope dimensions that place a pack in this tier. Empty means the global tier. */
  dimensions: readonly string[];
}

/**
 * Distance between adjacent tiers in derived precedence values.
 *
 * A stride rather than 1 so an explicit `precedence` on a manifest can be slotted *between*
 * two tiers without renumbering the ladder.
 */
export const PRECEDENCE_TIER_STRIDE = 100;

/**
 * The default ladder, transcribed from contract §9.2.
 *
 * The `variant` tier carries §9.2's own examples plus `language` from §15.2. It is a **default**
 * an adopter replaces or extends, not a definition — that is the whole point of keeping the
 * ladder in data.
 */
export const DEFAULT_PRECEDENCE_LADDER: readonly PrecedenceTier[] = [
  { name: "global", dimensions: [] },
  { name: "show", dimensions: ["show"] },
  { name: "host", dimensions: ["host"] },
  { name: "variant", dimensions: ["provider", "voice", "model", "scriptForm", "language"] },
  { name: "episode", dimensions: ["episode"] },
];

/**
 * How binding each authority level is (contract §9.1).
 *
 * Higher wins. `deprecated` is absent because a deprecated pack does not participate in
 * resolution at all — see {@link isResolvable}.
 */
const AUTHORITY_RANK: Record<PackAuthority, number> = {
  normative: 3,
  advisory: 2,
  example: 1,
  deprecated: 0,
};

/** Rank of an authority level; higher is more binding (contract §9.1). */
export function authorityRank(authority: PackAuthority): number {
  return AUTHORITY_RANK[authority];
}

/**
 * Whether a pack participates in resolution.
 *
 * `deprecated` packs do not. Contract §9.3 wants known-superseded guidance to stay
 * *discoverable*, which is not the same as letting it win a claim — so a deprecated pack is
 * still returned by the resolver, just never as the holder of a key.
 */
export function isResolvable(manifest: KnowledgePackManifest): boolean {
  return manifest.authority !== "deprecated";
}

/** Where a pack sits in a ladder, and which of its dimensions the ladder did not recognise. */
export interface TierPlacement {
  /** Index of the matched tier. `0` is the global tier. */
  tierIndex: number;
  /** Name of the matched tier. */
  tierName: string;
  /** Scope dimensions the ladder has no rung for. */
  unknownDimensions: readonly string[];
}

/**
 * Place a pack on a ladder by the most specific dimension its scope declares.
 *
 * Dimensions the ladder does not know about do **not** change the tier. They are reported
 * instead, because guessing where an unrecognised dimension belongs would silently reorder
 * precedence — the exact failure §9.2 asks to be made detectable. A pack scoped only by an
 * unknown dimension still resolves; it simply sits at the global tier until the ladder is
 * extended.
 */
export function placeOnLadder(
  manifest: KnowledgePackManifest,
  ladder: readonly PrecedenceTier[] = DEFAULT_PRECEDENCE_LADDER,
): TierPlacement {
  const scopeKeys = Object.keys(manifest.scope ?? {});
  const known = new Set(ladder.flatMap((tier) => [...tier.dimensions]));

  let tierIndex = 0;
  for (const [index, tier] of ladder.entries()) {
    if (tier.dimensions.some((dimension) => scopeKeys.includes(dimension))) tierIndex = index;
  }

  const fallbackTier = ladder[0];
  return {
    tierIndex,
    tierName: ladder[tierIndex]?.name ?? fallbackTier?.name ?? "global",
    unknownDimensions: scopeKeys.filter((key) => !known.has(key)),
  };
}

/**
 * Effective precedence of a pack; higher is stronger.
 *
 * An explicit `precedence` on the manifest overrides the tier-derived value, which is how an
 * adopter expresses an ordering the ladder cannot (contract §9.2).
 */
export function effectivePrecedence(
  manifest: KnowledgePackManifest,
  ladder: readonly PrecedenceTier[] = DEFAULT_PRECEDENCE_LADDER,
): number {
  return manifest.precedence ?? placeOnLadder(manifest, ladder).tierIndex * PRECEDENCE_TIER_STRIDE;
}

/**
 * Whether a pack applies in a resolution context (contract §9.2).
 *
 * A pack applies when every dimension it declares matches the context exactly. A pack with no
 * scope is global and always applies. A pack scoped to a dimension the context does not supply
 * does not apply — an episode-scoped pack is irrelevant when no episode is being resolved.
 */
export function packApplies(
  manifest: KnowledgePackManifest,
  context: Readonly<Record<string, string>>,
): boolean {
  const scope = manifest.scope;
  if (scope === undefined) return true;
  return Object.entries(scope).every(([dimension, value]) => context[dimension] === value);
}

/**
 * Deterministic ordering: strongest first.
 *
 * Authority is the primary key and precedence only the tiebreaker within it. That ordering is a
 * decision, recorded in ADR-0006: "authority" means how binding a pack's content is, so an
 * `example` pack scoped to an episode must not override a `normative` global rule simply by
 * sitting on a higher rung. Precedence orders packs of equal bindingness by scope specificity,
 * which is what §9.2's chain describes.
 *
 * `packId` breaks remaining ties so the order is stable — a Run's pack snapshot is compared and
 * hashed, and an unstable order would make identical resolutions look different.
 */
export function comparePackStrength(
  a: { manifest: KnowledgePackManifest; precedence: number },
  b: { manifest: KnowledgePackManifest; precedence: number },
): number {
  const rank = authorityRank(b.manifest.authority) - authorityRank(a.manifest.authority);
  if (rank !== 0) return rank;
  if (b.precedence !== a.precedence) return b.precedence - a.precedence;
  return a.manifest.packId.localeCompare(b.manifest.packId);
}
