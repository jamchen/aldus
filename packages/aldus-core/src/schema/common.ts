/**
 * Shared schema primitives and embedded value objects.
 *
 * Constraints live here rather than being re-declared per record, so that (for example) every
 * hash field in the system agrees on what a hash looks like. A constraint that drifts between
 * two records is a lineage bug waiting to happen (architecture contract §8.1).
 *
 * Zod is the single source of truth; TypeScript types are inferred (ADR-0002).
 */

import { z } from "zod";

/* -------------------------------------------------------------------------------------------
 * Scalar primitives
 * ---------------------------------------------------------------------------------------- */

/** A required, non-empty identifier or label. */
export const nonEmptyString = z.string().min(1).max(1024);

/** Free-form human text, e.g. a review comment (contract §13 `GateDecision.comment`). */
export const humanText = z.string().max(8000);

/**
 * A URI. Deliberately not constrained to a scheme allowlist: contract §7 requires Core models
 * to be independent of physical storage, so `file:`, `s`-prefixed object stores, and adapters
 * that do not exist yet must all be expressible without changing Core.
 */
export const uriString = z.string().min(1).max(4096);

/**
 * ISO-8601 timestamp with an explicit offset.
 *
 * The offset is required, not optional: contract §20 requires the production trace to answer
 * "what happened" and "when", and a local time without an offset is not comparable across the
 * machines and sessions that contract §5.1 expects to be involved.
 */
export const iso8601 = z.iso.datetime({ offset: true });

/**
 * A SHA-256 digest, lowercase hexadecimal.
 *
 * Lowercase-only is deliberate. Contract §8.1 makes hashes load-bearing identity ("approved
 * artifacts MUST be addressed by ID and hash"), and hash comparison is string equality
 * everywhere it matters. Accepting mixed case would make two spellings of the same digest
 * compare unequal.
 */
export const sha256Hex = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "Must be a lowercase hexadecimal SHA-256 digest (64 characters).");

/**
 * A `MAJOR.MINOR` schema version string (ADR-0003).
 *
 * Intentionally NOT pinned to the literal current version: a schema that accepts only its own
 * version could never read a forward-compatible record, which is precisely the case ADR-0003
 * exists to support.
 */
export const schemaVersionString = z
  .string()
  .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)$/, 'Must be a "MAJOR.MINOR" schema version.');

/**
 * A monetary amount as a decimal **string**.
 *
 * Not a number. Contract §15 requires per-request cost capture and §19.3 requires stop-on-budget
 * behaviour; synthesis costs are fractional-cent, and accumulating them in IEEE-754 doubles
 * corrupts totals silently — the worst failure mode for a value an operator authorises against.
 * Arithmetic is the caller's responsibility, using a decimal library of its choosing.
 */
export const decimalAmount = z
  .string()
  .regex(/^-?(0|[1-9]\d*)(\.\d+)?$/, 'Must be a decimal amount string, e.g. "0.0142".');

/** An ISO-4217 currency code. */
export const currencyCode = z
  .string()
  .regex(/^[A-Z]{3}$/, "Must be a three-letter uppercase ISO-4217 currency code.");

/* -------------------------------------------------------------------------------------------
 * ActorRef — contract §6.4, §19.2
 * ---------------------------------------------------------------------------------------- */

/**
 * What kind of party performed an action.
 *
 * Contract §19.2: "Mutating actions MUST record actor identity." Contract §3.4: an agent
 * session is never the authoritative record, so `agent` is a peer of `human`, not a substitute.
 */
export const ACTOR_KINDS = ["human", "agent", "worker", "system"] as const;

/** @see ACTOR_KINDS */
export type ActorKind = (typeof ACTOR_KINDS)[number];

/**
 * Who or what performed an action (contract §6.4 "actor and backend", §19.2).
 */
export const actorRefSchema = z
  .object({
    /** Whether a human, an agent, a deterministic worker, or the runtime itself acted. */
    kind: z.enum(ACTOR_KINDS),
    /** Stable identity within `kind`. Opaque to Core. */
    id: nonEmptyString,
    /** Human-readable label for display. Never used for identity comparison. */
    displayName: nonEmptyString.optional(),
    /**
     * Agent Backend identifier (contract §10).
     *
     * An open string, never a Core-defined enum: contract §10 requires the Runtime to support
     * interchangeable backends, so naming them here would make adding one a Core change.
     */
    backendId: nonEmptyString.optional(),
    /**
     * Reference to the agent session that acted (contract §10 `AgentSessionRef`).
     *
     * Recorded for traceability only. Contract §3.4 forbids treating session memory as
     * authoritative state, so nothing may be resolved *through* this reference.
     */
    sessionRef: nonEmptyString.optional(),
  })
  .meta({
    id: "ActorRef",
    title: "ActorRef",
    description:
      "Identity of the party that performed an action (architecture contract §6.4, §19.2). " +
      "Every mutating action records one. `backendId` and `sessionRef` are traceability " +
      "metadata; contract §3.4 forbids treating an agent session as authoritative state.",
  });

