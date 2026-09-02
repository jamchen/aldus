/**
 * Validation entry points.
 *
 * Architecture contract §11 requires every stage to "validate its declared inputs" and to
 * "produce declared outputs or a structured failure". So validation returns a result rather
 * than throwing by default: a failed validation is an expected outcome the runtime records, not
 * an exceptional one.
 *
 * Contract §19.2 requires that logs redact credentials. A validation error is written into
 * durable records (`StageAttempt.error`, `events.jsonl`), so this module guarantees that a
 * validation failure NEVER echoes a received input value — see {@link scrubMessage}.
 */

import type { z } from "zod";

import {
  AldusError,
  CoreErrorCodes,
  truncateErrorMessage,
  type StructuredError,
} from "./errors.js";
import {
  assertSchemaVersionReadable,
  checkSchemaVersion,
  isSchemaVersion,
  SCHEMA_VERSION,
  type SchemaCompatibility,
} from "./schema-version.js";
import {
  coreSchemas,
  isSchemaName,
  listSchemaNames,
  type SchemaName,
  type SchemaTypeFor,
  type VersionedSchemaName,
} from "./schema/index.js";

/* -------------------------------------------------------------------------------------------
 * Result shapes
 * ---------------------------------------------------------------------------------------- */

/** One schema violation, described without reference to the offending value (contract §19.2). */
export interface ValidationIssue {
  /** Dotted/bracketed path to the failing field, e.g. `attempts[0].actor.kind`. */
  path: string;
  /** Machine-readable issue code from the validator. */
  code: string;
  /** Human-readable description. Guaranteed not to contain any received input value. */
  message: string;
}

/** Outcome of a validation that does not consider schema versioning. */
export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: StructuredError };

/**
 * Outcome of a version-aware record validation.
 *
 * `droppedPaths` is present only when the parse discarded something: the paths of properties the
 * record carried and this build's schema does not declare (ADR-0003 reader behaviour, ADR-0053).
 * A `forward` read is where that ordinarily happens — a newer minor added a field this build has
 * never heard of — and `compatibility: "forward"` alone told a caller that the record came from a
 * newer build without telling them what they lost (#199). Paths, never values (contract §19.2).
 */
export type RecordValidationResult<T> =
  | {
      readonly ok: true;
      readonly value: T;
      readonly compatibility: SchemaCompatibility;
      readonly droppedPaths?: readonly string[];
    }
  | { readonly ok: false; readonly error: StructuredError };

/* -------------------------------------------------------------------------------------------
 * Value-safety machinery (contract §19.2)
 * ---------------------------------------------------------------------------------------- */

/**
 * Minimum length of an input string considered worth scrubbing from an error message.
 *
 * Credentials, tokens, and signed URLs are long. Short strings are excluded because scrubbing
 * on them produces false positives — an enum message legitimately naming `"approved"` would be
 * suppressed whenever some unrelated field happened to contain that word.
 */
const MIN_SCRUB_TOKEN_LENGTH = 8;

/** Depth limit when harvesting input strings. Matches the redaction module's default posture. */
const SCRUB_SCAN_MAX_DEPTH = 8;

/** Substituted for any message that would have echoed input content. */
const WITHHELD_MESSAGE =
  "Value failed validation; detail withheld because it would have echoed input content.";

/**
 * Harvest every string of interest from a value, so {@link scrubMessage} can prove a message
 * does not contain one.
 *
 * This is a mechanical guarantee rather than an assumption about the validator's phrasing. Zod
 * messages are generally value-free, but "generally" is not a property worth betting a
 * credential leak on (contract §19.2).
 */
function collectInputStrings(
  value: unknown,
  out: Set<string>,
  depth: number,
  seen: WeakSet<object>,
): void {
  if (depth > SCRUB_SCAN_MAX_DEPTH) return;
  if (typeof value === "string") {
    if (value.length >= MIN_SCRUB_TOKEN_LENGTH) out.add(value);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  if (seen.has(value)) return;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const entry of value) collectInputStrings(entry, out, depth + 1, seen);
    return;
  }
  for (const entry of Object.values(value)) collectInputStrings(entry, out, depth + 1, seen);
}

/** Replace a message that contains any harvested input string (contract §19.2). */
function scrubMessage(message: string, inputStrings: ReadonlySet<string>): string {
  for (const candidate of inputStrings) {
    if (message.includes(candidate)) return WITHHELD_MESSAGE;
  }
  return message;
}

/** Depth limit when comparing a record against what its parse kept. Matches the scrub scan. */
const DROPPED_SCAN_MAX_DEPTH = SCRUB_SCAN_MAX_DEPTH;

/**
 * The paths a non-strict parse discarded: present in `input`, absent from `output`.
 *
 * Every Core record schema strips unknown properties rather than refusing them, which is what
 * makes a `forward` read safe (ADR-0003). It is also a silent loss: the caller receives an object
 * that looks complete and is not, with nothing saying which part went missing. This names the part.
 *
 * Paths only — the value under a dropped key is exactly the thing this build cannot interpret and
 * must not echo (contract §19.2). A dropped subtree is reported once, at its root, because its
 * interior is by definition undeclared here and enumerating it would describe the other build's
 * schema rather than this one's.
 */
