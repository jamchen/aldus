/**
 * Per-run collection files (contract §7: `artifacts.json`, `approvals.json`, `costs.json`,
 * `release.json`).
 *
 * Each holds a JSON array of records that each carry their own `schemaVersion`, so the array
 * itself needs no envelope. Appending writes back the **raw** parsed array with one element
 * added, which preserves unknown properties on every existing element for free — there is no
 * merge to get wrong, because nothing already stored is ever re-serialised from a validated
 * value (ADR-0004 decision 3).
 */

import {
  validateRecord,
  fromStructuredError,
  type SchemaTypeFor,
  type VersionedSchemaName,
} from "@aldus/core";

import { readFileOrUndefined, type AtomicWriteOptions } from "./atomic.js";
import { writeDocument } from "./document.js";
import { FileStoreErrorCodes, fileStoreError } from "./errors.js";

/** A collection read: validated records plus the raw array they were parsed from. */
export interface StoredCollection<T> {
  values: T[];
  raw: unknown[];
}

/**
 * Read and validate a collection file.
 *
 * An absent file reads as an empty collection: a Run that has produced no artifacts yet is an
 * ordinary state (contract §6.2 `created`), not a missing record.
 */
export async function readCollection<N extends VersionedSchemaName>(
  path: string,
  schema: N,
): Promise<StoredCollection<SchemaTypeFor<N>>> {
  const contents = await readFileOrUndefined(path);
  if (contents === undefined || contents.trim().length === 0) return { values: [], raw: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw fileStoreError(
      FileStoreErrorCodes.RECORD_MALFORMED,
      `The stored ${schema} collection is not valid JSON. Atomic writes make a torn file ` +
        "impossible, so this means the file was edited or replaced by something other than the store.",
      { category: "io", retryable: false, details: { path, schema, byteLength: contents.length } },
    );
  }

  if (!Array.isArray(parsed)) {
    throw fileStoreError(
      FileStoreErrorCodes.RECORD_MALFORMED,
      `The stored ${schema} collection is valid JSON but not an array.`,
      { category: "io", retryable: false, details: { path, schema } },
    );
  }

  const values: SchemaTypeFor<N>[] = [];
  for (let index = 0; index < parsed.length; index += 1) {
    const result = validateRecord(schema, parsed[index]);
    if (!result.ok) {
      const error = fromStructuredError(result.error);
      // Name the offending index. Without it, a 200-element artifacts file reports "one of these
      // is wrong" and leaves an operator to bisect by hand.
      throw fileStoreError(
        FileStoreErrorCodes.RECORD_MALFORMED,
        `Element ${index} of the stored ${schema} collection is not a valid ${schema}: ${error.message}`,
        {
          category: "io",
          retryable: false,
          details: { path, schema, index },
        },
      );
    }
    values.push(result.value);
  }

  return { values, raw: parsed };
}

/** Append one record to a collection file, preserving every existing element byte for byte. */
export async function appendToCollection<N extends VersionedSchemaName>(
  path: string,
  schema: N,
  record: SchemaTypeFor<N>,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const existing = await readCollection(path, schema);
  await writeDocument(path, [...existing.raw, record], options);
}
