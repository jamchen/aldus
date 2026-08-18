/**
 * Identifier generation and parsing.
 *
 * Two unrelated kinds of identity live here, and conflating them is a category error:
 *
 * 1. **Entity IDs** — `<prefix>_<ULID>`, minted by the runtime for runs, stage executions,
 *    attempts, artifacts, gates, decisions, cost records, and releases. They are opaque,
 *    time-ordered, and carry no meaning beyond "which record".
 * 2. **Canonical content identity** — architecture contract §6.1. Human-meaningful, stable
 *    across every run and every rewrite of the pipeline, and explicitly *not* a folder path
 *    (§6.1: an Episode "is not a folder and not an execution attempt").
 *
 * Contract §8.1 states that a path or filename MUST NOT be treated as identity. Both kinds of
 * identifier here are therefore defined independently of any filesystem layout.
 */

import { AldusError, CoreErrorCodes } from "./errors.js";

// ---------------------------------------------------------------------------------------------
// Section 1 — Entity IDs (`<prefix>_<ULID>`)
// ---------------------------------------------------------------------------------------------

/**
 * Crockford Base32 alphabet: digits plus uppercase letters excluding `I`, `L`, `O`, and `U`.
 *
 * The exclusions remove characters that are visually confusable when an operator reads an ID
 * out of a log or types one into a CLI (§18).
 */
export const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Length of the ULID component: 10 timestamp characters plus 16 randomness characters. */
export const ULID_LENGTH = 26;

/** Highest representable ULID timestamp — 48 bits of milliseconds since the Unix epoch. */
export const MAX_ULID_TIMESTAMP = 2 ** 48 - 1;

/** Highest representable ULID randomness value — 80 bits. */
const MAX_ULID_RANDOM = (1n << 80n) - 1n;

/** Number of random bytes consumed per ULID (80 bits). */
const ULID_RANDOM_BYTES = 10;

/**
 * Strict Crockford character class. `I`, `L`, `O`, and `U` are absent by construction, and
 * lowercase is rejected: decoding leniently would let an ID round-trip to a different string
 * than the one written, which silently forks artifact lineage (§8.1).
 */
const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

/** Reverse lookup for Crockford decoding. */
const CROCKFORD_DECODE: ReadonlyMap<string, number> = new Map(
  Array.from(CROCKFORD_ALPHABET, (character, index) => [character, index] as const),
);

/**
 * Entity ID prefixes, keyed by the domain concept they identify.
 *
 * The prefix makes a bare identifier self-describing in a log line or an error message, so an
 * operator inspecting production trace (§20) never has to guess what a dangling ID refers to.
 */
export const ID_PREFIXES = {
  /** `RunManifest.runId` (§6.2). */
  run: "run",
  /** `StageExecution` (§6.3). */
  stageExecution: "exec",
  /** `StageAttempt.attemptId` (§6.3). */
  stageAttempt: "att",
  /** `ArtifactRef.artifactId` (§8). */
  artifact: "art",
  /** A gate definition (§13). */
  gate: "gate",
  /** `GateDecision.decisionId` (§13). */
  gateDecision: "dec",
  /** `CostRecord.costId` (§19.3). */
  cost: "cost",
  /** `ReleaseReceipt.releaseId` (§17). */
  release: "rel",
} as const;

/** @see ID_PREFIXES */
export type IdPrefix = (typeof ID_PREFIXES)[keyof typeof ID_PREFIXES];

/** Every valid entity ID prefix, for validation and exhaustiveness checks. */
export const ID_PREFIX_VALUES: readonly IdPrefix[] = Object.values(ID_PREFIXES);

const ID_PREFIX_SET: ReadonlySet<string> = new Set<string>(ID_PREFIX_VALUES);

/** Decomposition of a well-formed entity ID. */
export interface ParsedId {
  /** The domain concept the ID identifies. */
  prefix: IdPrefix;
  /** The 26-character ULID component. */
  ulid: string;
  /** Milliseconds since the Unix epoch, decoded from the ULID's timestamp component. */
  timestamp: number;
}

