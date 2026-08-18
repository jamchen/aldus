/**
 * Redaction helpers.
 *
 * Architecture contract §19.2 requires that "logs MUST redact credentials and sensitive request
 * headers" and that "secrets MUST be referenced, not embedded in manifests or logs". §6.4
 * requires every state mutation to emit an event carrying "safe error detail", and §14.4 and
 * §15 require recording provider request telemetry — all of which routinely travels beside a
 * credential.
 *
 * Redaction is therefore applied at the point a value is produced, not deferred to a logging
 * sink: an event written to `events.jsonl` is durable, and a secret written there once is
 * leaked permanently.
 *
 * Two independent mechanisms run together:
 *
 * - **By key name** — a field called `apiKey` is a secret whatever it contains.
 * - **By value shape** — a bearer token pasted into a field called `note` is still a secret.
 *
 * The heuristics are deliberately conservative in one direction: a 64-character SHA-256 digest
 * is *never* redacted, because hashes are load-bearing identity throughout this system (§8,
 * §13 `subjectHashes`) and destroying one causes more harm than the leak it would prevent.
 */

import type { StructuredError } from "./errors.js";

/** Replacement written in place of a redacted value. */
export const DEFAULT_REDACTION_PLACEHOLDER = "[REDACTED]";

/** Default maximum object/array nesting depth before truncation. */
export const DEFAULT_MAX_DEPTH = 8;

/** Default maximum string length before truncation. */
export const DEFAULT_MAX_STRING_LENGTH = 4096;

/** Default maximum number of array elements retained. */
export const DEFAULT_MAX_ARRAY_LENGTH = 1000;

/**
 * Key-name patterns that mark a field as sensitive.
 *
 * Before matching, a key is normalised by inserting `-` at camelCase boundaries, so
 * `sessionId` and `session_id` are treated alike.
 *
 * Two exclusions are load-bearing and must survive any future edit to this list:
 *
 * - `/auth(?!or)/i` deliberately does **not** match `author` or `authority`. `authority` is a
 *   real field on `KnowledgePackRef` (§9.1) and redacting it would corrupt pack precedence.
 * - There is no bare `key` pattern, because `idempotencyKey` is a real field on
 *   `ReleaseReceipt` (§17) and is required for resumable publishing.
 *
 * Exported so an adopter integration can extend the list rather than fork Core.
 */
export const DEFAULT_SENSITIVE_KEY_PATTERNS: readonly RegExp[] = [
  /token/i,
  /secret/i,
  /password|passwd|pwd/i,
  /passphrase/i,
  /api[-_. ]?key/i,
  /private[-_. ]?key/i,
  /access[-_. ]?key/i,
  /session[-_. ]?(id|token)/i,
  /authorization/i,
  /auth(?!or)/i,
  /cookie/i,
  /credentials?/i,
  /signature/i,
  /(?:^|[-_. ])sigs?(?:$|[-_. ])/i,
  /(?:^|[-_. ])salt(?:$|[-_. ])/i,
  /bearer/i,
];

/**
 * Value-shape patterns that mark string content as sensitive regardless of its key.
 *
 * All of them match *within* a larger string, because the realistic leak is a credential
 * interpolated into a message rather than assigned cleanly to a well-named field.
 *
 * The final entry is the entropy heuristic, and its shape is chosen carefully. It requires an
 * **unbroken run of 32 or more alphanumerics** containing lowercase, uppercase, and a digit.
 * Requiring the run to be unbroken is what separates a key from domain text: a filename like
 * `episode-01-final-mix-APPROVED.wav` or a path like `/Users/someone/artifacts/take-03.wav`
 * is long and mixed-case, but every alphanumeric run inside it is short. Redacting those would
 * destroy production trace (§20) to prevent a leak that was not there.
 *
 * The composition requirement is likewise what keeps digests safe: a SHA-256 is hexadecimal, so
 * it is either all-lowercase or all-uppercase and can never satisfy both. ULIDs (§ this
 * package's `ids.ts`) are uppercase and digits only, so they cannot match either.
 *
 * Exported so an adopter integration can extend the list rather than fork Core.
 */
