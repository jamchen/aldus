/**
 * Error codes raised by the Knowledge Pack loader.
 *
 * Defined here rather than in `../errors.js` deliberately: Core keeps no central code registry,
 * precisely so a module — or an adopter integration — can report a new failure without forking
 * the error taxonomy. See the note on `CoreErrorCodes`.
 */

/** @see AldusError */
export const KnowledgeErrorCodes = {
  /** A manifest source could not be decoded into a document at all. */
  MANIFEST_UNPARSEABLE: "ALDUS_KNOWLEDGE_MANIFEST_UNPARSEABLE",
  /** A manifest decoded but failed schema validation. */
  MANIFEST_INVALID: "ALDUS_KNOWLEDGE_MANIFEST_INVALID",
  /** Two manifests declared the same `packId`. */
  PACK_DUPLICATE: "ALDUS_KNOWLEDGE_PACK_DUPLICATE",
  /**
   * Two `normative` packs claim the same key at the same effective precedence (contract §9.2).
   *
   * Reported rather than silently resolved: §9.2 requires conflicts to be detectable and says
   * silent last-write-wins SHOULD be avoided for normative rules.
   */
  PACK_CONFLICT: "ALDUS_KNOWLEDGE_PACK_CONFLICT",
  /** A pack depends on a pack that was not supplied. */
  DEPENDENCY_MISSING: "ALDUS_KNOWLEDGE_DEPENDENCY_MISSING",
  /** Pack dependencies form a cycle, so no consistent load order exists. */
  DEPENDENCY_CYCLE: "ALDUS_KNOWLEDGE_DEPENDENCY_CYCLE",
  /** A declared resource path could not be found by the supplied resolver. */
  RESOURCE_MISSING: "ALDUS_KNOWLEDGE_RESOURCE_MISSING",
} as const;

/** @see KnowledgeErrorCodes */
export type KnowledgeErrorCode = (typeof KnowledgeErrorCodes)[keyof typeof KnowledgeErrorCodes];
