/**
 * Knowledge Pack manifest (architecture contract §9.1).
 *
 * §9.1 states that knowledge MAY remain Markdown, fixtures, scripts, examples, and tests, and
 * that "a lightweight manifest SHOULD index it". This is that manifest. It records *where*
 * knowledge lives and *how binding* it is; it does not model the knowledge itself. Contract
 * §1.2 lists "convert all production knowledge into YAML or a database" as an explicit
 * non-goal, so `includes`, `tests`, and `negativeKnowledge` are resource paths that Core
 * records and never parses.
 *
 * Zod is the single source of truth; TypeScript types are inferred (ADR-0002).
 */

import { z } from "zod";

import {
  nonEmptyString,
  PACK_AUTHORITIES,
  schemaVersionString,
  sha256Hex,
} from "../schema/common.js";

/**
 * A path to a resource the pack includes.
 *
 * Recorded and resolved, never parsed. Contract §9.1 keeps knowledge in its authored form, so
 * Core's job is to index a path, not to interpret what is behind it.
 */
export const packResourcePath = z.string().min(1).max(1024);

/**
 * A dependency on another pack (contract §9.1 "dependencies").
 */
export const packDependencySchema = z
  .object({
    /** Identity of the pack depended on. */
    packId: nonEmptyString,
    /**
     * Version constraint, if any.
     *
     * An OPEN string, never a parsed range. Contract §9.1 imposes no version scheme on packs —
     * its own example uses a bare `1` — so Core records the constraint and leaves its
     * interpretation to whoever authored the scheme. Do not narrow this to a semver range.
     */
    version: nonEmptyString.optional(),
  })
  .meta({
    id: "KnowledgePackDependency",
    title: "KnowledgePackDependency",
    description:
      "A dependency on another Knowledge Pack (architecture contract §9.1). `version` is an " +
      "open string because §9.1 imposes no version scheme on packs.",
  });

/** @see packDependencySchema */
export type PackDependency = z.infer<typeof packDependencySchema>;

/**
 * A Knowledge Pack manifest (contract §9.1).
 *
 * Field list implements §9.1's "every loaded pack SHOULD expose" list directly: identity and
 * version, scope, authority, dependencies, precedence, included resources, tests or fixtures,
 * and source revision. §9.3's negative knowledge gets a home of its own.
 */
export const knowledgePackManifestSchema = z
  .object({
    /** Schema version of this record (ADR-0003). */
    schemaVersion: schemaVersionString,
    /**
     * Pack identity (contract §9.1 `id`).
     *
     * Named `packId` rather than `id` to match `KnowledgePackRef.packId`, so a manifest and the
     * reference snapshotted from it agree field-for-field.
     */
    packId: nonEmptyString,
    /**
     * Pack version (contract §9.1 `version`).
     *
     * A string, and an opaque one: Core imposes no version scheme. §9.1's example writes a bare
     * `1`, which YAML and JSON both read as a number — {@link parsePackManifest} normalises
     * that to `"1"` so the contract's own example parses without the manifest being rewritten.
     */
    version: nonEmptyString,
    /** How binding the pack's content is (contract §9.1 "authority"). */
    authority: z.enum(PACK_AUTHORITIES),
    /** Human-readable summary. Never used for identity or resolution. */
    description: z.string().max(4000).optional(),
    /**
     * Scope dimensions the pack applies to (contract §9.2).
     *
     * An OPEN string map, never a Core-defined enum. §9.2's own precedence chain names
     * "provider / voice / model / script form" generically and §15.2 adds language, so the
     * dimension set is expected to grow per adopter. Contract §4.2 forbids Core from naming a
     * provider. Do not narrow this to a union.
     *
     * A pack applies when every dimension it declares matches the resolution context. A pack
     * with no scope is global and always applies.
     */
    scope: z.record(z.string().min(1).max(128), z.string().max(512)).optional(),
    /**
     * Explicit precedence weight; lower is weaker (contract §9.2).
     *
     * Optional because precedence is normally *derived* from scope specificity via the
     * precedence ladder. Setting it overrides the derived value, which is how an adopter
     * expresses an ordering the default ladder cannot.
     */
    precedence: z.number().int().optional(),
    /** Packs this one depends on (contract §9.1 "dependencies"). */
    dependencies: z.array(packDependencySchema).max(128).optional(),
    /**
     * Claim keys this pack asserts authority over.
     *
     * This is the mechanism that makes contract §9.2's requirement — "conflicts MUST be
     * detectable" — satisfiable without Core interpreting pack content. A pack *declares* what
     * it claims; Core compares declarations. Two `normative` packs claiming the same key at the
     * same effective precedence is the conflict §9.2 says must not silently last-write-win.
     *
     * Keys are opaque to Core. An adopter chooses their granularity.
     */
    provides: z.array(nonEmptyString).max(1024).optional(),
    /** Resources the pack includes (contract §9.1 `includes`). Indexed, never parsed. */
    includes: z.array(packResourcePath).max(1024).optional(),
    /** Tests or fixtures the pack ships (contract §9.1 `tests`). Indexed, never executed here. */
    tests: z.array(packResourcePath).max(1024).optional(),
    /**
     * Resources recording negative knowledge (contract §9.3).
     *
     * §9.3 makes known failed approaches, unsafe transformations, evaluator blind spots, and
     * provider limitations first-class pack content: "Learning does not mean storing only
     * successful examples." Giving them a declared home is what keeps them discoverable rather
     * than buried in prose. Core indexes the paths and does not interpret them.
     */
    negativeKnowledge: z.array(packResourcePath).max(1024).optional(),
    /** Source revision the manifest was authored at (contract §9.1 "source revision"). */
    sourceRevision: nonEmptyString.optional(),
    /**
     * Digest of the pack's resolved content.
     *
     * Optional, and computed by whatever assembled the pack rather than by Core. Carrying it
     * lets a Run's pack snapshot stay verifiable after the pack is revised, which is what
     * contract §20 requires when answering "which packs were used".
     */
    contentHash: sha256Hex.optional(),
  })
  .meta({
    id: "KnowledgePackManifest",
    title: "KnowledgePackManifest",
    description:
      "A Knowledge Pack manifest (architecture contract §9.1). Indexes knowledge that stays in " +
      "its authored form — Markdown, fixtures, scripts, examples — rather than requiring it to " +
      "be converted, which §1.2 lists as an explicit non-goal. `includes`, `tests`, and " +
      "`negativeKnowledge` are resource paths Core records and never parses. `scope` is an open " +
      "string map because §9.2's dimension set is adopter-extensible and §4.2 forbids Core from " +
      "naming a provider. `provides` declares the claim keys this pack asserts authority over, " +
      "which is what makes §9.2's conflict detection possible without Core interpreting pack " +
      "content. `negativeKnowledge` exists because §9.3 makes failed approaches and known " +
      "blind spots first-class content.",
  });

/** @see knowledgePackManifestSchema */
export type KnowledgePackManifest = z.infer<typeof knowledgePackManifestSchema>;