/**
 * Injection points for deterministic ID generation.
 *
 * Tests freeze both so that generated IDs are reproducible; production uses the real clock and
 * the platform CSPRNG. Contract §3.4 makes durable state authoritative, and reproducible IDs
 * are what let a fixture assert against that state without matching on wildcards.
 */
export interface IdFactoryOptions {
  /** Milliseconds since the Unix epoch. Defaults to `Date.now`. */
  now?: () => number;
  /** Returns `n` cryptographically random bytes. Defaults to `crypto.getRandomValues`. */
  randomBytes?: (n: number) => Uint8Array;
}

/** Mints entity IDs, preserving creation order within a single process. */
export interface IdFactory {
  /** Mint an ID with an explicit prefix. */
  newId(prefix: IdPrefix): string;
  /** Mint a `RunManifest.runId` (§6.2). */
  newRunId(): string;
  /** Mint a `StageExecution` ID (§6.3). */
  newStageExecutionId(): string;
  /** Mint a `StageAttempt.attemptId` (§6.3). */
  newStageAttemptId(): string;
  /** Mint an `ArtifactRef.artifactId` (§8). */
  newArtifactId(): string;
  /** Mint a gate ID (§13). */
  newGateId(): string;
  /** Mint a `GateDecision.decisionId` (§13). */
  newGateDecisionId(): string;
  /** Mint a `CostRecord.costId` (§19.3). */
  newCostId(): string;
  /** Mint a `ReleaseReceipt.releaseId` (§17). */
  newReleaseId(): string;
  /** Mint a bare ULID with no prefix. Exposed for callers that need the raw time-ordered token. */
  newUlid(): string;
}

function defaultRandomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

/** Encode a 48-bit millisecond timestamp as 10 Crockford Base32 characters. */
function encodeUlidTime(timestamp: number): string {
  if (!Number.isInteger(timestamp) || timestamp < 0 || timestamp > MAX_ULID_TIMESTAMP) {
    throw new AldusError(
      CoreErrorCodes.ID_INVALID,
      `ULID timestamp must be an integer in [0, ${MAX_ULID_TIMESTAMP}]; received ${timestamp}.`,
      { category: "internal", details: { timestamp } },
    );
  }
  let remaining = timestamp;
  let encoded = "";
  for (let index = 0; index < 10; index += 1) {
    encoded = CROCKFORD_ALPHABET.charAt(remaining % 32) + encoded;
    remaining = Math.floor(remaining / 32);
  }
  return encoded;
}

/** Encode 80 bits of randomness as 16 Crockford Base32 characters. */
function encodeUlidRandom(random: bigint): string {
  let remaining = random;
  let encoded = "";
  for (let index = 0; index < 16; index += 1) {
    encoded = CROCKFORD_ALPHABET.charAt(Number(remaining & 31n)) + encoded;
    remaining >>= 5n;
  }
  return encoded;
}

function bytesToRandom(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }
  return value & MAX_ULID_RANDOM;
}

/**
 * Create an ID factory.
 *
 * IDs minted by one factory are strictly increasing in lexicographic order, which makes an
 * append-only log (§6.4) sortable by ID alone. Two properties deliver that:
 *
 * - Within a millisecond, the randomness component is **incremented** rather than redrawn.
 * - If the clock moves backwards, the last observed timestamp is reused rather than emitting a
 *   lower ID. The embedded timestamp is a convenience, never the audit timestamp — §6.4 requires
 *   events to carry their own — so preserving order is worth more than following a bad clock.
 */
