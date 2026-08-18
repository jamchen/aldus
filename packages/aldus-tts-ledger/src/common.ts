/**
 * Shared primitives for the TTS ledger's schemas.
 *
 * Declared once so a constraint cannot drift between two records that are meant to agree — a
 * digest that is lowercase-only in one place and case-insensitive in another silently stops
 * matching, and digests are identity throughout this system (contract §8.1).
 */

import { createHash } from "node:crypto";

import { z } from "zod";

/** `MAJOR.MINOR`, matching Core's schema-version policy (ADR-0003). */
export const schemaVersionPattern = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)$/);

/** A SHA-256 digest, lowercase hexadecimal. Mixed case would break equality comparison. */
export const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

/** ISO-8601 with a UTC offset. A local timestamp is ambiguous across machines. */
export const iso8601 = z.iso.datetime({ offset: true });

/** A non-empty identifier or short label. */
export const nonEmptyString = z.string().min(1).max(400);

/**
 * Caller-supplied scope dimensions (contract §15.2, §9.2).
 *
 * A string map, never an enumeration. §15.2 lists show, host, provider, voice, model, language,
 * and script form as scope dimensions, but §4.2 forbids Core and its packages from naming a
 * provider, voice, or model — and WP-09 already settled that scope dimensions stay caller-supplied
 * so an adopter can add one without forking the runtime.
 */
export const scopeDimensions = z.record(z.string().min(1).max(100), z.string().min(1).max(200));

/** @see scopeDimensions */
export type ScopeDimensions = Record<string, string>;

/**
 * Digest a JSON value with stable key ordering.
 *
 * Two structurally identical values must produce one digest regardless of how their keys were
 * ordered when they were built, or a hash-bound approval (§13.2) would spuriously drift the first
 * time a caller constructed the same object differently.
 */
export function digestJson(value: unknown): string {
  return createHash("sha256").update(canonicalise(value)).digest("hex");
}

/** Digest raw text, for spoken text and authored sources. */
export function digestText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Canonical JSON: object keys sorted at every depth, array order preserved. */
function canonicalise(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) {
    // Array order is meaningful — segments are a delivery sequence — so it is never sorted.
    return `[${value.map((entry) => canonicalise(entry)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalise(entry)}`).join(",")}}`;
}