/** @see actorRefSchema */
export type ActorRef = z.infer<typeof actorRefSchema>;

/* -------------------------------------------------------------------------------------------
 * KnowledgePackRef — contract §9.1, §6.2
 * ---------------------------------------------------------------------------------------- */

/**
 * How binding a Knowledge Pack's content is (contract §9.1).
 *
 * `normative` rules participate in conflict detection (§9.2); `advisory` and `example` do not
 * block; `deprecated` is retained so that contract §9.3 negative knowledge stays discoverable.
 */
export const PACK_AUTHORITIES = ["normative", "advisory", "example", "deprecated"] as const;

/** @see PACK_AUTHORITIES */
export type PackAuthority = (typeof PACK_AUTHORITIES)[number];

/**
 * A reference to a resolved Knowledge Pack, as snapshotted into a Run (contract §9.1, §6.2).
 *
 * This is a *reference only*. Manifest parsing, discovery, precedence resolution, and conflict
 * reporting are WP-09 and are deliberately absent here.
 */
export const knowledgePackRefSchema = z
  .object({
    /** Pack identity (contract §9.1 "identity and version"). */
    packId: nonEmptyString,
    /** Pack version as declared by its manifest. Opaque string; Core imposes no version scheme. */
    version: nonEmptyString,
    /** How binding the pack's content is. */
    authority: z.enum(PACK_AUTHORITIES),
    /**
     * Scope dimensions the pack applies to (contract §9.2).
     *
     * An open string map, not an enum. Contract §9.2 lists show, host, provider, voice, model,
     * and script form as the *default* precedence chain, and §15.2 adds language — the set is
     * expected to grow per adopter, so Core must not fix it.
     */
    scope: z.record(z.string().min(1).max(128), z.string().max(512)).optional(),
    /**
     * Precedence weight; lower is weaker (contract §9.2).
     *
     * Recorded so a Run snapshot is self-describing. Resolving precedence and detecting the
     * conflicts §9.2 requires is WP-09's job, not this reference's.
     */
    precedence: z.number().int().optional(),
    /** Source revision the pack was loaded from (contract §9.1 "source revision"). */
    sourceRevision: nonEmptyString.optional(),
    /**
     * Digest of the pack's resolved content.
     *
     * Makes a Run's pack snapshot verifiable after the fact, which is what contract §20
     * requires when answering "which packs were used".
     */
    contentHash: sha256Hex.optional(),
  })
  .meta({
    id: "KnowledgePackRef",
    title: "KnowledgePackRef",
    description:
      "A reference to a resolved Knowledge Pack, snapshotted into a Run (architecture contract " +
      "§9.1, §6.2). Reference only — discovery, manifest parsing, and precedence resolution are " +
      "out of scope for the core schema. `scope` is an open string map because the dimension " +
      "set (§9.2, §15.2) is adopter-extensible.",
  });

/** @see knowledgePackRefSchema */
export type KnowledgePackRef = z.infer<typeof knowledgePackRefSchema>;

/* -------------------------------------------------------------------------------------------
 * Money — contract §19.3
 * ---------------------------------------------------------------------------------------- */

/**
 * A monetary value (contract §19.3).
 *
 * `amount` is a decimal string; see {@link decimalAmount} for why it is not a number.
 */
export const moneySchema = z
  .object({
    /** Decimal amount as a string, e.g. `"0.0142"`. */
    amount: decimalAmount,
    /** ISO-4217 currency code, e.g. `"USD"`. */
    currency: currencyCode,
  })
  .meta({
    id: "Money",
    title: "Money",
    description:
      "A monetary value (architecture contract §19.3). `amount` is a decimal STRING, not a " +
      "number: costs are fractional-cent and IEEE-754 accumulation would silently corrupt the " +
      "totals an operator authorises spend against.",
  });

/** @see moneySchema */
export type Money = z.infer<typeof moneySchema>;