export function createIdFactory(options: IdFactoryOptions = {}): IdFactory {
  const now = options.now ?? Date.now;
  const randomBytes = options.randomBytes ?? defaultRandomBytes;

  let lastTimestamp = -1;
  let lastRandom = 0n;

  function newUlid(): string {
    const observed = now();
    if (observed > lastTimestamp) {
      lastTimestamp = observed;
      lastRandom = bytesToRandom(randomBytes(ULID_RANDOM_BYTES));
    } else {
      // Same millisecond, or a clock that moved backwards. Either way, keep the previous
      // timestamp and step the randomness so ordering survives.
      lastRandom += 1n;
      if (lastRandom > MAX_ULID_RANDOM) {
        throw new AldusError(
          CoreErrorCodes.ID_EXHAUSTED,
          "ULID randomness was exhausted within a single millisecond. Monotonic ordering cannot " +
            "be preserved without emitting a lower identifier, so no ID was minted. Retrying in " +
            "the next millisecond succeeds.",
          { category: "internal", retryable: true, details: { timestamp: lastTimestamp } },
        );
      }
    }
    return encodeUlidTime(lastTimestamp) + encodeUlidRandom(lastRandom);
  }

  function newId(prefix: IdPrefix): string {
    if (!ID_PREFIX_SET.has(prefix)) {
      throw new AldusError(
        CoreErrorCodes.ID_INVALID,
        `Unknown entity ID prefix "${prefix}". Expected one of: ${ID_PREFIX_VALUES.join(", ")}.`,
        { category: "validation", details: { prefix } },
      );
    }
    return `${prefix}_${newUlid()}`;
  }

  return {
    newUlid,
    newId,
    newRunId: () => newId(ID_PREFIXES.run),
    newStageExecutionId: () => newId(ID_PREFIXES.stageExecution),
    newStageAttemptId: () => newId(ID_PREFIXES.stageAttempt),
    newArtifactId: () => newId(ID_PREFIXES.artifact),
    newGateId: () => newId(ID_PREFIXES.gate),
    newGateDecisionId: () => newId(ID_PREFIXES.gateDecision),
    newCostId: () => newId(ID_PREFIXES.cost),
    newReleaseId: () => newId(ID_PREFIXES.release),
  };
}

/**
 * Process-wide factory backing the bare `new*Id` helpers.
 *
 * Exported so a caller can reason about the monotonic state the free functions share. Tests
 * should build their own factory via {@link createIdFactory} rather than depend on this one.
 */
export const defaultIdFactory: IdFactory = createIdFactory();

/** Mint an ID with an explicit prefix, using the process-wide factory. */
export const newId = (prefix: IdPrefix): string => defaultIdFactory.newId(prefix);
/** Mint a bare ULID, using the process-wide factory. */
export const newUlid = (): string => defaultIdFactory.newUlid();
/** Mint a `RunManifest.runId` (§6.2). */
export const newRunId = (): string => defaultIdFactory.newRunId();
/** Mint a `StageExecution` ID (§6.3). */
export const newStageExecutionId = (): string => defaultIdFactory.newStageExecutionId();
/** Mint a `StageAttempt.attemptId` (§6.3). */
export const newStageAttemptId = (): string => defaultIdFactory.newStageAttemptId();
/** Mint an `ArtifactRef.artifactId` (§8). */
export const newArtifactId = (): string => defaultIdFactory.newArtifactId();
/** Mint a gate ID (§13). */
export const newGateId = (): string => defaultIdFactory.newGateId();
/** Mint a `GateDecision.decisionId` (§13). */
export const newGateDecisionId = (): string => defaultIdFactory.newGateDecisionId();
/** Mint a `CostRecord.costId` (§19.3). */
export const newCostId = (): string => defaultIdFactory.newCostId();
/** Mint a `ReleaseReceipt.releaseId` (§17). */
export const newReleaseId = (): string => defaultIdFactory.newReleaseId();

/** True if `value` is a strictly well-formed 26-character ULID. */
export function isUlid(value: string): boolean {
  return ULID_PATTERN.test(value);
}

/**
 * Decode the millisecond timestamp embedded in a ULID.
 *
 * @throws {AldusError} `ALDUS_ID_INVALID` if the ULID is malformed. Decoding is strict — see
 * {@link CROCKFORD_ALPHABET}.
 */