export const DEFAULT_SENSITIVE_VALUE_PATTERNS: readonly RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/-]{8,}={0,2}/i,
  /\bBasic\s+[A-Za-z0-9+/]{8,}={0,2}/i,
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*/,
  /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/,
  /(?<![A-Za-z0-9])(?=[A-Za-z0-9]*[a-z])(?=[A-Za-z0-9]*[A-Z])(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{32,}/,
];

/** Tunables for {@link redact} and its companions. */
export interface RedactionOptions {
  /** Replacement text. Defaults to {@link DEFAULT_REDACTION_PLACEHOLDER}. */
  placeholder?: string;
  /** Replaces {@link DEFAULT_SENSITIVE_KEY_PATTERNS} entirely. */
  keyPatterns?: readonly RegExp[];
  /** Replaces {@link DEFAULT_SENSITIVE_VALUE_PATTERNS} entirely. */
  valuePatterns?: readonly RegExp[];
  /** Appended to the effective key patterns. Use this to extend rather than replace. */
  additionalKeyPatterns?: readonly RegExp[];
  /** Key names never redacted, whatever the patterns say. Compared case-insensitively. */
  allowKeys?: readonly string[];
  /** Maximum nesting depth. Defaults to {@link DEFAULT_MAX_DEPTH}. */
  maxDepth?: number;
  /** Maximum string length. Defaults to {@link DEFAULT_MAX_STRING_LENGTH}. */
  maxStringLength?: number;
  /** Maximum retained array elements. Defaults to {@link DEFAULT_MAX_ARRAY_LENGTH}. */
  maxArrayLength?: number;
}

interface ResolvedOptions {
  placeholder: string;
  keyPatterns: readonly RegExp[];
  valuePatterns: readonly RegExp[];
  allowKeys: ReadonlySet<string>;
  maxDepth: number;
  maxStringLength: number;
  maxArrayLength: number;
}

function resolveOptions(options: RedactionOptions = {}): ResolvedOptions {
  const base = options.keyPatterns ?? DEFAULT_SENSITIVE_KEY_PATTERNS;
  return {
    placeholder: options.placeholder ?? DEFAULT_REDACTION_PLACEHOLDER,
    keyPatterns:
      options.additionalKeyPatterns === undefined
        ? base
        : [...base, ...options.additionalKeyPatterns],
    valuePatterns: options.valuePatterns ?? DEFAULT_SENSITIVE_VALUE_PATTERNS,
    allowKeys: new Set((options.allowKeys ?? []).map((key) => key.toLowerCase())),
    maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
    maxStringLength: options.maxStringLength ?? DEFAULT_MAX_STRING_LENGTH,
    maxArrayLength: options.maxArrayLength ?? DEFAULT_MAX_ARRAY_LENGTH,
  };
}

/** Insert `-` at camelCase boundaries so delimiter-anchored patterns work on camelCase keys. */
function normalizeKeyForMatching(key: string): string {
  return key.replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1-$2");
}

/**
 * True if a field with this name should have its value redacted outright (§19.2).
 *
 * `allowKeys` wins over every pattern, so an adopter can rescue a field whose name happens to
 * collide with a heuristic.
 */
export function isSensitiveKey(key: string, options?: RedactionOptions): boolean {
  const resolved = resolveOptions(options);
  return isSensitiveKeyResolved(key, resolved);
}

function isSensitiveKeyResolved(key: string, options: ResolvedOptions): boolean {
  if (options.allowKeys.has(key.toLowerCase())) return false;
  const candidate = normalizeKeyForMatching(key);
  return options.keyPatterns.some((pattern) => matchesOnce(pattern, candidate));
}

/**
 * Test a pattern without inheriting `lastIndex` state.
 *
 * A module-level `RegExp` carrying the `g` flag advances `lastIndex` on every `test`, so the
 * second call against the same pattern can silently miss. Cloning per call removes the hazard
 * regardless of what flags a caller supplies through `keyPatterns`/`valuePatterns`.
 */
function matchesOnce(pattern: RegExp, value: string): boolean {
  const flags = pattern.flags.replace("g", "").replace("y", "");
  return new RegExp(pattern.source, flags).test(value);
}

