/**
 * Validated JSON documents with forward-compatible round-tripping.
 *
 * ADR-0004 decision 3 is a MUST on this package: a store MUST preserve unknown properties across
 * a read-modify-write. The hazard it addresses is quiet. Zod strips unknown properties on parse
 * (ADR-0002 decision 7), so an older build that reads a manifest written by a newer minor
 * version, changes one field, and writes it back would delete the newer version's data without
 * any error, any warning, or any way to notice afterwards.
 *
 * A Git-tracked `.aldus/` shared between machines on different builds makes that an ordinary
 * situation, not an edge case (contract §5.1, §7). So every read keeps the raw parsed JSON
 * beside the validated value, and every update merges the caller's changes back over the raw.
 */

import {
  validateRecord,
  fromStructuredError,
  type SchemaCompatibility,
  type SchemaTypeFor,
  type VersionedSchemaName,
} from "@aldus-runtime/core";

import { readFileOrUndefined, writeFileAtomic, type AtomicWriteOptions } from "./atomic.js";
import { FileStoreErrorCodes, fileStoreError } from "./errors.js";

/** A record as it exists on disk: validated, plus the bytes it was validated from. */
export interface StoredDocument<T> {
  /** The validated record. Unknown properties are absent, as Zod strips them. */
  value: T;
  /** The parsed JSON exactly as stored, including properties this build does not know about. */
  raw: Record<string, unknown>;
  /** How the stored `schemaVersion` relates to this build (ADR-0003). */
  compatibility: SchemaCompatibility;
}

/**
 * Read and validate a versioned record.
 *
 * Returns `undefined` when the file does not exist — an absent record is an ordinary state, not
 * a failure, and a store that threw here would make "does this run exist?" an exception-handling
 * exercise.
 *
 * @throws {AldusError} `ALDUS_RECORD_MALFORMED` if the bytes are not JSON,
 * `ALDUS_SCHEMA_VERSION_UNSUPPORTED` if the major version is unreadable, or
 * `ALDUS_SCHEMA_VALIDATION_FAILED` if the record does not satisfy its schema.
 */
export async function readDocument<N extends VersionedSchemaName>(
  path: string,
  schema: N,
): Promise<StoredDocument<SchemaTypeFor<N>> | undefined> {
  const contents = await readFileOrUndefined(path);
  if (contents === undefined) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw fileStoreError(
      FileStoreErrorCodes.RECORD_MALFORMED,
      `The stored ${schema} record is not valid JSON. Atomic writes make a torn file impossible, ` +
        "so this means the file was edited or replaced by something other than the store.",
      {
        category: "io",
        retryable: false,
        // The file's contents are excluded deliberately: a record may carry redacted-but-
        // sensitive context (§19.2), and an error is itself durable.
        details: { path, schema, byteLength: contents.length },
      },
    );
  }

  if (!isPlainObject(parsed)) {
    throw fileStoreError(
      FileStoreErrorCodes.RECORD_MALFORMED,
      `The stored ${schema} record is valid JSON but not an object.`,
      { category: "io", retryable: false, details: { path, schema } },
    );
  }

  const result = validateRecord(schema, parsed);
  if (!result.ok) throw fromStructuredError(result.error);

  return { value: result.value, raw: parsed, compatibility: result.compatibility };
}

/** Write a record, replacing any previous contents atomically. */
export async function writeDocument(
  path: string,
  value: unknown,
  options: AtomicWriteOptions = {},
): Promise<void> {
  await writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`, options);
}

/**
 * Merge a validated update back over the bytes it came from, keeping properties this build does
 * not know about (ADR-0004 decision 3).
 *
 * The three arguments are what make this precise rather than a guess:
 *
 * - `raw` — everything that was on disk.
 * - `original` — the same record after validation, so its keys are exactly the ones this build
 *   understands.
 * - `next` — the caller's updated record.
 *
 * A key present in `raw` but absent from `original` is unknown to this build, so it is preserved.
 * A key present in both but absent from `next` was deliberately removed by the caller, so it is
 * dropped. Without that distinction, preservation would resurrect fields a caller had just
 * deleted.
 *
 * Arrays are merged element-wise **only when the lengths match**, which is the case where index
 * identity is sound. If the caller added or removed elements, indices no longer denote the same
 * records and `next` is taken wholesale — losing unknown properties inside those elements rather
 * than attaching them to the wrong element. That trade is deliberate: silently misattributing a
 * field is worse than dropping it.
 */
export function preserveUnknown(raw: unknown, original: unknown, next: unknown): unknown {
  if (Array.isArray(raw) && Array.isArray(original) && Array.isArray(next)) {
    if (raw.length !== original.length || original.length !== next.length) return next;
    return next.map((element, index) => preserveUnknown(raw[index], original[index], element));
  }

  if (!isPlainObject(raw) || !isPlainObject(original) || !isPlainObject(next)) return next;

  const merged: Record<string, unknown> = {};
  for (const key of Object.keys(raw)) {
    if (!(key in original)) merged[key] = raw[key];
  }
  for (const key of Object.keys(next)) {
    merged[key] =
      key in raw && key in original
        ? preserveUnknown(raw[key], original[key], next[key])
        : next[key];
  }
  return merged;
}

/** Apply {@link preserveUnknown} against a stored document. */
export function mergeForWrite<T>(document: StoredDocument<T>, next: T): unknown {
  return preserveUnknown(document.raw, document.value, next);
}

/** True for a JSON object, excluding arrays and null. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