export function decodeUlidTimestamp(ulid: string): number {
  if (!isUlid(ulid)) {
    throw new AldusError(
      CoreErrorCodes.ID_INVALID,
      `Malformed ULID "${ulid}": expected ${ULID_LENGTH} strict Crockford Base32 characters ` +
        "with a timestamp component within 48 bits.",
      { category: "validation", details: { received: ulid } },
    );
  }
  let timestamp = 0;
  for (let index = 0; index < 10; index += 1) {
    const digit = CROCKFORD_DECODE.get(ulid.charAt(index));
    if (digit === undefined) {
      throw new AldusError(
        CoreErrorCodes.ID_INVALID,
        `Malformed ULID "${ulid}": character at position ${index} is not Crockford Base32.`,
        { category: "validation", details: { received: ulid, position: index } },
      );
    }
    timestamp = timestamp * 32 + digit;
  }
  return timestamp;
}

/**
 * Parse an entity ID into its parts.
 *
 * Returns `null` rather than throwing, because callers frequently test a candidate string
 * whose validity is genuinely unknown. Use {@link assertId} where a malformed ID is a defect.
 */
export function parseId(id: string): ParsedId | null {
  const separator = id.indexOf("_");
  if (separator <= 0) return null;

  const prefix = id.slice(0, separator);
  if (!ID_PREFIX_SET.has(prefix)) return null;

  const ulid = id.slice(separator + 1);
  if (!isUlid(ulid)) return null;

  return { prefix: prefix as IdPrefix, ulid, timestamp: decodeUlidTimestamp(ulid) };
}

/** True if `id` is a well-formed entity ID, optionally of a specific prefix. */
export function isValidId(id: string, prefix?: IdPrefix): boolean {
  const parsed = parseId(id);
  if (parsed === null) return false;
  return prefix === undefined || parsed.prefix === prefix;
}

/**
 * Parse an entity ID, treating malformity as a defect.
 *
 * @throws {AldusError} `ALDUS_ID_INVALID` if the ID is malformed or carries the wrong prefix.
 */
export function assertId(id: string, prefix?: IdPrefix): ParsedId {
  const parsed = parseId(id);
  if (parsed === null) {
    throw new AldusError(
      CoreErrorCodes.ID_INVALID,
      `Malformed entity ID "${id}": expected "<prefix>_<ULID>" with one of the known prefixes ` +
        `(${ID_PREFIX_VALUES.join(", ")}).`,
      { category: "validation", details: { received: id } },
    );
  }
  if (prefix !== undefined && parsed.prefix !== prefix) {
    throw new AldusError(
      CoreErrorCodes.ID_INVALID,
      `Expected an ID with prefix "${prefix}" but received prefix "${parsed.prefix}".`,
      { category: "validation", details: { received: id, expectedPrefix: prefix } },
    );
  }
  return parsed;
}

// ---------------------------------------------------------------------------------------------
// Section 2 — Canonical content identity (contract §6.1)
// ---------------------------------------------------------------------------------------------

/**
 * Maximum length of one canonical identity segment.
 *
 * A bound is required so an identity cannot be used to smuggle an unbounded payload into a
 * manifest, a log line, or a filename derived from it downstream.
 */
export const MAX_IDENTITY_SEGMENT_LENGTH = 128;

/**
 * A canonical identity segment.
 *
 * Unicode letters and digits are **deliberately** permitted: shows and series in non-Latin
 * scripts must be able to carry usable identities rather than being forced through a lossy
 * transliteration. That is safe here precisely because §8.1 forbids treating a path or filename
 * as identity — filesystem-safe naming is a storage adapter's concern, not this layer's.
 *
 * The first character must be a letter or digit so an identity can never begin with a leading
 * dot or dash.
 */
const IDENTITY_SEGMENT_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u;

/**
 * The four segments of a canonical content identity (§6.1).
 *
 * Generalises both documented forms — `show:{show-id}:episode:{episode-slug}` and
 * `series:{series-id}:edition:{edition-id}` — so that a new content taxonomy needs no change to
 * Core. Contract §4.2 forbids Core from owning show identities, so `namespace` and `itemType`
 * are caller-supplied strings, never an enumeration defined here.
 */