/** Replace every occurrence of a pattern, again immune to inherited `lastIndex` state. */
function replaceAllMatches(pattern: RegExp, value: string, placeholder: string): string {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  return value.replace(new RegExp(pattern.source, flags.replace("y", "")), placeholder);
}

/** Apply value-shape patterns, then enforce the length cap. */
function redactString(value: string, options: ResolvedOptions): string {
  let result = value;
  for (const pattern of options.valuePatterns) {
    if (matchesOnce(pattern, result)) {
      result = replaceAllMatches(pattern, result, options.placeholder);
    }
  }
  // Truncate only after redacting: cutting first could leave the leading half of a secret.
  if (result.length > options.maxStringLength) {
    return `${result.slice(0, options.maxStringLength)}… [truncated, ${result.length} chars]`;
  }
  return result;
}

function isPlainRecord(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Deep-clone a value with credentials removed (§19.2).
 *
 * The result is JSON-safe: cycles become `"[Circular]"`, binary payloads become a size
 * summary, and depth, array length, and string length are all bounded so a redacted value can
 * never be larger than the log line it is destined for.
 *
 * Redaction is a one-way transformation. It is never applied to a value that will subsequently
 * be persisted as production state — only to values headed for a log, an error, or an event.
 */
export function redact(value: unknown, options?: RedactionOptions): unknown {
  return redactValue(value, resolveOptions(options), 0, new WeakSet<object>());
}

function redactValue(
  value: unknown,
  options: ResolvedOptions,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (value === null || value === undefined) return value;

  switch (typeof value) {
    case "string":
      return redactString(value, options);
    case "number":
    case "boolean":
      return value;
    case "bigint":
      // Rendered as a string because `JSON.stringify` throws on a bigint.
      return `${value.toString()}n`;
    case "symbol":
      return "[Symbol]";
    case "function":
      return "[Function]";
    default:
      break;
  }

  const object = value as object;

  if (object instanceof Date) return object.toISOString();
  if (object instanceof RegExp) return object.toString();
  if (object instanceof ArrayBuffer) return `[Binary ${object.byteLength} bytes]`;
  if (ArrayBuffer.isView(object)) return `[Binary ${object.byteLength} bytes]`;
  if (object instanceof Error) {
    return {
      name: object.name,
      message: redactString(object.message, options),
    };
  }

  if (depth >= options.maxDepth) return "[MaxDepth]";
  // Membership is tracked along the current path only, and released on the way out, so a value
  // legitimately referenced twice in a tree is not misreported as a cycle.
  if (seen.has(object)) return "[Circular]";
  seen.add(object);

  try {
    if (Array.isArray(object)) {
      return redactArray(object, options, depth, seen);
    }
    if (object instanceof Set) {
      return redactArray([...object], options, depth, seen);
    }
    if (object instanceof Map) {
      return [...object.entries()].map(([entryKey, entryValue]) => [
        redactValue(entryKey, options, depth + 1, seen),
        typeof entryKey === "string" && isSensitiveKeyResolved(entryKey, options)
          ? options.placeholder
          : redactValue(entryValue, options, depth + 1, seen),
      ]);
    }
    return redactObject(object, options, depth, seen, isPlainRecord(object));
  } finally {
    seen.delete(object);
  }
}

function redactArray(
  items: readonly unknown[],
  options: ResolvedOptions,
  depth: number,
  seen: WeakSet<object>,
): unknown[] {
  const kept = items
    .slice(0, options.maxArrayLength)
    .map((item) => redactValue(item, options, depth + 1, seen));
  if (items.length > options.maxArrayLength) {
    kept.push(`[+${items.length - options.maxArrayLength} more]`);
  }
  return kept;
}

function redactObject(
  object: object,
  options: ResolvedOptions,
  depth: number,
  seen: WeakSet<object>,
  plain: boolean,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  // `Object.entries` copes with a null-prototype object; touching `constructor` would not.
  for (const [key, entryValue] of Object.entries(object)) {
    result[key] = isSensitiveKeyResolved(key, options)
      ? options.placeholder
      : redactValue(entryValue, options, depth + 1, seen);
  }
  if (!plain) {
    // Class instances keep a breadcrumb; the constructor name is structural, never a secret.
    const name: unknown = object.constructor?.name;
    if (typeof name === "string" && name !== "Object") result["__type"] = name;
  }
  return result;
}

/** Convenience wrapper preserving the record shape, for callers building `details` bags. */
export function redactRecord(
  record: Record<string, unknown>,
  options?: RedactionOptions,
): Record<string, unknown> {
  const redacted = redact(record, options);
  return typeof redacted === "object" && redacted !== null && !Array.isArray(redacted)
    ? (redacted as Record<string, unknown>)
    : {};
}

/** Header collections accepted by {@link redactHeaders}. */
export type RedactableHeaders = Record<string, string | string[] | undefined> | Headers;

/**
 * Redact request or response headers (§19.2, which names "sensitive request headers"
 * explicitly).
 *
 * Header names are matched case-insensitively, since HTTP header names are.
 */
export function redactHeaders(
  headers: RedactableHeaders,
  options?: RedactionOptions,
): Record<string, string | string[]> {
  const resolved = resolveOptions(options);
  const entries: Array<[string, string | string[]]> =
    typeof Headers !== "undefined" && headers instanceof Headers
      ? [...headers.entries()]
      : Object.entries(headers).flatMap(([name, value]) =>
          value === undefined ? [] : [[name, value] as [string, string | string[]]],
        );

  const result: Record<string, string | string[]> = {};
  for (const [name, value] of entries) {
    if (isSensitiveKeyResolved(name, resolved)) {
      result[name] = resolved.placeholder;
    } else if (Array.isArray(value)) {
      result[name] = value.map((item) => redactString(item, resolved));
    } else {
      result[name] = redactString(value, resolved);
    }
  }
  return result;
}

/**
 * Redact a URI for logging.
 *
 * Userinfo is stripped, and the *values* of sensitive query parameters are replaced while their
 * names are kept — a parameter name is diagnostic, only its value is the secret.
 *
 * Artifact URIs (§8 `ArtifactRef.uri`) pass through unchanged, which matters because a redacted
 * artifact URI would break lineage inspection (§20).
 *
 * Never throws: an unparseable URI yields a placeholder rather than propagating a failure out
 * of a logging path.
 */
export function redactUri(uri: string, options?: RedactionOptions): string {
  const resolved = resolveOptions(options);

  const scrub = (url: URL): void => {
    if (url.username !== "" || url.password !== "") {
      url.username = "***";
      url.password = "";
    }
    for (const name of [...url.searchParams.keys()]) {
      if (isSensitiveKeyResolved(name, resolved)) {
        // Stripped to URL-safe characters so the query reads as `token=REDACTED` rather than
        // percent-encoded noise. A log an operator cannot read is a log they will not read.
        url.searchParams.set(name, resolved.placeholder.replace(/[^A-Za-z0-9._~-]/g, ""));
      }
    }
  };

  try {
    const url = new URL(uri);
    scrub(url);
    return url.toString();
  } catch {
    // Fall through to a relative-reference attempt.
  }

  try {
    const marker = "aldus-relative:";
    const url = new URL(uri, `${marker}//placeholder`);
    scrub(url);
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "[UnparseableUri]";
  }
}

/**
 * Redact a {@link StructuredError} in place of the producer having done so (§19.1, §19.2).
 *
 * `message` is scanned for value-shaped secrets, `details` is fully redacted, and the cause
 * chain is processed recursively. Existing depth bounds on the chain are preserved by
 * construction, since this maps rather than extends.
 */
export function redactError(error: StructuredError, options?: RedactionOptions): StructuredError {
  const resolved = resolveOptions(options);
  const result: StructuredError = {
    code: error.code,
    category: error.category,
    message: redactString(error.message, resolved),
    retryable: error.retryable,
  };
  if (error.details !== undefined) result.details = redactRecord(error.details, options);
  if (error.causes !== undefined) {
    result.causes = error.causes.map((cause) => redactError(cause, options));
  }
  if (error.occurredAt !== undefined) result.occurredAt = error.occurredAt;
  return result;
}