function droppedPaths(input: unknown, output: unknown): string[] {
  const dropped: string[] = [];
  const walk = (from: unknown, kept: unknown, path: PropertyKey[]): void => {
    if (path.length > DROPPED_SCAN_MAX_DEPTH) return;
    if (typeof from !== "object" || from === null || typeof kept !== "object" || kept === null) {
      return;
    }
    if (Array.isArray(from)) {
      if (!Array.isArray(kept)) return;
      from.forEach((entry, index) => walk(entry, kept[index], [...path, index]));
      return;
    }
    for (const [key, value] of Object.entries(from)) {
      if (!Object.hasOwn(kept, key)) {
        dropped.push(formatIssuePath([...path, key]));
        continue;
      }
      walk(value, (kept as Record<string, unknown>)[key], [...path, key]);
    }
  };
  walk(input, output, []);
  return dropped;
}

/** Render a validator path as `a.b[0].c`. */
export function formatIssuePath(path: ReadonlyArray<PropertyKey>): string {
  let rendered = "";
  for (const segment of path) {
    if (typeof segment === "number") {
      rendered += `[${segment}]`;
    } else {
      rendered += rendered === "" ? String(segment) : `.${String(segment)}`;
    }
  }
  return rendered;
}

/*
 * Why the summary counts the failing issues and does not name them.
 *
 * Naming them was tried and withdrawn (#254, #255). A rendered path is *normally* schema
 * content, but a segment can be a **key taken from the validated value** — a `z.record` reports
 * the offending key as the path, and Core validates against a schema supplied by its caller, so
 * it has no way to tell one from the other. `KnowledgePackRef.scope`
 * (`packages/aldus-core/src/schema/common.ts:168`) is a live instance: a `z.record` whose key
 * schema and value schema both have bounds, so an over-long value raises an issue whose last
 * path segment is the caller's key.
 *
 * Shape is not provenance. A key that reads exactly like a field name — `AKIAABCDEFGHIJKLMNOP`
 * — passes any identifier test there is, and this message is written into `events.jsonl` and
 * printed by a CLI. {@link scrubMessage} does not cover it either: it harvests input *values*,
 * and a record key is not a value.
 *
 * So the summary says how many, and `details.issues` says where — unchanged, and the place a
 * reader was always meant to look. Deciding this generically would need the schema's own
 * structure, which Core does not introspect, and a caller that knows its schema can name paths
 * itself: `StageRunner` does exactly that for `AldusEvent`.
 */

/** Convert validator issues into value-free {@link ValidationIssue}s. */
function toValidationIssues(
  error: z.ZodError,
  inputStrings: ReadonlySet<string>,
): ValidationIssue[] {
  return error.issues.map((issue) => ({
    path: formatIssuePath(issue.path),
    code: issue.code,
    message: scrubMessage(issue.message, inputStrings),
  }));
}

/**
 * Build the structured error for a failed validation.
 *
 * `occurredAt` is deliberately omitted: this module takes no clock, so stamping a time here
 * would either invent a dependency or fabricate a value. The caller that persists the error
 * stamps it.
 */
function toValidationError(
  code: string,
  subject: string,
  error: z.ZodError,
  data: unknown,
): StructuredError {
  const inputStrings = new Set<string>();
  collectInputStrings(data, inputStrings, 0, new WeakSet());
  const issues = toValidationIssues(error, inputStrings);

  // No path names here — see the note above `toValidationIssues`. `subject` is caller-supplied
  // and so goes through the same scrub an issue message does (contract §19.2), then through the
  // schema's own length bound, because a summary is not exempt from the rules the detail obeys.
  const message = truncateErrorMessage(
    scrubMessage(
      `${subject} failed schema validation (${issues.length} issue${issues.length === 1 ? "" : "s"}).`,
      inputStrings,
    ),
  );

  return {
    code,
    category: "validation",
    message,
    retryable: false,
    details: { subject, issues },
  };
}

/* -------------------------------------------------------------------------------------------
 * Public API
 * ---------------------------------------------------------------------------------------- */

/** Validate against an arbitrary schema, e.g. one defined by an adopter integration. */
export function validateWith<T>(
  schema: z.ZodType<T>,
  data: unknown,
  options: { code?: string; subject?: string } = {},
): ValidationResult<T> {
  const parsed = schema.safeParse(data);
  if (parsed.success) return { ok: true, value: parsed.data };
  return {
    ok: false,
    error: toValidationError(
      options.code ?? CoreErrorCodes.SCHEMA_VALIDATION_FAILED,
      options.subject ?? "Value",
      parsed.error,
      data,
    ),
  };
}

/** Structured error for a schema name that is not registered. */
function unknownSchemaError(name: string): StructuredError {
  return {
    code: CoreErrorCodes.SCHEMA_UNKNOWN,
    category: "not_found",
    message: `Unknown schema "${name}".`,
    retryable: false,
    details: { requested: name, known: listSchemaNames() },
  };
}