export interface CanonicalIdParts {
  /** Container kind, e.g. `show` or `series`. */
  namespace: string;
  /** Identifier of the container, e.g. a show ID. */
  namespaceId: string;
  /** Item kind, e.g. `episode` or `edition`. */
  itemType: string;
  /** Identifier of the item, e.g. an episode slug. */
  itemId: string;
}

/**
 * True if `value` is a valid canonical identity segment: NFC-normalised, 1 to
 * {@link MAX_IDENTITY_SEGMENT_LENGTH} characters, starting with a letter or digit.
 */
export function isIdentitySegment(value: string): boolean {
  if (value.length === 0 || value.length > MAX_IDENTITY_SEGMENT_LENGTH) return false;
  // Non-NFC input is rejected rather than normalised on read: two byte-different strings that
  // normalise to the same identity would otherwise silently address the same Episode, which is
  // exactly the kind of ambiguity §8.1 exists to prevent.
  if (value.normalize("NFC") !== value) return false;
  return IDENTITY_SEGMENT_PATTERN.test(value);
}

function assertIdentitySegment(field: keyof CanonicalIdParts, value: string): string {
  const normalized = value.normalize("NFC");
  if (!isIdentitySegment(normalized)) {
    throw new AldusError(
      CoreErrorCodes.IDENTITY_INVALID,
      `Canonical identity segment "${field}" is invalid. A segment must be 1 to ` +
        `${MAX_IDENTITY_SEGMENT_LENGTH} characters, begin with a Unicode letter or digit, and ` +
        "otherwise contain only Unicode letters, digits, '.', '_', or '-'.",
      { category: "validation", details: { field, received: value } },
    );
  }
  return normalized;
}

/**
 * Build a canonical content identity (§6.1).
 *
 * Input is NFC-normalised, then validated. Malformed input throws rather than returning a
 * sentinel: minting an identity is a deliberate act, and a caller that reaches this function
 * with bad segments has a defect upstream. The `parse*` and `is*` counterparts return
 * `null`/`false` instead, because they operate on values whose validity is genuinely unknown.
 *
 * This does **not** slugify. Call {@link slugify} first when deriving a segment from free text.
 *
 * @throws {AldusError} `ALDUS_IDENTITY_INVALID` if any segment is invalid.
 */
export function formatCanonicalId(parts: CanonicalIdParts): string {
  const namespace = assertIdentitySegment("namespace", parts.namespace);
  const namespaceId = assertIdentitySegment("namespaceId", parts.namespaceId);
  const itemType = assertIdentitySegment("itemType", parts.itemType);
  const itemId = assertIdentitySegment("itemId", parts.itemId);
  return `${namespace}:${namespaceId}:${itemType}:${itemId}`;
}

/** Parse a canonical content identity, or return `null` if it is malformed. */
export function parseCanonicalId(id: string): CanonicalIdParts | null {
  const segments = id.split(":");
  if (segments.length !== 4) return null;
  const [namespace, namespaceId, itemType, itemId] = segments;
  if (
    namespace === undefined ||
    namespaceId === undefined ||
    itemType === undefined ||
    itemId === undefined
  ) {
    return null;
  }
  if (
    !isIdentitySegment(namespace) ||
    !isIdentitySegment(namespaceId) ||
    !isIdentitySegment(itemType) ||
    !isIdentitySegment(itemId)
  ) {
    return null;
  }
  return { namespace, namespaceId, itemType, itemId };
}

/** True if `id` is a well-formed canonical content identity. */
export function isCanonicalId(id: string): boolean {
  return parseCanonicalId(id) !== null;
}

/**
 * Build the canonical Episode identity documented in §6.1:
 * `show:{show-id}:episode:{episode-slug}`.
 *
 * @throws {AldusError} `ALDUS_IDENTITY_INVALID` if either segment is invalid.
 */
export function formatEpisodeId(showId: string, episodeSlug: string): string {
  return formatCanonicalId({
    namespace: "show",
    namespaceId: showId,
    itemType: "episode",
    itemId: episodeSlug,
  });
}

