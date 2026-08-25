/**
 * Knowledge Pack loading, precedence, and conflict reporting (architecture contract §9).
 *
 * Contract §4.1 lists "Knowledge Pack discovery and precedence" among what Aldus Core owns,
 * which is why this lives here rather than in an adopter integration. What Core owns is the
 * *indexing*: identity, scope, authority, precedence, declared claims, and declared resources.
 * What it deliberately does not own is the knowledge itself — §4.2 keeps show identities, host
 * personas, and private editorial rules outside Core, and §1.2 makes converting knowledge into
 * YAML or a database an explicit non-goal.
 *
 * Not implemented here: evaluator execution and the regression harness (WP-10), gate evaluation
 * (WP-05), and filesystem discovery — packs reach the resolver through a caller-supplied source,
 * because §7 keeps Core independent of physical storage.
 */

export { KnowledgeErrorCodes, type KnowledgeErrorCode } from "./errors.js";

export {
  knowledgePackManifestSchemaBase,
  packDependencySchema,
  packResourcePath,
  type KnowledgePackManifest,
  type PackDependency,
} from "./manifest.js";

export {
  normalizeManifestDocument,
  parseJsonManifestSource,
  parsePackManifest,
  parsePackManifestDocument,
  type ManifestSourceParser,
  type ParseManifestOptions,
} from "./parse.js";

export {
  authorityRank,
  comparePackStrength,
  DEFAULT_PRECEDENCE_LADDER,
  effectivePrecedence,
  isResolvable,
  packApplies,
  placeOnLadder,
  PRECEDENCE_TIER_STRIDE,
  type PrecedenceTier,
  type TierPlacement,
} from "./precedence.js";

export {
  isResolutionClean,
  resolveKnowledgePacks,
  toKnowledgePackRefs,
  type PackConflict,
  type PackIntegrityIssue,
  type PackResolution,
  type PlacedPack,
  type ResolvedClaim,
  type ResolveOptions,
  type ResourceResolver,
} from "./resolve.js";