/**
 * Validate a value against a registered core schema (contract §11).
 *
 * Does not inspect `schemaVersion`; use {@link validateRecord} when reading a persisted record.
 */
export function validate<N extends SchemaName>(
  name: N,
  data: unknown,
): ValidationResult<SchemaTypeFor<N>> {
  if (!isSchemaName(name)) return { ok: false, error: unknownSchemaError(String(name)) };
  const schema = coreSchemas[name] as z.ZodType<SchemaTypeFor<N>>;
  return validateWith(schema, data, { subject: name });
}

/**
 * Validate and return the value, throwing on failure.
 *
 * For boundaries that cannot express failure in a return value. Prefer {@link validate}.
 *
 * @throws {AldusError} `ALDUS_SCHEMA_VALIDATION_FAILED` or `ALDUS_SCHEMA_UNKNOWN`.
 */
export function assertValid<N extends SchemaName>(name: N, data: unknown): SchemaTypeFor<N> {
  const result = validate(name, data);
  if (result.ok) return result.value;
  throw fromStructuredError(result.error);
}

/**
 * Validate a persisted record, checking its schema version first (ADR-0003).
 *
 * Version is checked before fields so that a record written by an incompatible major version
 * fails with one clear `ALDUS_SCHEMA_VERSION_UNSUPPORTED` rather than a pile of field errors
 * that describe the symptom instead of the cause.
 *
 * A `forward` read — same major, newer minor — succeeds, and the classification is returned so
 * a caller may decline to write such a record back. That decision belongs to the store, not
 * here. What the parse discarded on the way is returned as `droppedPaths`, so the caller is told
 * not only that the record is newer but which of its parts this build did not keep (#199).
 */
export function validateRecord<N extends VersionedSchemaName>(
  name: N,
  data: unknown,
  supported: string = SCHEMA_VERSION,
): RecordValidationResult<SchemaTypeFor<N>> {
  if (!isSchemaName(name)) return { ok: false, error: unknownSchemaError(String(name)) };

  const declared = readSchemaVersion(data);
  // A missing or malformed version is a field-level problem: fall through so the schema reports
  // it precisely, rather than pre-empting it with a vaguer version error.
  let compatibility: SchemaCompatibility = "compatible";
  if (declared !== undefined && isSchemaVersion(declared)) {
    compatibility = checkSchemaVersion(declared, supported);
    if (compatibility === "incompatible") {
      return { ok: false, error: unsupportedVersionError(name, declared, supported) };
    }
  }

  const result = validate(name, data);
  if (!result.ok) return result;
  const dropped = droppedPaths(data, result.value);
  return dropped.length === 0
    ? { ok: true, value: result.value, compatibility }
    : { ok: true, value: result.value, compatibility, droppedPaths: dropped };
}

/**
 * Validate a persisted record and return it, throwing on failure.
 *
 * @throws {AldusError} `ALDUS_SCHEMA_VERSION_UNSUPPORTED` when the major version differs,
 * otherwise `ALDUS_SCHEMA_VALIDATION_FAILED`.
 */
export function assertValidRecord<N extends VersionedSchemaName>(
  name: N,
  data: unknown,
  supported: string = SCHEMA_VERSION,
): {
  value: SchemaTypeFor<N>;
  compatibility: SchemaCompatibility;
  droppedPaths?: readonly string[];
} {
  const declared = readSchemaVersion(data);
  if (declared !== undefined && isSchemaVersion(declared)) {
    assertSchemaVersionReadable(declared, supported);
  }
  const result = validateRecord(name, data, supported);
  if (!result.ok) throw fromStructuredError(result.error);
  return result.droppedPaths === undefined
    ? { value: result.value, compatibility: result.compatibility }
    : {
        value: result.value,
        compatibility: result.compatibility,
        droppedPaths: result.droppedPaths,
      };
}

/** Read a `schemaVersion` property without assuming the value is an object. */
function readSchemaVersion(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const value = (data as { schemaVersion?: unknown }).schemaVersion;
  return typeof value === "string" ? value : undefined;
}

/** Structured error for a record this build cannot read (ADR-0003). */
function unsupportedVersionError(name: string, actual: string, supported: string): StructuredError {
  return {
    code: CoreErrorCodes.SCHEMA_VERSION_UNSUPPORTED,
    category: "validation",
    message:
      `${name} declares schema version "${actual}", which is not readable by this build ` +
      `(supports "${supported}"). A differing major version means a field was removed, renamed, ` +
      "narrowed, or changed meaning.",
    retryable: false,
    details: { subject: name, actual, supported },
  };
}

/** Rehydrate a {@link StructuredError} into a throwable {@link AldusError}. */
export function fromStructuredError(error: StructuredError): AldusError {
  const options: ConstructorParameters<typeof AldusError>[2] = { category: error.category };
  options.retryable = error.retryable;
  if (error.details !== undefined) options.details = error.details;
  if (error.causes !== undefined) options.causes = error.causes;
  if (error.occurredAt !== undefined) options.occurredAt = error.occurredAt;
  return new AldusError(error.code, error.message, options);
}