/**
 * Parse a canonical Episode identity.
 *
 * Returns `null` for any identity that is not specifically a `show:…:episode:…` — a
 * `series:…:edition:…` is a valid canonical identity but not an Episode, and conflating them
 * would let an edition be addressed as an episode.
 */
export function parseEpisodeId(id: string): { showId: string; episodeSlug: string } | null {
  const parts = parseCanonicalId(id);
  if (parts === null) return null;
  if (parts.namespace !== "show" || parts.itemType !== "episode") return null;
  return { showId: parts.namespaceId, episodeSlug: parts.itemId };
}

/** Quotation marks and apostrophes are dropped outright rather than becoming separators. */
const SLUG_SILENT_CHARACTERS = /['‘’"“”`]/gu;
/** Any run of characters a segment cannot contain becomes a single separator. */
const SLUG_SEPARATOR_RUNS = /[^\p{L}\p{N}._-]+/gu;
const SLUG_REPEATED_SEPARATORS = /-{2,}/g;
const SLUG_LEADING_TRIM = /^[-._]+/;
const SLUG_TRAILING_TRIM = /[-._]+$/;

/**
 * Derive a canonical identity segment from free text.
 *
 * Non-Latin scripts survive intact: `\p{L}` covers Han, Hiragana, Hangul, Cyrillic, and the
 * rest, so a show titled in Chinese produces a Chinese slug rather than an empty string. Only
 * characters a segment genuinely cannot contain are folded away.
 *
 * The result is idempotent — `slugify(slugify(x)) === slugify(x)` — but slugify is not the
 * identity function on all valid segments, because it lowercases.
 *
 * @throws {AldusError} `ALDUS_IDENTITY_INVALID` if nothing usable remains.
 */
export function slugify(input: string): string {
  const folded = input
    .normalize("NFC")
    .toLowerCase()
    .replace(SLUG_SILENT_CHARACTERS, "")
    .replace(SLUG_SEPARATOR_RUNS, "-")
    .replace(SLUG_REPEATED_SEPARATORS, "-")
    .replace(SLUG_LEADING_TRIM, "")
    .replace(SLUG_TRAILING_TRIM, "");

  const slug = truncateToSegmentLength(folded).replace(SLUG_TRAILING_TRIM, "");

  if (slug.length === 0) {
    throw new AldusError(
      CoreErrorCodes.IDENTITY_INVALID,
      "Slugifying the input produced an empty segment, so no identity could be derived from it.",
      { category: "validation", details: { inputLength: input.length } },
    );
  }

  // Defence in depth. Every transformation above is meant to yield a valid segment, so a
  // failure here is a defect in this function rather than bad input — but returning a segment
  // that `formatCanonicalId` will reject is worse than failing at the point of the mistake.
  /* v8 ignore next 8 */
  if (!isIdentitySegment(slug)) {
    throw new AldusError(
      CoreErrorCodes.IDENTITY_INVALID,
      "Slugifying the input produced a segment that is not a valid canonical identity segment.",
      { category: "internal", details: { inputLength: input.length, slugLength: slug.length } },
    );
  }
  return slug;
}

/**
 * Truncate to {@link MAX_IDENTITY_SEGMENT_LENGTH} UTF-16 units without splitting a surrogate
 * pair.
 *
 * A plain `slice` cuts by UTF-16 unit, so truncating text in an astral script — CJK Extension
 * B, historic scripts, and anything else above U+FFFF — can sever a surrogate pair and leave a
 * lone surrogate. That string is not well-formed, fails the segment pattern, and would surface
 * as a confusing validation error far from its cause.
 */
function truncateToSegmentLength(value: string): string {
  if (value.length <= MAX_IDENTITY_SEGMENT_LENGTH) return value;
  const truncated = value.slice(0, MAX_IDENTITY_SEGMENT_LENGTH);
  // A trailing high surrogate means the pair was split; drop the orphan.
  return truncated.isWellFormed() ? truncated : truncated.slice(0, -1);
}
